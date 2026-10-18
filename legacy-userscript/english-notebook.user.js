// ==UserScript==
// @name         English Notebook · 英语句子与词组笔记
// @namespace    https://github.com/your-name/english-notebook
// @version      0.1.0
// @description  在任意网页选中英文句子/词组，按 Alt+S 记录；按网站分组管理、搜索、朗读、导出导入。全站静默，只靠快捷键和油猴菜单唤出。
// @author       you
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * English Notebook · core
 * 纯数据逻辑，不依赖 DOM，方便在 Node 里做单元测试。
 * UMD: Node 下 require() 得到模块对象；浏览器/油猴下挂到全局 ENB。
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.ENB = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;

  function nowIso() {
    return new Date().toISOString();
  }

  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function touch(state) {
    state.updatedAt = nowIso();
  }

  /* ---------- 网址 ---------- */

  function normalizeHost(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // 去掉协议
    s = s.replace(/^\*\./, ''); // 去掉通配符
    s = s.split('/')[0].split('?')[0].split('#')[0]; // 去掉路径/参数
    s = s.replace(/:\d+$/, ''); // 去掉端口
    s = s.replace(/^www\./, ''); // 统一去掉 www.
    s = s.replace(/\.$/, '');
    // 域名合法性做宽松校验：正常域名要求带点，localhost / IP 等允许
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) && !/^[a-z0-9.-]+$/.test(s)) return '';
    return s;
  }

  function hostOf(url) {
    try {
      return normalizeHost(new URL(String(url)).hostname);
    } catch (e) {
      return '';
    }
  }

  function hostMatches(host, bound) {
    const h = normalizeHost(host);
    const b = normalizeHost(bound);
    if (!h || !b) return false;
    return h === b || h.slice(-(b.length + 1)) === '.' + b;
  }

  function groupMatchesHost(group, host) {
    if (!group || !Array.isArray(group.hosts)) return false;
    return group.hosts.some(function (b) {
      return hostMatches(host, b);
    });
  }

  function groupsForHost(state, host) {
    const h = normalizeHost(host);
    if (!h) return [];
    return state.groups.filter(function (g) {
      return groupMatchesHost(g, h);
    });
  }

  /* ---------- 数据规范化 ---------- */

  function normalizeState(raw) {
    const out = { version: VERSION, updatedAt: nowIso(), groups: [], items: [] };
    if (!raw || typeof raw !== 'object') return out;

    const groups = Array.isArray(raw.groups) ? raw.groups : [];
    const items = Array.isArray(raw.items) ? raw.items : [];

    groups.forEach(function (g) {
      if (!g || typeof g !== 'object') return;
      const hosts = Array.isArray(g.hosts) ? g.hosts : [];
      out.groups.push({
        id: String(g.id || newId('g')),
        name: String(g.name || '未命名分组').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名分组',
        hosts: Array.from(new Set(hosts.map(normalizeHost).filter(Boolean))),
        createdAt: g.createdAt || nowIso(),
        updatedAt: g.updatedAt || g.createdAt || nowIso(),
      });
    });

    const groupIds = new Set(out.groups.map(function (g) { return g.id; }));

    items.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      const text = String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (!text) return;
      out.items.push({
        id: String(it.id || newId('i')),
        groupId: it.groupId && groupIds.has(it.groupId) ? it.groupId : null,
        text: text,
        note: String(it.note || '').slice(0, 5000),
        sourceUrl: String(it.sourceUrl || '').slice(0, 4000),
        sourceTitle: String(it.sourceTitle || '').slice(0, 500),
        sourceHost: normalizeHost(it.sourceHost || hostOf(it.sourceUrl)),
        createdAt: it.createdAt || nowIso(),
        updatedAt: it.updatedAt || it.createdAt || nowIso(),
      });
    });

    if (raw.updatedAt) out.updatedAt = raw.updatedAt;
    return out;
  }

  /* ---------- 分组 ---------- */

  function groupExists(state, id) {
    return !!(id && state.groups.some(function (g) { return g.id === id; }));
  }

  function addGroup(state, name, hosts) {
    const cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名分组';
    const cleanHosts = Array.from(new Set((Array.isArray(hosts) ? hosts : []).map(normalizeHost).filter(Boolean)));
    const g = {
      id: newId('g'),
      name: cleanName,
      hosts: cleanHosts,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.groups.push(g);
    touch(state);
    return g;
  }

  function updateGroup(state, id, patch) {
    const g = state.groups.find(function (x) { return x.id === id; });
    if (!g) return null;
    patch = patch || {};
    if (patch.name !== undefined) {
      const n = String(patch.name).replace(/\s+/g, ' ').trim().slice(0, 80);
      if (n) g.name = n;
    }
    if (patch.hosts !== undefined) {
      const hs = Array.isArray(patch.hosts) ? patch.hosts : [];
      g.hosts = Array.from(new Set(hs.map(normalizeHost).filter(Boolean)));
    }
    g.updatedAt = nowIso();
    touch(state);
    return g;
  }

  function deleteGroup(state, id) {
    const idx = state.groups.findIndex(function (g) { return g.id === id; });
    if (idx === -1) return 0;
    state.groups.splice(idx, 1);
    let moved = 0;
    state.items.forEach(function (it) {
      if (it.groupId === id) {
        it.groupId = null;
        it.updatedAt = nowIso();
        moved++;
      }
    });
    touch(state);
    return moved;
  }

  /* ---------- 记录 ---------- */

  function addItem(state, data) {
    data = data || {};
    const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!text) return null;
    let groupId = data.groupId || null;
    if (groupId && !groupExists(state, groupId)) groupId = null;
    const item = {
      id: newId('i'),
      groupId: groupId,
      text: text,
      note: String(data.note || '').slice(0, 5000),
      sourceUrl: String(data.sourceUrl || '').slice(0, 4000),
      sourceTitle: String(data.sourceTitle || '').slice(0, 500),
      sourceHost: normalizeHost(data.sourceHost || hostOf(data.sourceUrl)),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.items.push(item);
    touch(state);
    return item;
  }

  function updateItem(state, id, patch) {
    const item = state.items.find(function (x) { return x.id === id; });
    if (!item) return null;
    patch = patch || {};
    if (patch.text !== undefined) {
      const t = String(patch.text).replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (t) item.text = t;
    }
    if (patch.note !== undefined) item.note = String(patch.note).slice(0, 5000);
    if (patch.groupId !== undefined) {
      item.groupId = patch.groupId && groupExists(state, patch.groupId) ? patch.groupId : null;
    }
    if (patch.sourceUrl !== undefined) item.sourceUrl = String(patch.sourceUrl).slice(0, 4000);
    if (patch.sourceTitle !== undefined) item.sourceTitle = String(patch.sourceTitle).slice(0, 500);
    item.updatedAt = nowIso();
    touch(state);
    return item;
  }

  function deleteItem(state, id) {
    const idx = state.items.findIndex(function (it) { return it.id === id; });
    if (idx === -1) return false;
    state.items.splice(idx, 1);
    touch(state);
    return true;
  }

  function countItems(state, groupId) {
    if (groupId === undefined) return state.items.length;
    return state.items.filter(function (it) { return it.groupId === groupId; }).length;
  }

  /* ---------- 导入 / 导出 ---------- */

  function exportState(state) {
    return {
      version: VERSION,
      exportedAt: nowIso(),
      groups: JSON.parse(JSON.stringify(state.groups)),
      items: JSON.parse(JSON.stringify(state.items)),
    };
  }

  function mergeImport(state, incoming, mode) {
    const inc = normalizeState(incoming);
    const stats = { groupsAdded: 0, groupsUpdated: 0, itemsAdded: 0, itemsUpdated: 0, itemsSkipped: 0 };

    if (mode === 'replace') {
      state.version = VERSION;
      state.groups = inc.groups;
      state.items = inc.items;
      stats.groupsAdded = inc.groups.length;
      stats.itemsAdded = inc.items.length;
      touch(state);
      return { state: state, stats: stats };
    }

    const groupById = new Map();
    state.groups.forEach(function (g) { groupById.set(g.id, g); });
    inc.groups.forEach(function (g) {
      const cur = groupById.get(g.id);
      if (!cur) {
        state.groups.push(g);
        groupById.set(g.id, g);
        stats.groupsAdded++;
      } else if (String(g.updatedAt || '') > String(cur.updatedAt || '')) {
        cur.name = g.name;
        cur.hosts = g.hosts;
        cur.updatedAt = g.updatedAt;
        stats.groupsUpdated++;
      }
    });

    const itemById = new Map();
    state.items.forEach(function (it) { itemById.set(it.id, it); });
    inc.items.forEach(function (it) {
      const cur = itemById.get(it.id);
      if (!cur) {
        state.items.push(it);
        itemById.set(it.id, it);
        stats.itemsAdded++;
      } else if (String(it.updatedAt || '') > String(cur.updatedAt || '')) {
        Object.assign(cur, it);
        stats.itemsUpdated++;
      } else {
        stats.itemsSkipped++;
      }
    });

    const ids = new Set(state.groups.map(function (g) { return g.id; }));
    state.items.forEach(function (it) {
      if (it.groupId && !ids.has(it.groupId)) it.groupId = null;
    });

    touch(state);
    return { state: state, stats: stats };
  }

  return {
    VERSION: VERSION,
    nowIso: nowIso,
    newId: newId,
    cloneState: cloneState,
    touch: touch,
    normalizeHost: normalizeHost,
    hostOf: hostOf,
    hostMatches: hostMatches,
    groupMatchesHost: groupMatchesHost,
    groupsForHost: groupsForHost,
    normalizeState: normalizeState,
    groupExists: groupExists,
    addGroup: addGroup,
    updateGroup: updateGroup,
    deleteGroup: deleteGroup,
    addItem: addItem,
    updateItem: updateItem,
    deleteItem: deleteItem,
    countItems: countItems,
    exportState: exportState,
    mergeImport: mergeImport,
  };
});

/*
 * English Notebook · UI
 * 依赖 core.js 暴露的全局 ENB。
 * 全站静默：默认不显示任何按钮，只通过 Alt+S / Alt+O / Alt+M 和油猴菜单唤出。
 */
(function () {
  'use strict';

  const C = (typeof globalThis !== 'undefined' && globalThis.ENB)
    ? globalThis.ENB
    : (typeof window !== 'undefined' ? window.ENB : null);
  if (!C) return;

  const KEY = 'en.notebook.v1';
  const SETTINGS_KEY = 'en.notebook.settings.v1';
  const HOST_ID = 'enb-ui-host';
  const DEFAULT_SETTINGS = { highlight: true, minHighlightLen: 7 };

  let state = readState();
  let settings = readSettings();

  let hostEl = null;
  let shadow = null;
  let initialized = false;

  let sidebarOpen = false;
  let managerOpen = false;
  let sidebarQuery = '';
  let managerQuery = '';
  let showAllGroups = false;
  let managerGroupId = 'all';

  let captureMode = 'create';
  let editingItemId = null;

  let undoStack = null;
  let toastTimer = null;
  let saveTimer = null;
  let highlightTimer = null;
  let lastUrl = location.href;
  let fileInput = null;

  /* ================= 存储 ================= */

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (e) { /* ignore */ }
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { /* ignore */ }
    return fallback;
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
    } catch (e) { /* ignore */ }
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function readState() {
    const raw = gmGet(KEY, '');
    if (raw && typeof raw === 'object') return C.normalizeState(raw);
    if (typeof raw === 'string' && raw) {
      try { return C.normalizeState(JSON.parse(raw)); } catch (e) { /* ignore */ }
    }
    return C.normalizeState(null);
  }

  function readSettings() {
    const raw = gmGet(SETTINGS_KEY, '');
    let obj = null;
    if (raw && typeof raw === 'object') obj = raw;
    else if (typeof raw === 'string' && raw) { try { obj = JSON.parse(raw); } catch (e) { /* ignore */ } }
    const out = Object.assign({}, DEFAULT_SETTINGS, obj || {});
    out.highlight = !!out.highlight;
    out.minHighlightLen = Math.max(4, Number(out.minHighlightLen) || DEFAULT_SETTINGS.minHighlightLen);
    return out;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 200);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try { gmSet(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function saveSettings() {
    try { gmSet(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function beginUndo(label) {
    undoStack = { label: label, snapshot: C.cloneState(state) };
  }

  function undo() {
    if (!undoStack) return;
    state = C.normalizeState(undoStack.snapshot);
    undoStack = null;
    save();
    render();
    removeHighlights();
    scheduleHighlight();
    toast('已撤销');
  }

  /* ================= 小工具 ================= */

  function qs(id) {
    return shadow ? shadow.querySelector('#' + id) : null;
  }

  function h(tag, props) {
    const el = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      const v = props[k];
      if (v === undefined || v === null) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') {
        Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
      } else if (k.slice(0, 2) === 'on') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        el.setAttribute(k, String(v));
      }
    });
    for (let i = 2; i < arguments.length; i++) appendChild(el, arguments[i]);
    return el;
  }

  function appendChild(el, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) { appendChild(el, c); });
      return;
    }
    if (children.nodeType) el.appendChild(children);
    else el.appendChild(document.createTextNode(String(children)));
  }

  function cleanSelection(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  }

  function truncate(s, n) {
    const str = String(s || '');
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  function byName(a, b) { return a.name.localeCompare(b.name, 'zh-CN'); }
  function byRecent(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }

  function groupName(id) {
    const g = state.groups.find(function (x) { return x.id === id; });
    return g ? g.name : '';
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function toast(message, action) {
    const el = qs('enb-toast');
    if (!el) return;
    const msg = qs('enb-toast-msg');
    if (msg) msg.textContent = String(message);
    const btn = qs('enb-toast-action');
    if (btn) {
      if (action && action.label) {
        btn.hidden = false;
        btn.textContent = action.label;
        btn.onclick = function () {
          hideToast();
          try { action.onClick(); } catch (e) { /* ignore */ }
        };
      } else {
        btn.hidden = true;
        btn.onclick = null;
      }
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 2200);
  }

  function hideToast() {
    const el = qs('enb-toast');
    if (el) el.hidden = true;
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  /* ================= 初始化 ================= */

  function init() {
    if (initialized) return;
    if (!document.body || !document.documentElement) return;
    if (document.getElementById(HOST_ID)) return;
    initialized = true;

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'all:initial;display:block;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    applyStyles(shadow);
    document.documentElement.appendChild(hostEl);

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.className = 'file-input';
    fileInput.addEventListener('change', onImportFile);
    shadow.appendChild(fileInput);

    bindUi();
    installHotkeys();
    installMenuCommands();
    installSpaWatcher();
    installCrossTabSync();
    installFlushHooks();
    syncSettingsUi();
    render();
    scheduleHighlight();
    window.addEventListener('load', scheduleHighlight);
  }

  function applyStyles(root) {
    try {
      if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (e) { /* fallthrough */ }
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    root.appendChild(styleEl);
  }

  function bindUi() {
    function on(id, event, handler) {
      const el = qs(id);
      if (el) el.addEventListener(event, handler);
    }

    on('enb-sidebar-close', 'click', closeSidebar);
    on('enb-manager-close', 'click', closeManager);
    on('enb-capture-close', 'click', closeCapture);
    on('enb-capture-cancel', 'click', closeCapture);
    on('enb-capture-save', 'click', saveCapture);
    on('enb-capture-group', 'change', syncNewGroupFields);

    on('enb-search', 'input', function (e) { sidebarQuery = e.target.value; renderSidebarList(); });
    on('enb-show-all', 'change', function (e) { showAllGroups = e.target.checked; renderSidebarList(); });
    on('enb-quick-capture', 'click', captureSelection);
    on('enb-new-group', 'click', function () { openGroupEditor(null); });
    on('enb-open-manager', 'click', openManager);

    on('enb-manager-search', 'input', function (e) { managerQuery = e.target.value; renderManagerItems(); });
    on('enb-export', 'click', exportJSON);
    on('enb-import', 'click', function () { if (fileInput) fileInput.click(); });
    on('enb-hl-toggle', 'change', function (e) {
      settings.highlight = e.target.checked;
      saveSettings();
      if (settings.highlight) scheduleHighlight(); else removeHighlights();
    });
    on('enb-manager-new-group', 'click', function () { openGroupEditor(null); });

    on('enb-backdrop', 'click', function (e) {
      if (e.target === qs('enb-backdrop')) closeManager();
    });
    on('enb-dialog', 'click', function (e) {
      if (e.target === qs('enb-dialog')) closeDialog();
    });
  }

  function syncSettingsUi() {
    const hl = qs('enb-hl-toggle');
    if (hl) hl.checked = !!settings.highlight;
    const all = qs('enb-show-all');
    if (all) all.checked = showAllGroups;
    const search = qs('enb-search');
    if (search) search.value = sidebarQuery;
    const msearch = qs('enb-manager-search');
    if (msearch) msearch.value = managerQuery;
  }

  /* ================= 跨标签页同步 / 落盘 ================= */

  function installCrossTabSync() {
    if (typeof GM_addValueChangeListener !== 'function') return;
    try {
      GM_addValueChangeListener(KEY, function (name, oldValue, newValue, remote) {
        if (!remote) return;
        let next = null;
        try { next = typeof newValue === 'string' ? JSON.parse(newValue) : newValue; } catch (e) { return; }
        if (!next) return;
        state = C.normalizeState(next);
        render();
      });
    } catch (e) { /* ignore */ }
  }

  function installFlushHooks() {
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }

  /* ================= 快捷键 ================= */

  function installHotkeys() {
    window.addEventListener('keydown', onKeydown, true);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      const dialog = qs('enb-dialog');
      if (dialog && !dialog.hidden) { e.preventDefault(); closeDialog(); return; }
      const cap = qs('enb-capture');
      if (cap && !cap.hidden) { e.preventDefault(); closeCapture(); return; }
      if (sidebarOpen) { e.preventDefault(); closeSidebar(); return; }
      if (managerOpen) { e.preventDefault(); closeManager(); return; }
      return;
    }
    if (e.repeat) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (hostEl && path.indexOf(hostEl) !== -1) return;
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.code === 'KeyS') { e.preventDefault(); e.stopPropagation(); captureSelection(); }
    else if (e.code === 'KeyO') { e.preventDefault(); e.stopPropagation(); toggleSidebar(); }
    else if (e.code === 'KeyM') { e.preventDefault(); e.stopPropagation(); toggleManager(); }
  }

  function installMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('记录选中内容 (Alt+S)', captureSelection);
      GM_registerMenuCommand('打开当前网站侧栏 (Alt+O)', openSidebar);
      GM_registerMenuCommand('打开管理器 (Alt+M)', openManager);
      GM_registerMenuCommand('导出 JSON', exportJSON);
      GM_registerMenuCommand('导入 JSON', function () { if (fileInput) fileInput.click(); });
      GM_registerMenuCommand('切换重访高亮', function () {
        settings.highlight = !settings.highlight;
        saveSettings();
        syncSettingsUi();
        if (settings.highlight) scheduleHighlight(); else removeHighlights();
        toast(settings.highlight ? '已开启重访高亮' : '已关闭重访高亮');
      });
    } catch (e) { /* ignore */ }
  }

  /* ================= SPA 导航监听 ================= */

  function installSpaWatcher() {
    const check = function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      if (sidebarOpen) renderSidebarList();
      scheduleHighlight();
    };
    const wrap = function (fn) {
      return function () {
        const result = fn.apply(this, arguments);
        check();
        return result;
      };
    };
    try {
      if (history.pushState) history.pushState = wrap(history.pushState);
      if (history.replaceState) history.replaceState = wrap(history.replaceState);
    } catch (e) { /* ignore */ }
    window.addEventListener('popstate', check);
    setInterval(check, 1500);
  }

  /* ================= 记录 ================= */

  function captureSelection() {
    const sel = window.getSelection();
    const text = cleanSelection(sel ? sel.toString() : '');
    if (!text) {
      toast('请先在网页上选中英文句子或词组，再按 Alt+S');
      return;
    }
    const host = C.normalizeHost(location.hostname);
    const matches = C.groupsForHost(state, host).sort(byName);
    if (matches.length === 1) {
      beginUndo('记录');
      const item = C.addItem(state, {
        text: text,
        groupId: matches[0].id,
        sourceUrl: location.href,
        sourceTitle: document.title,
        sourceHost: host,
      });
      if (!item) { toast('记录失败'); return; }
      save();
      render();
      if (settings.highlight) scheduleHighlight();
      toast('已记入「' + matches[0].name + '」', { label: '撤销', onClick: undo });
      return;
    }
    openCapture({ mode: 'create', text: text, defaultGroupId: matches.length ? matches[0].id : null });
  }

  function openCapture(opts) {
    opts = opts || {};
    captureMode = opts.mode === 'edit' ? 'edit' : 'create';
    editingItemId = opts.item ? opts.item.id : null;

    const title = qs('enb-capture-title');
    const ta = qs('enb-capture-text');
    const note = qs('enb-capture-note');
    const ngName = qs('enb-capture-newgroup-name');
    const ngHosts = qs('enb-capture-newgroup-hosts');
    if (!title || !ta || !note || !ngName || !ngHosts) return;

    const host = C.normalizeHost(location.hostname);
    title.textContent = captureMode === 'edit' ? '编辑记录' : '记录';

    if (captureMode === 'edit' && opts.item) {
      ta.value = opts.item.text;
      note.value = opts.item.note || '';
      ngName.value = '';
      ngHosts.value = '';
      populateGroupSelect(opts.item.groupId, false);
    } else {
      ta.value = opts.text || '';
      note.value = '';
      ngName.value = host || '';
      ngHosts.value = host || '';
      populateGroupSelect(opts.defaultGroupId || null, !opts.defaultGroupId);
    }

    qs('enb-capture').hidden = false;
    syncNewGroupFields();
    setTimeout(function () {
      ta.focus();
      if (ta.select) ta.select();
    }, 30);
  }

  function populateGroupSelect(selectedId, wantNew) {
    const sel = qs('enb-capture-group');
    if (!sel) return;
    sel.textContent = '';
    const host = C.normalizeHost(location.hostname);
    state.groups.slice().sort(byName).forEach(function (g) {
      const label = g.name + (C.groupMatchesHost(g, host) ? '（当前网站）' : '');
      sel.appendChild(h('option', { value: g.id, text: label }));
    });
    sel.appendChild(h('option', { value: '__none__', text: '未分组' }));
    sel.appendChild(h('option', { value: '__new__', text: '＋ 新建分组…' }));
    let target = selectedId || (wantNew ? '__new__' : '__none__');
    let exists = false;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === target) { exists = true; break; }
    }
    sel.value = exists ? target : (wantNew ? '__new__' : '__none__');
  }

  function syncNewGroupFields() {
    const sel = qs('enb-capture-group');
    const box = qs('enb-capture-newgroup');
    if (!sel || !box) return;
    box.hidden = sel.value !== '__new__';
  }

  function closeCapture() {
    const cap = qs('enb-capture');
    if (cap) cap.hidden = true;
    editingItemId = null;
    captureMode = 'create';
  }

  function saveCapture() {
    const ta = qs('enb-capture-text');
    const noteEl = qs('enb-capture-note');
    const sel = qs('enb-capture-group');
    if (!ta || !noteEl || !sel) return;

    const text = cleanSelection(ta.value);
    if (!text) { toast('内容不能为空'); return; }
    const note = noteEl.value.trim();
    const isEdit = captureMode === 'edit' && !!editingItemId;

    let groupId = sel.value;
    let newGroup = null;
    if (groupId === '__new__') {
      const name = qs('enb-capture-newgroup-name').value.trim();
      if (!name) { toast('请填写新分组名称'); return; }
      newGroup = {
        name: name,
        hosts: qs('enb-capture-newgroup-hosts').value.split(/[,，\s]+/).filter(Boolean),
      };
    } else if (groupId === '__none__') {
      groupId = null;
    }

    beginUndo(isEdit ? '编辑记录' : '记录');
    if (newGroup) groupId = C.addGroup(state, newGroup.name, newGroup.hosts).id;

    if (isEdit) {
      C.updateItem(state, editingItemId, { text: text, note: note, groupId: groupId });
      toast('已更新');
    } else {
      C.addItem(state, {
        text: text,
        note: note,
        groupId: groupId,
        sourceUrl: location.href,
        sourceTitle: document.title,
        sourceHost: C.normalizeHost(location.hostname),
      });
      toast('已记录');
    }

    save();
    render();
    closeCapture();
    if (settings.highlight) scheduleHighlight();
  }

  function removeItem(item) {
    confirmDialog('删除这条记录？\n' + truncate(item.text, 80), function () {
      beginUndo('删除记录');
      C.deleteItem(state, item.id);
      save();
      render();
      if (settings.highlight) { removeHighlights(); scheduleHighlight(); }
      toast('已删除', { label: '撤销', onClick: undo });
    }, { danger: true, yesLabel: '删除' });
  }

  /* ================= 侧栏 ================= */

  function openSidebar() {
    if (!shadow) return;
    sidebarOpen = true;
    const el = qs('enb-sidebar');
    if (el) el.hidden = false;
    renderSidebarList();
    syncSettingsUi();
  }

  function closeSidebar() {
    sidebarOpen = false;
    const el = qs('enb-sidebar');
    if (el) el.hidden = true;
  }

  function toggleSidebar() {
    if (sidebarOpen) closeSidebar(); else openSidebar();
  }

  function renderSidebarList() {
    if (!shadow) return;
    const list = qs('enb-side-list');
    if (!list) return;
    list.textContent = '';

    const host = C.normalizeHost(location.hostname);
    const label = qs('enb-host-label');
    if (label) label.textContent = host || location.hostname || '';

    const q = sidebarQuery.trim().toLowerCase();
    const matchesQuery = function (it) {
      if (!q) return true;
      return (it.text + ' ' + (it.note || '')).toLowerCase().indexOf(q) !== -1;
    };

    let groups;
    if (showAllGroups) {
      groups = state.groups.slice().sort(byName);
    } else {
      groups = state.groups.filter(function (g) {
        if (C.groupMatchesHost(g, host)) return true;
        return state.items.some(function (it) { return it.groupId === g.id && it.sourceHost === host; });
      }).sort(byName);
    }

    let shown = 0;
    groups.forEach(function (g) {
      const items = state.items.filter(function (it) {
        return it.groupId === g.id && matchesQuery(it);
      }).sort(byRecent);
      if (!items.length) return;
      shown += items.length;
      list.appendChild(groupSection(g, items));
    });

    const ungrouped = state.items.filter(function (it) {
      if (it.groupId) return false;
      if (!matchesQuery(it)) return false;
      return showAllGroups || !it.sourceHost || it.sourceHost === host;
    }).sort(byRecent);
    if (ungrouped.length) {
      shown += ungrouped.length;
      list.appendChild(ungroupedSection(ungrouped));
    }

    if (!shown) {
      list.appendChild(h('div', { class: 'empty' },
        h('p', { text: state.items.length ? '当前网站还没有相关记录。' : '还没有任何记录。' }),
        h('p', { class: 'hint', text: '在网页上选中英文句子或词组后按 Alt+S；Alt+O 打开这个侧栏；Alt+M 打开管理器。' })
      ));
    }
  }

  function groupSection(group, items) {
    const head = h('div', { class: 'group-head' },
      h('span', { class: 'group-name', text: group.name }),
      h('span', { class: 'count', text: String(items.length) }),
      h('span', { class: 'group-hosts', text: group.hosts.join(' · ') }),
      h('button', {
        class: 'mini',
        title: '编辑分组',
        text: '✎',
        onclick: function (e) { e.stopPropagation(); openGroupEditor(group); },
      })
    );
    const body = h('div', { class: 'group-body' });
    items.forEach(function (it) { body.appendChild(itemRow(it, false)); });
    return h('section', { class: 'group' }, head, body);
  }

  function ungroupedSection(items) {
    const head = h('div', { class: 'group-head' },
      h('span', { class: 'group-name', text: '未分组' }),
      h('span', { class: 'count', text: String(items.length) })
    );
    const body = h('div', { class: 'group-body' });
    items.forEach(function (it) { body.appendChild(itemRow(it, false)); });
    return h('section', { class: 'group' }, head, body);
  }

  function itemRow(item, withGroup) {
    const row = h('div', { class: 'item', dataset: { itemId: item.id } });
    row.appendChild(h('div', { class: 'item-text', text: item.text }));
    if (item.note) row.appendChild(h('div', { class: 'item-note', text: item.note }));

    const meta = [];
    if (withGroup) meta.push(item.groupId ? (groupName(item.groupId) || '未分组') : '未分组');
    if (item.sourceHost) meta.push(item.sourceHost);
    if (item.createdAt) meta.push(fmtDate(item.createdAt));
    if (meta.length) row.appendChild(h('div', { class: 'item-meta', text: meta.join(' · ') }));

    const actions = h('div', { class: 'item-actions' },
      actionBtn('🔊', '朗读', function () { speak(item.text); }),
      actionBtn('✎', '编辑', function () { openCapture({ mode: 'edit', item: item }); }),
      actionBtn('⎘', '复制', function () { copyText(item.text); })
    );
    if (item.sourceUrl) {
      actions.appendChild(actionBtn('↗', '打开来源', function () { openUrl(item.sourceUrl); }));
    }
    actions.appendChild(actionBtn('🗑', '删除', function () { removeItem(item); }));
    row.appendChild(actions);
    return row;
  }

  function actionBtn(icon, title, handler) {
    return h('button', { class: 'icon-btn', title: title, text: icon, onclick: handler });
  }

  function scrollToItem(itemId) {
    setTimeout(function () {
      const el = shadow && shadow.querySelector('[data-item-id="' + itemId + '"]');
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(function () { el.classList.remove('flash'); }, 1500);
    }, 60);
  }

  /* ================= 管理器 ================= */

  function openManager() {
    if (!shadow) return;
    managerOpen = true;
    const back = qs('enb-backdrop');
    if (back) back.hidden = false;
    renderManager();
  }

  function closeManager() {
    managerOpen = false;
    const back = qs('enb-backdrop');
    if (back) back.hidden = true;
  }

  function toggleManager() {
    if (managerOpen) closeManager(); else openManager();
  }

  function renderManager() {
    if (!managerOpen) return;
    renderGroupList();
    renderManagerItems();
  }

  function renderGroupList() {
    const ul = qs('enb-group-list');
    if (!ul) return;
    ul.textContent = '';
    ul.appendChild(groupRow('all', '全部记录', state.items.length, ''));
    state.groups.slice().sort(byName).forEach(function (g) {
      ul.appendChild(groupRow(g.id, g.name, C.countItems(state, g.id), g.hosts.join(' · '), g));
    });
    const ungrouped = C.countItems(state, null);
    if (ungrouped) ul.appendChild(groupRow('none', '未分组', ungrouped, ''));
  }

  function groupRow(id, name, count, sub, group) {
    const row = h('li', {
      class: 'group-row' + (managerGroupId === id ? ' active' : ''),
      dataset: { groupId: id },
    },
      h('div', { class: 'gr-main' },
        h('span', { class: 'gr-name', text: name }),
        h('span', { class: 'gr-count', text: String(count) })
      ),
      sub ? h('div', { class: 'gr-sub', text: sub }) : null
    );
    if (group) {
      row.appendChild(h('button', {
        class: 'mini gr-edit',
        title: '编辑分组',
        text: '✎',
        onclick: function (e) { e.stopPropagation(); openGroupEditor(group); },
      }));
    }
    row.addEventListener('click', function () {
      managerGroupId = id;
      renderGroupList();
      renderManagerItems();
    });
    return row;
  }

  function renderManagerItems() {
    if (!managerOpen) return;
    const list = qs('enb-manager-list');
    const titleEl = qs('enb-items-title');
    if (!list || !titleEl) return;
    list.textContent = '';

    let title = '全部记录';
    if (managerGroupId === 'none') {
      title = '未分组';
    } else if (managerGroupId !== 'all') {
      const g = state.groups.find(function (x) { return x.id === managerGroupId; });
      if (g) title = g.name;
      else { managerGroupId = 'all'; title = '全部记录'; }
    }

    const total = managerGroupId === 'all'
      ? state.items.length
      : managerGroupId === 'none'
        ? C.countItems(state, null)
        : C.countItems(state, managerGroupId);
    titleEl.textContent = title + '（' + total + '）';

    const q = managerQuery.trim().toLowerCase();
    let items = state.items.slice();
    if (managerGroupId === 'none') items = items.filter(function (it) { return !it.groupId; });
    else if (managerGroupId !== 'all') items = items.filter(function (it) { return it.groupId === managerGroupId; });

    if (q) {
      items = items.filter(function (it) {
        return (it.text + ' ' + (it.note || '') + ' ' + (groupName(it.groupId) || '')).toLowerCase().indexOf(q) !== -1;
      });
    }
    items.sort(byRecent);

    if (!items.length) {
      list.appendChild(h('div', { class: 'empty' },
        h('p', { text: q ? '没有匹配的记录。' : '这个分组还没有记录。' })
      ));
      return;
    }
    items.forEach(function (it) { list.appendChild(itemRow(it, true)); });
  }

  /* ================= 分组编辑 / 对话框 ================= */

  function showDialog(opts) {
    const back = qs('enb-dialog');
    if (!back) return;
    qs('enb-dialog-title').textContent = opts.title || '';
    const body = qs('enb-dialog-body');
    body.textContent = '';
    if (opts.bodyEl) body.appendChild(opts.bodyEl);
    const foot = qs('enb-dialog-foot');
    foot.textContent = '';
    (opts.buttons || []).forEach(function (b) {
      foot.appendChild(h('button', {
        class: 'btn ' + (b.kind || ''),
        text: b.label,
        onclick: b.onClick,
      }));
    });
    back.hidden = false;
  }

  function closeDialog() {
    const back = qs('enb-dialog');
    if (back) back.hidden = true;
  }

  function confirmDialog(message, onYes, opts) {
    opts = opts || {};
    showDialog({
      title: opts.title || '请确认',
      bodyEl: h('p', { class: 'dialog-msg', text: message }),
      buttons: [
        {
          label: opts.yesLabel || '确定',
          kind: opts.danger ? 'danger' : 'primary',
          onClick: function () { closeDialog(); try { onYes(); } catch (e) { console.warn(e); } },
        },
        { label: '取消', onClick: closeDialog },
      ],
    });
  }

  function openGroupEditor(group) {
    const host = C.normalizeHost(location.hostname);
    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      value: group ? group.name : '',
      placeholder: '例如：BBC 新闻、技术文档',
    });
    const hostsInput = h('input', {
      class: 'input',
      type: 'text',
      value: group ? group.hosts.join(' ') : host,
      placeholder: '绑定网址，例如 bbc.com（留空表示不绑定，子域自动匹配）',
    });
    const form = h('div', { class: 'dialog-form' },
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: '分组名称' }),
        nameInput
      ),
      h('label', { class: 'field' },
        h('span', { class: 'field-label', text: '绑定网址（空格或逗号分隔，可留空）' }),
        hostsInput
      ),
      h('p', { class: 'hint', text: '绑定后，在该网站按 Alt+S 会默认记入这个分组；记录也可以在侧栏/管理器里移到任意分组。' })
    );

    const buttons = [];
    if (group) {
      buttons.push({
        label: '删除分组',
        kind: 'danger',
        onClick: function () { closeDialog(); askDeleteGroup(group); },
      });
    }
    buttons.push({
      label: group ? '保存' : '创建',
      kind: 'primary',
      onClick: function () {
        const name = nameInput.value.trim();
        if (!name) { toast('请填写分组名称'); return; }
        const hosts = hostsInput.value.split(/[,，\s]+/).filter(Boolean);
        beginUndo(group ? '编辑分组' : '新建分组');
        if (group) C.updateGroup(state, group.id, { name: name, hosts: hosts });
        else C.addGroup(state, name, hosts);
        save();
        render();
        closeDialog();
        toast(group ? '分组已保存' : '已创建分组「' + name + '」');
      },
    });
    buttons.push({ label: '取消', onClick: closeDialog });

    showDialog({ title: group ? '编辑分组' : '新建分组', bodyEl: form, buttons: buttons });
    setTimeout(function () {
      nameInput.focus();
      if (nameInput.select) nameInput.select();
    }, 30);
  }

  function askDeleteGroup(group) {
    const n = C.countItems(state, group.id);
    confirmDialog(
      '删除分组「' + group.name + '」？' + (n ? '组内 ' + n + ' 条记录会移到「未分组」。' : ''),
      function () {
        beginUndo('删除分组');
        C.deleteGroup(state, group.id);
        if (managerGroupId === group.id) managerGroupId = 'all';
        save();
        render();
        removeHighlights();
        scheduleHighlight();
        toast('已删除分组', { label: '撤销', onClick: undo });
      },
      { danger: true, yesLabel: '删除' }
    );
  }

  /* ================= 导入 / 导出 ================= */

  function exportJSON() {
    const data = C.exportState(state);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'english-notes-' + stamp + '.json';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('已导出：分组 ' + data.groups.length + ' 个，记录 ' + data.items.length + ' 条');
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  function onImportFile() {
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let incoming;
      try { incoming = JSON.parse(String(reader.result)); } catch (e) { toast('不是合法的 JSON 文件'); return; }
      if (!incoming || !Array.isArray(incoming.groups) || !Array.isArray(incoming.items)) {
        toast('JSON 结构不正确：需要 groups 和 items 数组');
        return;
      }
      showImportDialog(C.normalizeState(incoming));
    };
    reader.readAsText(file);
    fileInput.value = '';
  }

  function showImportDialog(incoming) {
    const body = h('div', { class: 'dialog-form' },
      h('p', { class: 'dialog-msg', text: '已读取：分组 ' + incoming.groups.length + ' 个，记录 ' + incoming.items.length + ' 条。' }),
      h('p', { class: 'hint', text: '「合并」：同 id 保留更新时间较新的一条，其余跳过；「覆盖」：清空当前数据后导入。' })
    );
    showDialog({
      title: '导入 JSON',
      bodyEl: body,
      buttons: [
        { label: '合并', kind: 'primary', onClick: function () { applyImport(incoming, 'merge'); } },
        { label: '覆盖', kind: 'danger', onClick: function () { applyImport(incoming, 'replace'); } },
        { label: '取消', onClick: closeDialog },
      ],
    });
  }

  function applyImport(incoming, mode) {
    beginUndo('导入');
    const res = C.mergeImport(state, incoming, mode);
    state = res.state;
    save();
    render();
    closeDialog();
    setTimeout(scheduleHighlight, 300);
    const st = res.stats;
    if (mode === 'replace') {
      toast('已覆盖导入：' + st.groupsAdded + ' 个分组，' + st.itemsAdded + ' 条记录');
    } else {
      toast('合并完成：新增分组 ' + st.groupsAdded + '，更新分组 ' + st.groupsUpdated +
        '；新增记录 ' + st.itemsAdded + '，更新 ' + st.itemsUpdated + '，跳过 ' + st.itemsSkipped);
    }
  }

  /* ================= 重访高亮 ================= */

  function scheduleHighlight() {
    if (!settings.highlight) return;
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(runHighlight, 1200);
  }

  function runHighlight() {
    if (!settings.highlight || !document.body) return;
    const host = C.normalizeHost(location.hostname);
    if (!host) return;

    const minLen = settings.minHighlightLen;
    const candidates = state.items.filter(function (it) {
      return it.sourceHost && C.hostMatches(it.sourceHost, host) && it.text.length >= minLen;
    }).slice(0, 500);
    if (!candidates.length) return;

    const textToItem = new Map();
    candidates.forEach(function (it) {
      if (!textToItem.has(it.text)) textToItem.set(it.text, it);
    });
    const texts = Array.from(textToItem.keys());
    if (!texts.length) return;

    const ACCEPT = NodeFilter.FILTER_ACCEPT;
    const REJECT = NodeFilter.FILTER_REJECT;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || node.nodeValue.length < minLen) return REJECT;
        const p = node.parentElement;
        if (!p) return REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' ||
            tag === 'MARK' || tag === 'PRE' || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') return REJECT;
        if (p.closest && p.closest('[contenteditable=""], [contenteditable="true"]')) return REJECT;
        if (hostEl && p.closest && p.closest('#' + HOST_ID)) return REJECT;
        return ACCEPT;
      },
    });

    const jobs = [];
    let node;
    while ((node = walker.nextNode()) && jobs.length < 300) {
      const value = node.nodeValue;
      for (let i = 0; i < texts.length; i++) {
        const idx = value.indexOf(texts[i]);
        if (idx === -1) continue;
        jobs.push({ node: node, idx: idx, text: texts[i], item: textToItem.get(texts[i]) });
        break;
      }
    }
    jobs.forEach(applyHighlightJob);
  }

  function applyHighlightJob(job) {
    const node = job.node;
    const parent = node.parentNode;
    if (!parent) return;
    const value = node.nodeValue;
    try {
      const mark = document.createElement('mark');
      mark.className = 'enb-hl';
      mark.textContent = job.text;
      mark.style.background = 'rgba(255, 214, 89, 0.45)';
      mark.style.color = 'inherit';
      mark.style.borderRadius = '2px';
      mark.style.boxShadow = 'inset 0 -2px 0 rgba(245, 166, 35, 0.75)';
      mark.style.cursor = 'pointer';
      if (job.item.note) mark.title = job.item.note;
      mark.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openSidebar();
        scrollToItem(job.item.id);
      }, true);

      const before = value.slice(0, job.idx);
      const after = value.slice(job.idx + job.text.length);
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(mark, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
    } catch (e) { /* 不打断页面 */ }
  }

  function removeHighlights() {
    const marks = document.querySelectorAll('mark.enb-hl');
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  /* ================= 朗读 / 复制 / 打开链接 ================= */

  function speak(text) {
    const synth = window.speechSynthesis;
    const Utter = window.SpeechSynthesisUtterance;
    if (!synth || !Utter) { toast('当前浏览器不支持朗读'); return; }
    try {
      synth.cancel();
      const u = new Utter(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      synth.speak(u);
    } catch (e) {
      toast('朗读失败');
    }
  }

  function copyText(text) {
    const done = function () { toast('已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;width:1px;height:1px;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    } catch (e) {
      toast('复制失败，请手动选择复制');
    }
  }

  function openUrl(url) {
    if (!url) { toast('没有来源地址'); return; }
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { toast('打开失败'); }
  }

  /* ================= 渲染入口 ================= */

  function render() {
    if (!shadow) return;
    renderSidebarList();
    if (managerOpen) renderManager();
  }

  /* ================= 模板与样式 ================= */

  const TEMPLATE =
    '<div class="enb">' +
      '<section id="enb-sidebar" class="panel sidebar" hidden>' +
        '<header class="side-head">' +
          '<span class="side-title">英语笔记</span>' +
          '<span class="side-host" id="enb-host-label"></span>' +
          '<button class="icon" id="enb-sidebar-close" title="关闭 (Esc)" aria-label="关闭">✕</button>' +
        '</header>' +
        '<div class="side-tools">' +
          '<input id="enb-search" class="search" type="search" placeholder="搜索句子 / 释义…" />' +
          '<label class="toggle"><input type="checkbox" id="enb-show-all" /> 全部组</label>' +
        '</div>' +
        '<div class="side-actions">' +
          '<button id="enb-quick-capture" class="btn primary">＋ 记录选中</button>' +
          '<button id="enb-new-group" class="btn">新建组</button>' +
          '<button id="enb-open-manager" class="btn">管理器</button>' +
        '</div>' +
        '<div class="list" id="enb-side-list"></div>' +
      '</section>' +

      '<div id="enb-backdrop" class="backdrop" hidden>' +
        '<section class="panel manager">' +
          '<header class="manager-head">' +
            '<span class="manager-title">英语笔记 · 管理器</span>' +
            '<div class="manager-tools">' +
              '<input id="enb-manager-search" class="search" type="search" placeholder="全局搜索…" />' +
              '<button id="enb-export" class="btn small">导出 JSON</button>' +
              '<button id="enb-import" class="btn small">导入 JSON</button>' +
              '<label class="toggle"><input type="checkbox" id="enb-hl-toggle" /> 重访高亮</label>' +
              '<button class="icon" id="enb-manager-close" title="关闭 (Esc)" aria-label="关闭">✕</button>' +
            '</div>' +
          '</header>' +
          '<div class="manager-body">' +
            '<aside class="groups">' +
              '<div class="groups-head"><span>分组</span>' +
                '<button id="enb-manager-new-group" class="btn small">＋ 新建</button>' +
              '</div>' +
              '<ul id="enb-group-list" class="group-list"></ul>' +
            '</aside>' +
            '<section class="items">' +
              '<div class="items-head" id="enb-items-title"></div>' +
              '<div class="list" id="enb-manager-list"></div>' +
            '</section>' +
          '</div>' +
        '</section>' +
      '</div>' +

      '<section id="enb-capture" class="panel capture" hidden>' +
        '<header class="cap-head">' +
          '<span id="enb-capture-title">记录</span>' +
          '<button class="icon" id="enb-capture-close" title="关闭 (Esc)" aria-label="关闭">✕</button>' +
        '</header>' +
        '<textarea id="enb-capture-text" rows="3" placeholder="要记的英文句子或词组"></textarea>' +
        '<input id="enb-capture-note" class="input" type="text" placeholder="释义 / 备注（可选）" />' +
        '<div class="cap-row"><select id="enb-capture-group" class="select"></select></div>' +
        '<div class="cap-newgroup" id="enb-capture-newgroup" hidden>' +
          '<input id="enb-capture-newgroup-name" class="input" type="text" placeholder="新分组名称" />' +
          '<input id="enb-capture-newgroup-hosts" class="input" type="text" placeholder="绑定网址，例如 bbc.com（留空则通用）" />' +
        '</div>' +
        '<div class="cap-foot">' +
          '<button id="enb-capture-save" class="btn primary">保存</button>' +
          '<button id="enb-capture-cancel" class="btn">取消</button>' +
        '</div>' +
      '</section>' +

      '<div id="enb-dialog" class="backdrop dialog" hidden>' +
        '<section class="panel dialog-panel">' +
          '<h3 id="enb-dialog-title"></h3>' +
          '<div id="enb-dialog-body"></div>' +
          '<div id="enb-dialog-foot"></div>' +
        '</section>' +
      '</div>' +

      '<div id="enb-toast" class="toast" hidden>' +
        '<span id="enb-toast-msg"></span>' +
        '<button id="enb-toast-action" class="btn small" hidden></button>' +
      '</div>' +
    '</div>';

  const CSS = [
    ':host {',
    '  --enb-bg: #ffffff;',
    '  --enb-panel: #ffffff;',
    '  --enb-text: #1f2328;',
    '  --enb-muted: #6b7280;',
    '  --enb-border: #e5e7eb;',
    '  --enb-hover: #f3f4f6;',
    '  --enb-accent: #2563eb;',
    '  --enb-accent-soft: #dbeafe;',
    '  --enb-danger: #dc2626;',
    '  --enb-shadow: 0 12px 40px rgba(15, 23, 42, 0.18);',
    '  --enb-radius: 12px;',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :host {',
    '    --enb-bg: #0f172a;',
    '    --enb-panel: #111827;',
    '    --enb-text: #e5e7eb;',
    '    --enb-muted: #9ca3af;',
    '    --enb-border: #273244;',
    '    --enb-hover: #1f2937;',
    '    --enb-accent: #60a5fa;',
    '    --enb-accent-soft: #1e3a8a;',
    '    --enb-danger: #f87171;',
    '    --enb-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);',
    '  }',
    '}',
    '[hidden] { display: none !important; }',
    '* { box-sizing: border-box; }',
    '.enb {',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  font-size: 13px;',
    '  line-height: 1.5;',
    '  color: var(--enb-text);',
    '}',
    'button { font: inherit; color: inherit; cursor: pointer; }',
    'input, textarea, select { font: inherit; color: inherit; }',
    '.panel {',
    '  background: var(--enb-panel);',
    '  border: 1px solid var(--enb-border);',
    '  border-radius: var(--enb-radius);',
    '  box-shadow: var(--enb-shadow);',
    '  pointer-events: auto;',
    '  overflow: hidden;',
    '  display: flex;',
    '  flex-direction: column;',
    '}',
    '.btn {',
    '  border: 1px solid var(--enb-border);',
    '  background: var(--enb-panel);',
    '  color: var(--enb-text);',
    '  border-radius: 8px;',
    '  padding: 5px 10px;',
    '  line-height: 1.4;',
    '  white-space: nowrap;',
    '}',
    '.btn:hover { background: var(--enb-hover); }',
    '.btn.primary { background: var(--enb-accent); border-color: var(--enb-accent); color: #ffffff; }',
    '.btn.primary:hover { filter: brightness(0.94); }',
    '.btn.danger { color: var(--enb-danger); border-color: var(--enb-danger); }',
    '.btn.danger:hover { background: rgba(220, 38, 38, 0.08); }',
    '.btn.small { padding: 2px 8px; font-size: 12px; }',
    '.icon { border: none; background: transparent; color: var(--enb-muted); padding: 4px 6px; border-radius: 6px; font-size: 14px; line-height: 1; }',
    '.icon:hover { background: var(--enb-hover); color: var(--enb-text); }',
    '.sidebar {',
    '  position: fixed; top: 12px; right: 12px;',
    '  width: 400px; max-width: calc(100vw - 24px);',
    '  max-height: calc(100vh - 24px);',
    '  z-index: 1;',
    '}',
    '.side-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--enb-border); }',
    '.side-title { font-weight: 600; font-size: 14px; }',
    '.side-host { color: var(--enb-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: right; }',
    '.side-tools { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--enb-border); }',
    '.search { flex: 1; min-width: 0; border: 1px solid var(--enb-border); background: var(--enb-bg); border-radius: 8px; padding: 5px 8px; outline: none; }',
    '.search:focus { border-color: var(--enb-accent); }',
    '.toggle { display: flex; align-items: center; gap: 4px; color: var(--enb-muted); font-size: 12px; white-space: nowrap; }',
    '.side-actions { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--enb-border); flex-wrap: wrap; }',
    '.list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 10px 14px; }',
    '.group { margin-bottom: 4px; }',
    '.group-head { display: flex; align-items: center; gap: 6px; padding: 6px 4px; }',
    '.group-name { font-weight: 600; font-size: 12px; color: var(--enb-text); }',
    '.count { color: var(--enb-muted); font-size: 11px; background: var(--enb-hover); border-radius: 10px; padding: 0 6px; }',
    '.group-hosts { color: var(--enb-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }',
    '.mini { border: none; background: transparent; color: var(--enb-muted); padding: 0 4px; font-size: 12px; border-radius: 4px; }',
    '.mini:hover { background: var(--enb-hover); color: var(--enb-text); }',
    '.item { padding: 7px 8px; border-radius: 8px; }',
    '.item:hover { background: var(--enb-hover); }',
    '.item-text { word-break: break-word; }',
    '.item-note { color: var(--enb-muted); font-size: 12px; margin-top: 2px; white-space: pre-wrap; word-break: break-word; }',
    '.item-meta { color: var(--enb-muted); font-size: 11px; margin-top: 3px; }',
    '.item-actions { display: none; gap: 2px; margin-top: 5px; }',
    '.item:hover .item-actions, .item:focus-within .item-actions { display: flex; }',
    '.icon-btn { border: none; background: transparent; padding: 1px 5px; border-radius: 5px; font-size: 13px; line-height: 1.4; }',
    '.icon-btn:hover { background: var(--enb-accent-soft); }',
    '.item.flash { outline: 2px solid var(--enb-accent); outline-offset: -2px; }',
    '.empty { color: var(--enb-muted); padding: 18px 10px; text-align: center; }',
    '.empty p { margin: 0 0 6px; }',
    '.hint { color: var(--enb-muted); font-size: 12px; margin: 0; }',
    '.backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; pointer-events: auto; z-index: 2; }',
    '.manager { width: min(1080px, calc(100vw - 48px)); height: min(760px, calc(100vh - 48px)); }',
    '.manager-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--enb-border); flex-wrap: wrap; }',
    '.manager-title { font-weight: 600; font-size: 14px; }',
    '.manager-tools { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }',
    '.manager-body { display: grid; grid-template-columns: 280px 1fr; flex: 1; min-height: 0; }',
    '.groups { border-right: 1px solid var(--enb-border); overflow-y: auto; padding: 8px; min-height: 0; }',
    '.groups-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 8px; color: var(--enb-muted); font-size: 12px; }',
    '.group-list { list-style: none; margin: 0; padding: 0; }',
    '.group-row { position: relative; padding: 7px 8px; border-radius: 8px; cursor: pointer; }',
    '.group-row:hover { background: var(--enb-hover); }',
    '.group-row.active { background: var(--enb-accent-soft); }',
    '.gr-main { display: flex; align-items: center; gap: 6px; }',
    '.gr-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.gr-count { color: var(--enb-muted); font-size: 11px; }',
    '.gr-sub { color: var(--enb-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }',
    '.gr-edit { position: absolute; right: 6px; top: 6px; display: none; }',
    '.group-row:hover .gr-edit { display: block; }',
    '.items { display: flex; flex-direction: column; min-height: 0; min-width: 0; }',
    '.items-head { padding: 10px 14px; font-weight: 600; border-bottom: 1px solid var(--enb-border); }',
    '.items .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 12px 16px; }',
    '.capture { position: fixed; left: 50%; top: 12vh; transform: translateX(-50%); width: min(520px, calc(100vw - 32px)); z-index: 4; }',
    '.cap-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--enb-border); font-weight: 600; }',
    '#enb-capture-text { margin: 10px 12px 6px; width: calc(100% - 24px); resize: vertical; min-height: 66px; border: 1px solid var(--enb-border); background: var(--enb-bg); border-radius: 8px; padding: 6px 8px; outline: none; }',
    '#enb-capture-text:focus { border-color: var(--enb-accent); }',
    '.input { border: 1px solid var(--enb-border); background: var(--enb-bg); border-radius: 8px; padding: 6px 8px; outline: none; }',
    '.input:focus { border-color: var(--enb-accent); }',
    '#enb-capture-note { margin: 0 12px 6px; width: calc(100% - 24px); }',
    '.cap-row { padding: 0 12px 6px; }',
    '.select { width: 100%; border: 1px solid var(--enb-border); background: var(--enb-bg); border-radius: 8px; padding: 6px 8px; }',
    '.cap-newgroup { padding: 0 12px 6px; display: flex; flex-direction: column; gap: 6px; }',
    '.cap-newgroup .input { width: 100%; }',
    '.cap-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--enb-border); }',
    '.dialog { z-index: 5; }',
    '.dialog-panel { width: min(460px, calc(100vw - 32px)); }',
    '#enb-dialog-title { margin: 0; padding: 12px 14px; font-size: 14px; border-bottom: 1px solid var(--enb-border); }',
    '#enb-dialog-body { padding: 12px 14px; }',
    '#enb-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--enb-border); }',
    '.dialog-form { display: flex; flex-direction: column; gap: 10px; }',
    '.field { display: flex; flex-direction: column; gap: 4px; }',
    '.field-label { color: var(--enb-muted); font-size: 12px; }',
    '.dialog-msg { margin: 0; white-space: pre-wrap; }',
    '.file-input { display: none; }',
    '.toast { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 10px; background: #111827; color: #f9fafb; border-radius: 10px; padding: 9px 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); pointer-events: auto; max-width: min(440px, calc(100vw - 32px)); z-index: 6; }',
    '.toast .btn { background: transparent; color: #93c5fd; border-color: rgba(255, 255, 255, 0.25); }',
    '.toast .btn:hover { background: rgba(255, 255, 255, 0.1); }',
  ].join('\n');

  /* ================= 启动 ================= */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
