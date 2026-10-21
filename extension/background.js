/*
 * English Notebook · background (MV3 service worker)
 * 职责：原生右键菜单、翻译、状态存储、与本地 sync-server 双向同步、消息路由。
 */
importScripts('core.js', 'filestore.js');

const C = self.ENB;
if (!C) throw new Error('core.js 加载失败');
const FS = self.ENB.FileStore || null;

const DEFAULT_SETTINGS = {
  translation: {
    provider: 'mymemory', // mymemory | google | openai | custom | none
    targetLang: 'zh-CN',
    custom: { url: '', method: 'GET', headers: '', bodyTemplate: '', resultPath: 'translation' },
  },
  sync: {
    endpoint: 'http://127.0.0.1:17890',
    autoSync: true,
    httpEnabled: false, // 默认使用 File System Access 直读写文件，旧 HTTP 同步服务仅作可选
  },
  /*
   * 翻译（OpenAI 兼容 / DeepSeek）与 AI 审查共用的 LLM 配置。
   * 只存在 chrome.storage.local，不参与 git 同步。
   */
  llm: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
  },
};

let stateCache = null;
let settingsCache = null;
let studyReviews = {};
let studyItems = [];
let syncCache = { serverUp: false, configured: false, dataFile: '', git: null, checkedAt: 0 };
let lastRevision = '';
let pushTimer = null;
let initPromise = null;
/* File System Access：直接读写用户选择的 JSON 文件 */
let fileHandle = null;
let fileStatus = {
  configured: false,
  name: '',
  permission: 'none',
  lastModified: 0,
  size: 0,
  error: null,
};
let fileInitDone = false;
let fileWriteTimer = null;
/* 是否已经自动弹过「同步设置」引导；存 chrome.storage 里，全浏览器只弹一次 */
let setupPrompted = false;
/* 从旧版本升级上来时，直接把引导标记为已提示，避免老用户重载后又弹一次 */
let forceSetupPrompted = false;

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
    const data = await storageGet(['state', 'settings', 'setupPrompted', 'studyReviews', 'studyItems']);
    stateCache = C.normalizeState(data.state);
    const rawSettings = data.settings || {};
    settingsCache = deepDefaults(rawSettings, DEFAULT_SETTINGS);
    /* 兼容旧版：把独立的 ai 配置或 translation.openai 迁移到共用 llm */
    if (!rawSettings.llm) {
      const legacy = rawSettings.ai || (rawSettings.translation && rawSettings.translation.openai);
      if (legacy) settingsCache.llm = deepDefaults(legacy, DEFAULT_SETTINGS.llm);
    }
    delete settingsCache.ai;
    if (settingsCache.translation) delete settingsCache.translation.openai;
    setupPrompted = !!data.setupPrompted || forceSetupPrompted;
    studyReviews = data.studyReviews && typeof data.studyReviews === 'object' ? data.studyReviews : {};
    studyItems = Array.isArray(data.studyItems) ? data.studyItems : [];
    await storageSet({
      state: stateCache,
      settings: settingsCache,
      setupPrompted: setupPrompted,
      studyReviews: studyReviews,
      studyItems: studyItems,
    });
  })().then(function () { initPromise = null; });
  return initPromise;
}

async function persistState() {
  await storageSet({ state: stateCache });
  scheduleFileWrite();
}

async function persistSettings() {
  await storageSet({ settings: settingsCache });
}

/* ---------------- 本地文件直读写（File System Access） ---------------- */

function setFileStatus(patch) {
  fileStatus = Object.assign({}, fileStatus, patch || {});
}

async function ensureFileReady() {
  if (fileInitDone) return;
  fileInitDone = true;
  if (!FS) {
    setFileStatus({ configured: false, permission: 'unsupported', error: '当前浏览器不支持 File System Access，请使用 Edge/Chrome' });
    return;
  }
  try {
    fileHandle = await FS.getHandle();
    if (!fileHandle) {
      setFileStatus({ configured: false, name: '', permission: 'none', error: null });
      return;
    }
    const meta = await FS.fileMeta(fileHandle);
    const permission = await FS.permission(fileHandle);
    setFileStatus({
      configured: true,
      name: (meta && meta.name) || fileHandle.name || 'data.json',
      size: (meta && meta.size) || 0,
      lastModified: (meta && meta.lastModified) || 0,
      permission: permission,
      error: null,
    });
    if (permission === 'granted') await readAndMergeFile();
  } catch (e) {
    setFileStatus({ configured: true, permission: 'error', error: String((e && e.message) || e) });
  }
}

function contentSig(state) {
  return JSON.stringify({ groups: state.groups || [], items: state.items || [] });
}

/** 读取文件并合并进本地状态；若本地有更新内容则写回文件。 */
async function readAndMergeFile() {
  if (!fileHandle || !FS) return { changed: false, status: fileStatus };
  try {
    const text = await FS.readFile(fileHandle);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* 空文件或非法 JSON */ }
    if (!parsed || typeof parsed !== 'object') {
      if (!String(text || '').trim()) {
        /* 新建的空文件：把当前状态写进去 */
        const ok = await writeFileNow();
        return { changed: false, initialized: ok, status: fileStatus };
      }
      setFileStatus({ error: '文件不是合法的 JSON，未覆盖它；请选择其他文件或先修复内容' });
      return { changed: false, status: fileStatus };
    }
    const fileState = C.normalizeState(parsed);
    const merged = C.mergeImport(stateCache, fileState, 'merge');
    const st = merged.stats;
    const changed = !!(st.itemsAdded || st.itemsUpdated || st.groupsAdded || st.groupsUpdated);
    if (changed) {
      stateCache = merged.state;
      await storageSet({ state: stateCache });
      notifyTabs({ type: 'STATE_UPDATED' });
    }
    if (contentSig(C.normalizeState(stateCache)) !== contentSig(fileState)) {
      await writeFileNow();
    } else {
      const meta = await FS.fileMeta(fileHandle);
      if (meta) {
        setFileStatus({ name: meta.name, size: meta.size, lastModified: meta.lastModified, error: null });
      }
    }
    return { changed: changed, status: fileStatus };
  } catch (e) {
    setFileStatus({ permission: 'error', error: String((e && e.message) || e) });
    return { changed: false, error: fileStatus.error, status: fileStatus };
  }
}

function scheduleFileWrite(delay) {
  if (!fileHandle || !FS) return;
  clearTimeout(fileWriteTimer);
  fileWriteTimer = setTimeout(function () {
    fileWriteTimer = null;
    writeFileNow().catch(function () { /* ignore */ });
  }, typeof delay === 'number' ? delay : 600);
}

async function writeFileNow() {
  if (!fileHandle || !FS) return false;
  const permission = await FS.permission(fileHandle);
  setFileStatus({ permission: permission });
  if (permission !== 'granted') {
    setFileStatus({ error: '需要重新授权数据文件（设置页点“重新授权”）' });
    return false;
  }
  const content = JSON.stringify(C.exportState(stateCache), null, 2) + '\n';
  await FS.writeFile(fileHandle, content);
  const meta = await FS.fileMeta(fileHandle);
  if (meta) setFileStatus({ name: meta.name, size: meta.size, lastModified: meta.lastModified, error: null });
  return true;
}

async function fileTick() {
  await ensureFileReady();
  if (!fileHandle || fileStatus.permission !== 'granted') return { changed: false, status: fileStatus };
  const meta = await FS.fileMeta(fileHandle);
  if (!meta) return { changed: false, status: fileStatus };
  if (meta.lastModified && meta.lastModified !== fileStatus.lastModified) {
    return readAndMergeFile();
  }
  return { changed: false, status: fileStatus };
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
  await ensureFileReady();
  if (settingsCache.sync && settingsCache.sync.httpEnabled && !syncCache.checkedAt) {
    try { await checkHealth(); } catch (e) { /* ignore */ }
  }
}

chrome.runtime.onInstalled.addListener(function (details) {
  if (details && details.reason === 'update') forceSetupPrompted = true;
  ensureReady().then(syncOnStart);
});

chrome.runtime.onStartup.addListener(function () {
  ensureReady().then(syncOnStart);
});

/* Service Worker 每次启动都重建右键菜单：避免安装时注册失败后菜单永久缺失 */
createMenus();

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

async function translateMyMemoryChunk(chunk, targetLang) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(chunk) +
    '&langpair=en|' + encodeURIComponent(targetLang);
  const r = await fetchJson(url, {}, 8000);
  const t = r.data && r.data.responseData && r.data.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID|PLEASE SELECT/i.test(t)) return null;
  return String(t).trim();
}

async function translateText(text) {
  const cfg = settingsCache.translation;
  const targetLang = cfg.targetLang || 'zh-CN';
  const provider = cfg.provider || 'mymemory';
  if (provider === 'none') return { ok: false, error: '已在设置中关闭自动翻译' };

  try {
    if (provider === 'mymemory') {
      /* MyMemory 单次查询上限 500 字符，长文本先按句切块再逐块翻译 */
      const chunks = C.splitForTranslation(text, 450);
      if (!chunks.length) return { ok: false, error: '没有可翻译的内容' };
      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        const part = await translateMyMemoryChunk(chunks[i], targetLang);
        if (!part) {
          return { ok: false, error: '免费翻译接口返回异常（长文本已自动分段；可稍后重试或改用 OpenAI/自定义接口）' };
        }
        parts.push(part);
      }
      return { ok: true, text: parts.join(' '), provider: provider, chunks: chunks.length };
    }

    if (provider === 'google') {
      const chunks = C.splitForTranslation(text, 1800);
      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
          encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(chunks[i]);
        const r = await fetchJson(url, {}, 8000);
        const arr = r.data && r.data[0];
        if (!arr) return { ok: false, error: 'Google 翻译接口无结果（可能网络不可用）' };
        const t = arr.map(function (x) { return (x && x[0]) || ''; }).join('');
        if (!t) return { ok: false, error: 'Google 翻译没有返回译文' };
        parts.push(t);
      }
      return { ok: true, text: parts.join(' '), provider: provider, chunks: chunks.length };
    }

    if (provider === 'openai') {
      /* 与 AI 审查共用同一份 LLM 配置（DeepSeek 也走这里） */
      const o = settingsCache.llm || {};
      const base = String(o.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
      if (!o.apiKey) return { ok: false, error: '未填写共用 LLM 配置的 API Key（设置页 → OpenAI 兼容 / DeepSeek）' };
      const r = await fetchJson(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + o.apiKey },
        body: JSON.stringify({
          model: o.model || 'deepseek-chat',
          temperature: 0,
          messages: [
            { role: 'system', content: '你是翻译引擎。把用户给出的英文翻译成简体中文，只输出译文，不要解释，不要加引号。' },
            { role: 'user', content: text },
          ],
        }),
      }, 20000);
      const t = r.data && r.data.choices && r.data.choices[0] &&
        r.data.choices[0].message && r.data.choices[0].message.content;
      if (!t) return { ok: false, error: 'OpenAI 兼容 / DeepSeek 接口没有返回译文（检查 baseUrl/key/model）' };
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

/* ---------------- DeepSeek AI 审查（学习条目仅本地存储，不参与同步） ---------------- */

async function persistStudy() {
  await storageSet({ studyReviews: studyReviews || {}, studyItems: studyItems || [] });
}

async function callDeepSeek(messages) {
  const llm = settingsCache.llm || {};
  if (!llm.apiKey) return { ok: false, error: '请先在设置页填写共用 LLM 配置的 API Key（OpenAI 兼容 / DeepSeek）' };
  const base = String(llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const r = await fetchJson(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
    body: JSON.stringify({
      model: llm.model || 'deepseek-chat',
      temperature: 0.2,
      messages: messages,
      response_format: { type: 'json_object' },
    }),
  }, 45000);
  if (r.status !== 200) {
    let msg = 'HTTP ' + r.status;
    if (r.data && r.data.error) {
      msg = typeof r.data.error === 'string' ? r.data.error : (r.data.error.message || JSON.stringify(r.data.error));
    }
    return { ok: false, error: 'AI 接口错误：' + msg };
  }
  const content = r.data && r.data.choices && r.data.choices[0] &&
    r.data.choices[0].message && r.data.choices[0].message.content;
  if (!content) return { ok: false, error: 'AI 接口没有返回内容' };
  return { ok: true, text: String(content).trim() };
}

async function reviewTranslation(payload) {
  const text = C.cleanText(payload.text, 4000);
  const userTranslation = C.cleanText(payload.userTranslation, 2000);
  if (!text) return { ok: false, error: '原文为空' };
  if (!userTranslation) return { ok: false, error: '请先写下你的翻译' };
  if (!settingsCache.llm || !settingsCache.llm.apiKey) {
    return { ok: false, error: '请先在设置页填写共用 LLM 配置的 API Key（OpenAI 兼容 / DeepSeek）' };
  }

  const messages = [
    {
      role: 'system',
      content: '你是一名严谨的英语老师，帮助中文母语学习者复盘翻译。只输出一个 JSON 对象，不要输出 Markdown 代码块或额外解释。',
    },
    {
      role: 'user',
      content: [
        '英文原文：' + text,
        '学习者的中文翻译：' + userTranslation,
        '',
        '请完成三件事：',
        '1. 判断翻译质量（verdict 只能是：准确 / 基本准确 / 不准确）；',
        '2. 用中文给出简短点评（feedback），指出误译或更自然的表达；',
        '3. 从原文中提取学习者可能不熟悉的单词、词组、固定用法（items，3-8 条；必须是原文里出现过的表达）。',
        '',
        '严格按这个 JSON 格式输出：',
        '{"verdict":"基本准确","feedback":"中文点评","items":[{"type":"word|phrase|usage","text":"英文表达","meaning":"中文释义","note":"简短用法提示"}]}',
        'type 只能是 word（单词）、phrase（词组）、usage（固定用法）之一。',
      ].join('\n'),
    },
  ];

  const result = await callDeepSeek(messages);
  if (!result.ok) return result;
  const parsed = C.parseAIReview(result.text);
  if (!parsed) return { ok: false, error: 'AI 返回的 JSON 无法解析，请重试' };

  const review = {
    itemId: String(payload.itemId || ''),
    pageUrl: C.normalizePageUrl(payload.pageUrl || ''),
    original: text,
    userTranslation: userTranslation,
    verdict: parsed.verdict,
    feedback: parsed.feedback,
    createdAt: C.nowIso(),
  };
  studyReviews[review.itemId] = review;

  const newItems = parsed.items.map(function (it) {
    return {
      id: C.newId('s'),
      type: it.type,
      text: it.text,
      meaning: it.meaning,
      note: it.note,
      sourceItemId: review.itemId,
      pageUrl: review.pageUrl,
      createdAt: C.nowIso(),
      reviewedCount: 0,
      lastReviewedAt: null,
    };
  });
  studyItems = (studyItems || []).filter(function (it) { return it.sourceItemId !== review.itemId; }).concat(newItems);
  await persistStudy();
  notifyTabs({ type: 'STUDY_UPDATED' });
  return { ok: true, review: review, items: newItems, reviews: studyReviews };
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
  if (!settingsCache || !settingsCache.sync.autoSync || !settingsCache.sync.httpEnabled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function () {
    pushState().catch(function () { /* ignore */ });
  }, 500);
}

async function syncTick() {
  if (!settingsCache.sync.autoSync || !settingsCache.sync.httpEnabled) return false;
  const changed = await pullState();
  return changed;
}

async function syncOnStart() {
  if (!settingsCache.sync || !settingsCache.sync.httpEnabled) return;
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
    return {
      ok: true,
      items: items,
      sync: syncCache,
      file: fileStatus,
      promptSetup: !setupPrompted && !fileStatus.configured,
    };
  }

  if (type === 'GET_FILE_STATUS') {
    await ensureFileReady();
    return { ok: true, file: fileStatus };
  }

  if (type === 'FILE_SELECTED') {
    fileInitDone = false;
    fileHandle = null;
    await ensureFileReady();
    return { ok: true, file: fileStatus };
  }

  if (type === 'CLEAR_FILE') {
    fileHandle = null;
    fileInitDone = true;
    setFileStatus({ configured: false, name: '', permission: 'none', size: 0, lastModified: 0, error: null });
    if (FS) { try { await FS.clearHandle(); } catch (e) { /* ignore */ } }
    return { ok: true, file: fileStatus };
  }

  if (type === 'FILE_TICK') {
    const result = await fileTick();
    return { ok: true, changed: result.changed, file: result.status || fileStatus };
  }

  if (type === 'MARK_SETUP_PROMPTED') {
    setupPrompted = true;
    await storageSet({ setupPrompted: true });
    return { ok: true };
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
    const result = await setSyncPath(message.dataFile);
    if (result && result.ok) {
      setupPrompted = true;
      /* 显式配置旧 HTTP 同步服务时才启用它；默认走文件直读写 */
      settingsCache.sync.httpEnabled = true;
      await persistSettings();
      await storageSet({ setupPrompted: true });
    }
    return result;
  }

  if (type === 'GET_STATE_SUMMARY') {
    return { ok: true, state: stateCache, settings: settingsCache, sync: syncCache, file: fileStatus };
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

  if (type === 'GET_STUDY_DATA') {
    return { ok: true, reviews: studyReviews || {}, items: studyItems || [] };
  }

  if (type === 'REVIEW_TRANSLATION') {
    return reviewTranslation(message);
  }

  if (type === 'MARK_STUDY_REVIEWED') {
    const ids = Array.isArray(message.ids) ? message.ids : [];
    const set = new Set(ids);
    (studyItems || []).forEach(function (it) {
      if (set.has(it.id)) {
        it.reviewedCount = (it.reviewedCount || 0) + 1;
        it.lastReviewedAt = C.nowIso();
      }
    });
    await persistStudy();
    return { ok: true, items: studyItems };
  }

  if (type === 'TEST_AI') {
    const r = await callDeepSeek([{ role: 'user', content: '只回复两个字：正常' }]);
    return r.ok ? { ok: true, text: r.text } : r;
  }

  if (type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return { ok: true };
  }

  if (type === 'TRANSLATE_SELECTION') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab) return { ok: false, error: '找不到当前标签页' };
    await captureAndRecord(tab, true, '');
    return { ok: true };
  }

  if (type === 'RELOAD_EXTENSION') {
    chrome.runtime.reload();
    return { ok: true };
  }

  if (type === 'SHOW_TOAST' || type === 'REQUEST_CAPTURE' || type === 'STATE_UPDATED' || type === 'ANNOTATION_ADDED') {
    return { ok: true };
  }

  return { ok: false, error: 'unknown_type: ' + type };
}
