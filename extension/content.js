/*
 * English Notebook · content script
 * 页面内批注渲染、右侧批注栏、首次同步路径设置、与后台消息通信。
 */
(function () {
  'use strict';

  if (window.top !== window.self) return;

  const C = window.ENB;
  const R = C && C.Render;
  if (!C || !R) {
    console.warn('[English Notebook] core/render 未加载');
    return;
  }

  const HOST_ID = 'enb-ui-host';
  let shadow = null;
  let hostEl = null;

  let pageItems = [];
  let sync = { serverUp: false, configured: false, dataFile: '' };
  let panelOpen = false;
  let setupShown = false;
  let lastHref = location.href;
  let tickTimer = null;

  /* ---------------- 通信 ---------------- */

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    injectUi();
    bindUi();
    installHotkeys();
    installSpaWatcher();
    startTick();
    reloadPageState();
  }

  async function reloadPageState() {
    const resp = await send({ type: 'GET_PAGE_STATE', url: location.href, title: document.title });
    if (!resp || !resp.ok) return;
    pageItems = resp.items || [];
    if (resp.sync) sync = resp.sync;
    renderAnnotations();
    renderPanel();
    updateEdge();
    maybeShowSetup(resp.promptSetup);
  }

  function renderAnnotations() {
    try {
      R.applyAnnotations(document.body, pageItems, {
        exclude: '#' + HOST_ID,
        onClick: focusItem,
      });
      document.documentElement.setAttribute('data-enb', 'ready');
      document.documentElement.setAttribute('data-enb-count', String(pageItems.length));
    } catch (e) {
      console.warn('[English Notebook] 批注渲染失败', e);
    }
  }

  /* ---------------- UI ---------------- */

  function injectUi() {
    if (document.getElementById(HOST_ID)) return;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'all:initial;display:block;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    applyStyles(shadow);
    document.documentElement.appendChild(hostEl);
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
    qs('enb-panel-close').addEventListener('click', function () { togglePanel(false); });
    qs('enb-panel-settings').addEventListener('click', function () { send({ type: 'OPEN_OPTIONS' }); });
    qs('enb-open-options').addEventListener('click', function () { send({ type: 'OPEN_OPTIONS' }); });
    qs('enb-edge').addEventListener('click', function () { togglePanel(true); });
    qs('enb-setup-submit').addEventListener('click', submitSetup);
    qs('enb-setup-dismiss').addEventListener('click', dismissSetup);
    qs('enb-setup-path').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitSetup();
    });
    var setup = qs('enb-setup');
    setup.addEventListener('click', function (e) {
      if (e.target === setup) dismissSetup();
    });
  }

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
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, String(v));
    });
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(x); });
      else if (c.nodeType) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  }

  function toast(message) {
    const el = qs('enb-toast');
    qs('enb-toast-msg').textContent = String(message || '');
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* ---------------- 批注栏 ---------------- */

  function togglePanel(force) {
    panelOpen = force === undefined ? !panelOpen : !!force;
    const panel = qs('enb-panel');
    panel.hidden = !panelOpen;
    qs('enb-edge').hidden = panelOpen || !pageItems.length;
    if (panelOpen) renderPanel();
  }

  function updateEdge() {
    const edge = qs('enb-edge');
    if (!edge) return;
    edge.hidden = panelOpen || !pageItems.length;
    qs('enb-edge-count').textContent = '批注 ' + pageItems.length;
  }

  function depthOf(item) {
    let depth = 1;
    let cur = item;
    const byId = {};
    pageItems.forEach(function (it) { byId[it.id] = it; });
    const seen = new Set([item.id]);
    while (cur && cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      cur = byId[cur.parentId];
      if (cur) depth++;
    }
    return Math.min(depth, 20);
  }

  function sortedItems() {
    return pageItems.slice().sort(function (a, b) {
      const ra = R.getSpanRect(a.id, document.body);
      const rb = R.getSpanRect(b.id, document.body);
      if (ra && rb && Math.abs(ra.top - rb.top) > 1) return ra.top - rb.top;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  }

  function renderPanel() {
    const list = qs('enb-list');
    if (!list) return;
    list.textContent = '';
    qs('enb-panel-count').textContent = pageItems.length ? String(pageItems.length) : '';

    if (!pageItems.length) {
      list.appendChild(h('div', { class: 'empty' },
        h('p', { text: '这个页面还没有批注。' }),
        h('p', { class: 'hint', text: '选中英文句子 → 右键 → “翻译并记录”。在已有波浪线上再选短语，会生成嵌套彩色波浪线。' })
      ));
      return;
    }

    sortedItems().forEach(function (item) { list.appendChild(buildCard(item)); });
  }

  function buildCard(item) {
    const depth = depthOf(item);
    const color = R.colorForDepth(depth);
    const card = h('article', {
      class: 'card',
      dataset: { cardId: item.id },
    });
    card.style.marginLeft = ((depth - 1) * 10) + 'px';
    card.style.borderLeftColor = color.color;

    const quote = h('div', { class: 'quote', text: item.text });
    quote.style.cursor = 'pointer';
    quote.addEventListener('click', function () { focusItem(item.id); });

    const trans = h('div', {
      class: 'trans' + (item.translation ? '' : ' muted'),
      text: item.translation || '（暂无译文，点 ✎ 补充）',
    });
    card.appendChild(quote);
    card.appendChild(trans);
    if (item.note) card.appendChild(h('div', { class: 'note', text: item.note }));

    const actions = h('div', { class: 'actions' },
      actionBtn('🔊', '朗读', function () { speak(item.text); }),
      actionBtn('✎', '编辑译文', function () { toggleEditor(item, card); }),
      actionBtn('⌖', '定位到原文', function () { focusItem(item.id); }),
      actionBtn('🗑', '删除批注', function () { removeItem(item); })
    );
    card.appendChild(actions);

    const editor = h('div', { class: 'editor', hidden: 'hidden' },
      h('textarea', { class: 'editor-text', rows: '2', placeholder: '修改译文…' }),
      h('div', { class: 'editor-actions' },
        h('button', { class: 'btn primary small', text: '保存', onclick: function () { saveTranslation(item, card); } }),
        h('button', { class: 'btn small', text: '取消', onclick: function () { editor.hidden = true; } })
      )
    );
    card.appendChild(editor);
    return card;
  }

  function actionBtn(icon, title, handler) {
    return h('button', { class: 'icon-btn', text: icon, title: title, onclick: handler });
  }

  function toggleEditor(item, card) {
    const editor = card.querySelector('.editor');
    const textarea = card.querySelector('.editor-text');
    editor.hidden = !editor.hidden;
    if (!editor.hidden) {
      textarea.value = item.translation || '';
      textarea.focus();
    }
  }

  async function saveTranslation(item, card) {
    const textarea = card.querySelector('.editor-text');
    const resp = await send({ type: 'UPDATE_ITEM', id: item.id, patch: { translation: textarea.value.trim() } });
    if (resp && resp.ok) {
      toast('译文已更新');
      reloadPageState();
    } else {
      toast('保存失败：' + ((resp && resp.error) || '未知错误'));
    }
  }

  async function removeItem(item) {
    const ok = window.confirm('删除这条批注？它下面的嵌套批注会一起删除。');
    if (!ok) return;
    const resp = await send({ type: 'DELETE_ITEM', id: item.id });
    if (resp && resp.ok) {
      toast('已删除');
      reloadPageState();
    } else {
      toast('删除失败');
    }
  }

  function focusItem(itemId) {
    togglePanel(true);
    setTimeout(function () {
      const span = R.getSpan(itemId, document.body);
      if (span) {
        span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        span.classList.add('enb-flash');
        setTimeout(function () { span.classList.remove('enb-flash'); }, 1500);
      }
      const card = shadow.querySelector('[data-card-id="' + itemId + '"]');
      if (card) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        card.classList.add('active');
        setTimeout(function () { card.classList.remove('active'); }, 1500);
      }
    }, 60);
  }

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
    } catch (e) { toast('朗读失败'); }
  }

  /* ---------------- 首次同步路径设置 ---------------- */

  function maybeShowSetup(promptSetup) {
    if (setupShown || (sync && sync.configured)) return;
    if (!promptSetup) return;
    setupShown = true;
    showSetup();
    /* 后台把「已提示过」存 chrome.storage，之后所有页面/标签页都不再自动弹 */
    send({ type: 'MARK_SETUP_PROMPTED' });
  }

  function showSetup(message) {
    const modal = qs('enb-setup');
    modal.hidden = false;
    qs('enb-setup-error').textContent = message || '';
    const input = qs('enb-setup-path');
    if (!input.value && sync && sync.dataFile) input.value = sync.dataFile;
    setTimeout(function () { input.focus(); }, 30);
  }

  function dismissSetup() {
    qs('enb-setup').hidden = true;
    send({ type: 'MARK_SETUP_PROMPTED' });
    toast('之后可在扩展设置（Alt+M）里填写数据文件路径');
  }

  async function submitSetup() {
    const path = qs('enb-setup-path').value.trim();
    qs('enb-setup-error').textContent = '';
    const resp = await send({ type: 'SET_SYNC_PATH', dataFile: path });
    if (resp && resp.ok) {
      sync = resp.sync || { configured: true, dataFile: resp.dataFile };
      qs('enb-setup').hidden = true;
      toast('已连接同步服务：' + (resp.dataFile || path));
      reloadPageState();
    } else {
      qs('enb-setup-error').textContent = (resp && resp.error) || '连接失败';
    }
  }

  /* ---------------- 快捷键 / 导航 / 轮询 ---------------- */

  function installHotkeys() {
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!qs('enb-setup').hidden) { dismissSetup(); e.preventDefault(); return; }
        if (panelOpen) { togglePanel(false); e.preventDefault(); }
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.code === 'KeyO') { e.preventDefault(); togglePanel(); }
      else if (e.code === 'KeyM') { e.preventDefault(); send({ type: 'OPEN_OPTIONS' }); }
    }, true);
  }

  function installSpaWatcher() {
    setInterval(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      reloadPageState();
    }, 1500);
  }

  function startTick() {
    clearInterval(tickTimer);
    tickTimer = setInterval(async function () {
      if (document.visibilityState !== 'visible') return;
      const resp = await send({ type: 'SYNC_TICK' });
      if (resp && resp.ok) {
        if (resp.sync) sync = resp.sync;
        if (resp.changed) reloadPageState();
      }
    }, 6000);
  }

  /* ---------------- 后台消息 ---------------- */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message) return;
    if (message.type === 'REQUEST_CAPTURE') {
      sendResponse(R.captureSelection(document.body, window.getSelection(), '#' + HOST_ID));
      return;
    }
    if (message.type === 'STATE_UPDATED') {
      reloadPageState();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'ANNOTATION_ADDED') {
      reloadPageState().then(function () {
        if (message.itemId) focusItem(message.itemId);
      });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'SHOW_TOAST') {
      toast(message.message);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'TOGGLE_PANEL') {
      togglePanel();
      sendResponse({ ok: true });
    }
  });

  /* ---------------- 模板 / 样式 ---------------- */

  const TEMPLATE =
    '<div class="enb">' +
      '<button id="enb-edge" class="edge" hidden><span id="enb-edge-count">批注</span></button>' +
      '<aside id="enb-panel" class="panel" hidden>' +
        '<header class="panel-head">' +
          '<span class="panel-title">批注</span>' +
          '<span id="enb-panel-count" class="count"></span>' +
          '<button id="enb-panel-settings" class="icon" title="设置">⚙</button>' +
          '<button id="enb-panel-close" class="icon" title="关闭 (Esc)">✕</button>' +
        '</header>' +
        '<div id="enb-list" class="list"></div>' +
        '<footer class="panel-foot">' +
          '<button id="enb-open-options" class="btn small">设置 / 全部记录</button>' +
          '<span class="hint">Alt+O 开关 · Alt+M 设置</span>' +
        '</footer>' +
      '</aside>' +

      '<div id="enb-setup" class="backdrop" hidden>' +
        '<section class="dialog">' +
          '<h3>连接本地同步服务</h3>' +
          '<p class="hint">批注数据保存在一个 JSON 文件里，由本地同步服务写入并自动提交到 git。首次使用需要两步：</p>' +
          '<ol class="steps">' +
            '<li>双击 <code>sync-server\\start-sync.bat</code> 启动同步服务；</li>' +
            '<li>在下面填写该数据文件的绝对路径（文件不存在会自动创建）。</li>' +
          '</ol>' +
          '<input id="enb-setup-path" class="input" type="text" placeholder="例如 D:\\notes\\english-notes.json" />' +
          '<div id="enb-setup-error" class="error"></div>' +
          '<div class="dialog-actions">' +
            '<button id="enb-setup-submit" class="btn primary">连接并保存</button>' +
            '<button id="enb-setup-dismiss" class="btn">稍后</button>' +
          '</div>' +
        '</section>' +
      '</div>' +

      '<div id="enb-toast" class="toast" hidden><span id="enb-toast-msg"></span></div>' +
    '</div>';

  const CSS = [
    ':host {',
    '  --enb-bg: #ffffff;',
    '  --enb-text: #1f2328;',
    '  --enb-muted: #6b7280;',
    '  --enb-border: #e5e7eb;',
    '  --enb-hover: #f3f4f6;',
    '  --enb-accent: #2563eb;',
    '  --enb-accent-soft: #dbeafe;',
    '  --enb-danger: #dc2626;',
    '  --enb-shadow: 0 12px 40px rgba(15, 23, 42, 0.18);',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :host {',
    '    --enb-bg: #0f172a;',
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
    'input, textarea { font: inherit; color: inherit; }',
    '.edge {',
    '  position: fixed; right: 0; top: 38%; pointer-events: auto;',
    '  writing-mode: vertical-rl; text-orientation: mixed;',
    '  background: var(--enb-accent); color: #fff; border: none;',
    '  border-radius: 8px 0 0 8px; padding: 10px 5px; letter-spacing: 1px;',
    '  box-shadow: 0 4px 14px rgba(0,0,0,.18); font-size: 12px;',
    '}',
    '.panel {',
    '  position: fixed; top: 12px; right: 12px; bottom: 12px; width: 340px; max-width: calc(100vw - 24px);',
    '  background: var(--enb-bg); border: 1px solid var(--enb-border); border-radius: 12px;',
    '  box-shadow: var(--enb-shadow); pointer-events: auto; display: flex; flex-direction: column; overflow: hidden;',
    '}',
    '.panel-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--enb-border); }',
    '.panel-title { font-weight: 600; font-size: 14px; }',
    '.count { color: var(--enb-muted); font-size: 12px; background: var(--enb-hover); border-radius: 10px; padding: 0 6px; }',
    '.icon { border: none; background: transparent; color: var(--enb-muted); padding: 4px 6px; border-radius: 6px; font-size: 14px; line-height: 1; }',
    '.icon:hover { background: var(--enb-hover); color: var(--enb-text); }',
    '.panel-head .icon:first-of-type { margin-left: auto; }',
    '.list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px; }',
    '.card { background: var(--enb-bg); border: 1px solid var(--enb-border); border-left: 3px solid var(--enb-accent); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }',
    '.card.active { box-shadow: 0 0 0 2px var(--enb-accent-soft); }',
    '.quote { font-size: 13px; word-break: break-word; margin-bottom: 4px; }',
    '.trans { font-size: 13px; color: var(--enb-text); white-space: pre-wrap; word-break: break-word; }',
    '.trans.muted { color: var(--enb-muted); font-size: 12px; }',
    '.note { color: var(--enb-muted); font-size: 12px; margin-top: 2px; white-space: pre-wrap; }',
    '.actions { display: flex; gap: 2px; margin-top: 6px; opacity: .55; }',
    '.card:hover .actions { opacity: 1; }',
    '.icon-btn { border: none; background: transparent; padding: 1px 5px; border-radius: 5px; font-size: 13px; line-height: 1.4; }',
    '.icon-btn:hover { background: var(--enb-accent-soft); }',
    '.editor { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }',
    '.editor-text { width: 100%; border: 1px solid var(--enb-border); border-radius: 6px; padding: 6px 8px; background: var(--enb-bg); resize: vertical; min-height: 48px; outline: none; }',
    '.editor-text:focus { border-color: var(--enb-accent); }',
    '.editor-actions { display: flex; gap: 6px; justify-content: flex-end; }',
    '.btn { border: 1px solid var(--enb-border); background: var(--enb-bg); color: var(--enb-text); border-radius: 7px; padding: 5px 10px; }',
    '.btn:hover { background: var(--enb-hover); }',
    '.btn.primary { background: var(--enb-accent); border-color: var(--enb-accent); color: #fff; }',
    '.btn.small { padding: 2px 8px; font-size: 12px; }',
    '.empty { color: var(--enb-muted); padding: 16px 8px; text-align: center; }',
    '.empty p { margin: 0 0 6px; }',
    '.hint { color: var(--enb-muted); font-size: 12px; margin: 0; }',
    '.panel-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--enb-border); }',
    '.backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, .5); display: flex; align-items: center; justify-content: center; pointer-events: auto; }',
    '.dialog { width: min(480px, calc(100vw - 32px)); background: var(--enb-bg); border-radius: 12px; padding: 16px; box-shadow: var(--enb-shadow); }',
    '.dialog h3 { margin: 0 0 8px; font-size: 15px; }',
    '.dialog .steps { margin: 8px 0 12px; padding-left: 18px; color: var(--enb-muted); font-size: 12px; }',
    '.dialog .steps li { margin-bottom: 4px; }',
    '.dialog code { background: var(--enb-hover); padding: 1px 4px; border-radius: 4px; }',
    '.input { width: 100%; border: 1px solid var(--enb-border); border-radius: 8px; padding: 8px 10px; background: var(--enb-bg); outline: none; }',
    '.input:focus { border-color: var(--enb-accent); }',
    '.error { color: var(--enb-danger); font-size: 12px; min-height: 16px; margin: 6px 0 2px; }',
    '.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }',
    '.toast { position: fixed; right: 16px; bottom: 16px; background: #111827; color: #f9fafb; border-radius: 10px; padding: 10px 14px; box-shadow: 0 10px 30px rgba(0,0,0,.25); pointer-events: auto; max-width: min(420px, calc(100vw - 32px)); }',
  ].join('\n');

  /* ---------------- 启动 ---------------- */

  init();
})();
