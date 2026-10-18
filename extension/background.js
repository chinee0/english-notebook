/*
 * English Notebook · background (MV3 service worker)
 * 职责：原生右键菜单、翻译、状态存储、与本地 sync-server 双向同步、消息路由。
 */
importScripts('core.js');

const C = self.ENB;
if (!C) throw new Error('core.js 加载失败');

const DEFAULT_SETTINGS = {
  translation: {
    provider: 'mymemory', // mymemory | google | openai | custom | none
    targetLang: 'zh-CN',
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    custom: { url: '', method: 'GET', headers: '', bodyTemplate: '', resultPath: 'translation' },
  },
  sync: {
    endpoint: 'http://127.0.0.1:17890',
    autoSync: true,
  },
};

let stateCache = null;
let settingsCache = null;
let syncCache = { serverUp: false, configured: false, dataFile: '', git: null, checkedAt: 0 };
let lastRevision = '';
let pushTimer = null;
let initPromise = null;

/* ---------------- 基础工具 ---------------- */

function storageGet(keys) {
  return new Promise(function (resolve) { chrome.storage.local.get(keys, resolve); });
}

function storageSet(obj) {
  return new Promise(function (resolve) { chrome.storage.local.set(obj, resolve); });
}

function deepDefaults(target, defaults) {
  const out = Object.assign({}, defaults, target || {});
  Object.keys(defaults).forEach(function (k) {
    if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
      out[k] = Object.assign({}, defaults[k], (target || {})[k] || {});
    }
  });
  return out;
}

async function ensureInit() {
  if (stateCache && settingsCache) return;
  if (initPromise) return initPromise;
  initPromise = (async function () {
    const data = await storageGet(['state', 'settings']);
    stateCache = C.normalizeState(data.state);
    settingsCache = deepDefaults(data.settings, DEFAULT_SETTINGS);
    await storageSet({ state: stateCache, settings: settingsCache });
  })().then(function () { initPromise = null; });
  return initPromise;
}

async function persistState() {
  await storageSet({ state: stateCache });
}

async function persistSettings() {
  await storageSet({ settings: settingsCache });
}

function notifyTabs(message) {
  chrome.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (tab) {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, message, function () { void chrome.runtime.lastError; });
    });
  });
}

function notifyTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message, function () { void chrome.runtime.lastError; });
}

function toastTab(tabId, message) {
  notifyTab(tabId, { type: 'SHOW_TOAST', message: message });
}

/* ---------------- 初始化 ---------------- */

async function ensureReady() {
  await ensureInit();
  if (!syncCache.checkedAt) {
    try { await checkHealth(); } catch (e) { /* ignore */ }
  }
}

chrome.runtime.onInstalled.addListener(function () {
  createMenus();
  ensureReady().then(syncOnStart);
});

chrome.runtime.onStartup.addListener(function () {
  createMenus();
  ensureReady().then(syncOnStart);
});

function createMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'enb_translate_record',
      title: '翻译并记录（English Notebook）',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'enb_record_only',
      title: '仅记录（不翻译）',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'enb_toggle_panel',
      title: '显示 / 隐藏批注栏',
      contexts: ['page', 'action'],
    });
    chrome.contextMenus.create({
      id: 'enb_open_options',
      title: 'English Notebook 设置与批注管理',
      contexts: ['page', 'action'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab) return;
  if (info.menuItemId === 'enb_translate_record') {
    captureAndRecord(tab, true, info.selectionText);
  } else if (info.menuItemId === 'enb_record_only') {
    captureAndRecord(tab, false, info.selectionText);
  } else if (info.menuItemId === 'enb_toggle_panel') {
    if (tab.id) notifyTab(tab.id, { type: 'TOGGLE_PANEL' });
  } else if (info.menuItemId === 'enb_open_options') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'translate-selection') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      if (tab) captureAndRecord(tab, true, '');
    });
  } else if (command === 'toggle-panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      if (tab && tab.id) notifyTab(tab.id, { type: 'TOGGLE_PANEL' });
    });
  } else if (command === 'open-manager') {
    chrome.runtime.openOptionsPage();
  }
});

/* ---------------- 右键记录流程 ---------------- */

async function captureAndRecord(tab, translate, fallbackText) {
  await ensureReady();
  let capture = null;
  try {
    capture = await chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_CAPTURE' });
  } catch (e) { /* 页面没有内容脚本 */ }

  if (!capture || !capture.text) {
    const text = C.cleanText(fallbackText || '');
    if (!text) { toastTab(tab.id, '请先选中要记录的英文内容'); return; }
    capture = {
      text: text,
      pageUrl: tab.url || '',
      pageTitle: tab.title || '',
      parentId: null,
      occurrence: 0,
      prefix: '',
      suffix: '',
    };
  }
  if (!capture.pageUrl) capture.pageUrl = tab.url || '';
  if (!capture.pageUrl) { toastTab(tab.id, '无法识别当前页面地址'); return; }

  let translation = '';
  if (translate) {
    const result = await translateText(capture.text);
    if (result.ok) {
      translation = result.text;
    } else {
      toastTab(tab.id, '翻译失败，已先记录原文：' + result.error);
    }
  }

  const item = await addAnnotation(capture, translation);
  if (!item) { toastTab(tab.id, '记录失败'); return; }

  notifyTab(tab.id, { type: 'ANNOTATION_ADDED', itemId: item.id });
  notifyTabs({ type: 'STATE_UPDATED' });
  syncSoon();
}

function autoGroupId(pageUrl) {
  const host = C.hostOfPage(pageUrl);
  if (!host) return null;
  const groups = C.groupsForHost(stateCache, host);
  return groups.length ? groups[0].id : null;
}

async function addAnnotation(capture, translation) {
  const item = C.addItem(stateCache, {
    text: capture.text,
    translation: translation || '',
    pageUrl: capture.pageUrl,
    pageTitle: capture.pageTitle || '',
    groupId: autoGroupId(capture.pageUrl),
    parentId: capture.parentId || null,
    anchor: {
      text: capture.text,
      occurrence: capture.occurrence || 0,
      prefix: capture.prefix || '',
      suffix: capture.suffix || '',
    },
  });
  if (!item) return null;
  await persistState();
  return item;
}

/* ---------------- 翻译 Provider ---------------- */

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
  try {
    const res = await fetch(url, Object.assign({ signal: controller.signal, cache: 'no-store' }, options || {}));
    const data = await res.json().catch(function () { return null; });
    return { status: res.status, data: data };
  } finally {
    clearTimeout(timer);
  }
}

async function translateText(text) {
  const cfg = settingsCache.translation;
  const targetLang = cfg.targetLang || 'zh-CN';
  const provider = cfg.provider || 'mymemory';
  if (provider === 'none') return { ok: false, error: '已在设置中关闭自动翻译' };

  try {
    if (provider === 'mymemory') {
      const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
        '&langpair=en|' + encodeURIComponent(targetLang);
      const r = await fetchJson(url, {}, 8000);
      const t = r.data && r.data.responseData && r.data.responseData.translatedText;
      if (!t || /MYMEMORY WARNING/i.test(t)) return { ok: false, error: '免费翻译接口返回异常（可稍后重试或换 provider）' };
      return { ok: true, text: String(t).trim(), provider: provider };
    }

    if (provider === 'google') {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
        encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(text);
      const r = await fetchJson(url, {}, 8000);
      const arr = r.data && r.data[0];
      if (!arr) return { ok: false, error: 'Google 翻译接口无结果（可能网络不可用）' };
      const t = arr.map(function (x) { return (x && x[0]) || ''; }).join('');
      if (!t) return { ok: false, error: 'Google 翻译没有返回译文' };
      return { ok: true, text: t, provider: provider };
    }

    if (provider === 'openai') {
      const o = cfg.openai || {};
      const base = String(o.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      if (!o.apiKey) return { ok: false, error: '未填写 OpenAI 兼容 API Key' };
      const r = await fetchJson(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + o.apiKey },
        body: JSON.stringify({
          model: o.model || 'gpt-4o-mini',
          temperature: 0,
          messages: [
            { role: 'system', content: '你是翻译引擎。把用户给出的英文翻译成简体中文，只输出译文，不要解释，不要加引号。' },
            { role: 'user', content: text },
          ],
        }),
      }, 20000);
      const t = r.data && r.data.choices && r.data.choices[0] &&
        r.data.choices[0].message && r.data.choices[0].message.content;
      if (!t) return { ok: false, error: 'OpenAI 兼容接口没有返回译文（检查 baseUrl/key/model）' };
      return { ok: true, text: String(t).trim(), provider: provider };
    }

    if (provider === 'custom') {
      const c = cfg.custom || {};
      if (!c.url) return { ok: false, error: '未填写自定义翻译接口地址' };
      const method = String(c.method || 'GET').toUpperCase();
      const headers = { 'Content-Type': 'application/json' };
      try { Object.assign(headers, c.headers ? JSON.parse(c.headers) : {}); } catch (e) { /* ignore */ }
      let url = c.url;
      let body = null;
      if (method === 'GET') {
        url = url.replace(/\{\{text\}\}/g, encodeURIComponent(text)).replace(/\{\{lang\}\}/g, encodeURIComponent(targetLang));
      } else {
        const template = c.bodyTemplate || '{"text":"{{text}}","target":"{{lang}}"}';
        body = template.replace(/\{\{text\}\}/g, JSON.stringify(text).slice(1, -1)).replace(/\{\{lang\}\}/g, targetLang);
      }
      const r = await fetchJson(url, { method: method, headers: headers, body: body }, 15000);
      let value = r.data;
      String(c.resultPath || '').split('.').filter(Boolean).forEach(function (key) {
        value = value === null || value === undefined ? undefined : value[key];
      });
      const t = typeof value === 'string' ? value : (r.data && r.data.translation);
      if (!t) return { ok: false, error: '自定义接口没有解析到译文（检查 resultPath）' };
      return { ok: true, text: String(t).trim(), provider: provider };
    }
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '翻译请求超时' : String((e && e.message) || e);
    return { ok: false, error: msg };
  }
  return { ok: false, error: '未知翻译 provider: ' + provider };
}

/* ---------------- 同步 ---------------- */

function endpoint() {
  return String(settingsCache.sync.endpoint || 'http://127.0.0.1:17890').replace(/\/+$/, '');
}

async function checkHealth() {
  try {
    const r = await fetchJson(endpoint() + '/health', {}, 2500);
    if (r.data && r.data.ok) {
      syncCache = {
        serverUp: true,
        configured: !!r.data.configured,
        dataFile: r.data.dataFile || '',
        git: r.data.git || null,
        checkedAt: Date.now(),
      };
      return true;
    }
  } catch (e) { /* ignore */ }
  syncCache = { serverUp: false, configured: false, dataFile: '', git: null, checkedAt: Date.now() };
  return false;
}

async function pullState() {
  if (!(await checkHealth())) return false;
  if (!syncCache.configured) return false;
  const r = await fetchJson(endpoint() + '/state', {}, 5000);
  if (r.status !== 200 || !r.data || !r.data.ok) return false;
  if (r.data.revision === lastRevision) return false;
  const remote = C.normalizeState(r.data.state);
  const merged = C.mergeImport(stateCache, remote, 'merge');
  stateCache = merged.state;
  lastRevision = r.data.revision;
  await persistState();
  notifyTabs({ type: 'STATE_UPDATED' });
  return true;
}

async function pushState() {
  if (!syncCache.configured) {
    if (!(await checkHealth()) || !syncCache.configured) return false;
  }
  const r = await fetchJson(endpoint() + '/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: C.exportState(stateCache) }),
  }, 8000);
  if (r.status !== 200 || !r.data || !r.data.ok) return false;
  lastRevision = r.data.revision;
  const merged = C.mergeImport(stateCache, r.data.state, 'merge');
  const st = merged.stats;
  if (st.itemsAdded || st.itemsUpdated || st.groupsAdded || st.groupsUpdated) {
    stateCache = merged.state;
    await persistState();
    notifyTabs({ type: 'STATE_UPDATED' });
  }
  return true;
}

function syncSoon() {
  if (!settingsCache || !settingsCache.sync.autoSync) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function () {
    pushState().catch(function () { /* ignore */ });
  }, 500);
}

async function syncTick() {
  if (!settingsCache.sync.autoSync) return false;
  const changed = await pullState();
  return changed;
}

async function syncOnStart() {
  try {
    await checkHealth();
    if (syncCache.configured) await pullState();
  } catch (e) { /* ignore */ }
}

async function setSyncPath(dataFile) {
  const trimmed = String(dataFile || '').trim();
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed)) {
    return { ok: false, error: '请填写 Windows 绝对路径，例如 D:\\notes\\english-notes.json 或 \\\\server\\share\\notes.json' };
  }
  try {
    const r = await fetchJson(endpoint() + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataFile: trimmed }),
    }, 6000);
    if (!r.data || !r.data.ok) {
      return { ok: false, error: (r.data && (r.data.message || r.data.error)) || '同步服务拒绝了该路径' };
    }
    syncCache = {
      serverUp: true,
      configured: true,
      dataFile: r.data.dataFile || trimmed,
      git: r.data.git || null,
      checkedAt: Date.now(),
    };
    await pullState();
    return { ok: true, dataFile: syncCache.dataFile, git: syncCache.git, sync: syncCache };
  } catch (e) {
    return { ok: false, error: '连不上同步服务，请先双击 sync-server\\start-sync.bat，再重试' };
  }
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  handleMessage(message, sender)
    .then(function (result) { sendResponse(result); })
    .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
  return true;
});

async function handleMessage(message, sender) {
  await ensureReady();
  const type = message && message.type;

  if (type === 'GET_PAGE_STATE') {
    const items = C.itemsForPage(stateCache, message.url || (sender.tab && sender.tab.url) || '');
    return { ok: true, items: items, sync: syncCache };
  }

  if (type === 'UPDATE_ITEM') {
    const item = C.updateItem(stateCache, message.id, message.patch || {});
    if (!item) return { ok: false, error: 'not_found' };
    await persistState();
    notifyTabs({ type: 'STATE_UPDATED' });
    syncSoon();
    return { ok: true, item: item };
  }

  if (type === 'DELETE_ITEM') {
    const removed = C.deleteItem(stateCache, message.id);
    if (!removed) return { ok: false, error: 'not_found' };
    await persistState();
    notifyTabs({ type: 'STATE_UPDATED' });
    syncSoon();
    return { ok: true, removed: removed };
  }

  if (type === 'SYNC_TICK') {
    const changed = await syncTick();
    return { ok: true, changed: changed, sync: syncCache };
  }

  if (type === 'SET_SYNC_PATH') {
    return setSyncPath(message.dataFile);
  }

  if (type === 'GET_STATE_SUMMARY') {
    return { ok: true, state: stateCache, settings: settingsCache, sync: syncCache };
  }

  if (type === 'SAVE_SETTINGS') {
    settingsCache = deepDefaults(Object.assign({}, settingsCache, message.settings || {}), DEFAULT_SETTINGS);
    await persistSettings();
    return { ok: true, settings: settingsCache };
  }

  if (type === 'ADD_GROUP') {
    const group = C.addGroup(stateCache, message.name, message.hosts);
    await persistState();
    notifyTabs({ type: 'STATE_UPDATED' });
    syncSoon();
    return { ok: true, group: group };
  }

  if (type === 'UPDATE_GROUP') {
    const group = C.updateGroup(stateCache, message.id, message.patch || {});
    if (!group) return { ok: false, error: 'not_found' };
    await persistState();
    notifyTabs({ type: 'STATE_UPDATED' });
    syncSoon();
    return { ok: true, group: group };
  }

  if (type === 'DELETE_GROUP') {
    C.deleteGroup(stateCache, message.id);
    await persistState();
    notifyTabs({ type: 'STATE_UPDATED' });
    syncSoon();
    return { ok: true };
  }

  if (type === 'IMPORT_STATE') {
    const res = C.mergeImport(stateCache, message.state, message.mode === 'replace' ? 'replace' : 'merge');
    stateCache = res.state;
    await persistState();
    notifyTabs({ type: 'STATE_UPDATED' });
    syncSoon();
    return { ok: true, stats: res.stats };
  }

  if (type === 'SYNC_NOW') {
    await checkHealth();
    const changed = syncCache.configured ? await pullState() : false;
    if (syncCache.configured) await pushState();
    return { ok: true, changed: changed, sync: syncCache };
  }

  if (type === 'TEST_TRANSLATION') {
    return translateText(message.text || 'The committee has yet to reach a decision.');
  }

  if (type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return { ok: true };
  }

  if (type === 'SHOW_TOAST' || type === 'REQUEST_CAPTURE' || type === 'STATE_UPDATED' || type === 'ANNOTATION_ADDED') {
    return { ok: true };
  }

  return { ok: false, error: 'unknown_type: ' + type };
}
