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
  let anchorRetry = 0;
  let sync = { serverUp: false, configured: false, dataFile: '' };
  let fileStatus = { configured: false, name: '', permission: 'none' };
  let panelOpen = false;
  let setupShown = false;
  let lastHref = location.href;
  let tickTimer = null;

  /* AI 审查产生的学习条目：只存在本地，不参与 git 同步 */
  let studyReviews = {};
  let studyItems = [];
  let reviewOpen = false;
  let reviewFilter = 'all';
  let reviewIndex = 0;
  let reviewRevealed = false;

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

  /* 内置 PDF 阅读器会用 __ENB_PAGE_URL 把批注绑定到 PDF 本身，而不是 viewer URL */
  function pageUrl() {
    return (window.__ENB_PAGE_URL && typeof window.__ENB_PAGE_URL === 'string')
      ? window.__ENB_PAGE_URL
      : location.href;
  }

  function pageTitle() {
    return (window.__ENB_PAGE_TITLE && typeof window.__ENB_PAGE_TITLE === 'string')
      ? window.__ENB_PAGE_TITLE
      : document.title;
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    injectUi();
    bindUi();
    installHotkeys();
    installSpaWatcher();
    startTick();
    reloadPageState();
    loadStudyData();
    initVoices();
    try {
      document.documentElement.setAttribute('data-enb-ext', chrome.runtime.id || '');
    } catch (e) { /* ignore */ }
    window.addEventListener('enb-rerender', function () {
      anchorRetry = 0;
      reloadPageState();
    });
  }

  async function reloadPageState() {
    const resp = await send({ type: 'GET_PAGE_STATE', url: pageUrl(), title: pageTitle() });
    if (!resp || !resp.ok) return;
    pageItems = resp.items || [];
    if (resp.sync) sync = resp.sync;
    if (resp.file) fileStatus = resp.file;
    renderAnnotations();
    renderPanel();
    updateEdge();
    maybePromptFile(resp.promptSetup);

    /* PDF 文字层渲染/字体加载是异步的，锚点第一次可能没匹配上；有限次数重试 */
    if (pageItems.length && anchorRetry < 3) {
      const missed = pageItems.some(function (item) {
        return !R.getSpan(item.id, document.body);
      });
      if (missed) {
        anchorRetry++;
        setTimeout(reloadPageState, 500);
      } else {
        anchorRetry = 0;
      }
    }
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
    /* 鼠标在批注栏上滚动时，把滚轮交给页面，卡片才能跟着正文一起动 */
    var panel = qs('enb-panel');
    panel.addEventListener('wheel', function (e) {
      e.preventDefault();
      var unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? window.innerHeight : 1);
      window.scrollBy(0, e.deltaY * unit);
    }, { passive: false });

    /* 常驻气泡 + 复习面板 */
    qs('enb-bubble').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleBubbleMenu();
    });
    qs('enb-bubble-menu').addEventListener('click', function (e) {
      var act = e.target.closest('button[data-act]');
      if (!act) return;
      hideBubbleMenu();
      if (act.dataset.act === 'review') openReviewPanel();
      else if (act.dataset.act === 'panel') togglePanel(true);
      else if (act.dataset.act === 'capture') send({ type: 'TRANSLATE_SELECTION' });
      else if (act.dataset.act === 'options') send({ type: 'OPEN_OPTIONS' });
    });
    qs('enb-review-close').addEventListener('click', closeReviewPanel);
    qs('enb-review-settings').addEventListener('click', function () { send({ type: 'OPEN_OPTIONS' }); });
    qs('enb-review-filters').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      reviewFilter = chip.dataset.type;
      reviewIndex = 0;
      reviewRevealed = false;
      renderReviewPanel();
    });
    document.addEventListener('click', function (e) {
      var menu = qs('enb-bubble-menu');
      if (!menu || menu.hidden) return;
      var path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.indexOf(qs('enb-bubble')) === -1 && path.indexOf(menu) === -1) hideBubbleMenu();
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
      else if (k === 'dataset') {
        Object.keys(v).forEach(function (name) { el.dataset[name] = v[name]; });
      } else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
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
    if (panelOpen) {
      closeReviewPanel();
      renderPanel();
    }
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
    list.appendChild(h('div', { class: 'scroll-hint', text: '当前视口没有批注，滚动页面查看' }));
    scheduleLayout();
  }

  /* ---------------- 学习条目 / 复习 / AI 审查 ---------------- */

  async function loadStudyData() {
    const resp = await send({ type: 'GET_STUDY_DATA' });
    if (!resp || !resp.ok) return;
    studyReviews = resp.reviews || {};
    studyItems = resp.items || [];
    renderBubbleBadge();
    if (panelOpen) renderPanel();
    if (reviewOpen) renderReviewPanel();
  }

  function renderBubbleBadge() {
    const badge = qs('enb-bubble-badge');
    if (!badge) return;
    const n = studyItems.length;
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }

  function toggleBubbleMenu(force) {
    const menu = qs('enb-bubble-menu');
    if (!menu) return;
    menu.hidden = force === undefined ? !menu.hidden : !force;
  }

  function hideBubbleMenu() {
    const menu = qs('enb-bubble-menu');
    if (menu) menu.hidden = true;
  }

  function openReviewPanel() {
    reviewOpen = true;
    reviewFilter = 'all';
    reviewIndex = 0;
    reviewRevealed = false;
    hideBubbleMenu();
    togglePanel(false);
    qs('enb-review').hidden = false;
    loadStudyData();
    renderReviewPanel();
  }

  function closeReviewPanel() {
    reviewOpen = false;
    const el = qs('enb-review');
    if (el) el.hidden = true;
  }

  function typeLabel(type) {
    return type === 'word' ? '单词' : type === 'phrase' ? '词组' : type === 'usage' ? '固定用法' : '知识点';
  }

  function reviewList() {
    return reviewFilter === 'all' ? studyItems : studyItems.filter(function (it) { return it.type === reviewFilter; });
  }

  function renderReviewPanel() {
    if (!reviewOpen) return;
    const body = qs('enb-review-body');
    if (!body) return;
    const filters = qs('enb-review-filters');
    Array.prototype.forEach.call(filters.querySelectorAll('.chip'), function (chip) {
      chip.classList.toggle('active', chip.dataset.type === reviewFilter);
    });
    const list = reviewList();
    qs('enb-review-count').textContent = list.length ? String(list.length) : '';
    body.textContent = '';
    if (!list.length) {
      body.appendChild(h('div', { class: 'empty' },
        h('p', { text: reviewFilter === 'all' ? '还没有学习条目。' : '这个分类下还没有条目。' }),
        h('p', { class: 'hint', text: '在批注卡片里点 🧠，写下你的翻译让 AI 审查，就会自动提取单词 / 词组 / 固定用法到这里。' })
      ));
      return;
    }
    reviewIndex = ((reviewIndex % list.length) + list.length) % list.length;
    const item = list[reviewIndex];
    const card = h('div', { class: 'flashcard' });
    card.appendChild(h('div', { class: 'flash-type', text: typeLabel(item.type) }));
    const flashRow = h('div', { class: 'flash-text-row' },
      h('span', { class: 'flash-text', text: item.text }),
      h('button', { class: 'speak-btn', text: '🔊 美音', title: '朗读（美式发音）', onclick: function () { speak(item.text); } })
    );
    card.appendChild(flashRow);
    if (reviewRevealed) {
      card.appendChild(h('div', { class: 'flash-meaning', text: item.meaning || '（AI 没有给释义）' }));
      if (item.note) card.appendChild(h('div', { class: 'flash-note', text: item.note }));
    }
    const actions = h('div', { class: 'flash-actions' });
    if (!reviewRevealed) {
      actions.appendChild(h('button', {
        class: 'btn primary small',
        text: '显示答案',
        onclick: function () { reviewRevealed = true; renderReviewPanel(); },
      }));
    } else {
      actions.appendChild(h('button', {
        class: 'btn primary small',
        text: '已记住，下一个',
        onclick: function () { markReviewed(item.id); },
      }));
      actions.appendChild(h('button', {
        class: 'btn small',
        text: '再看一次',
        onclick: function () { reviewRevealed = false; renderReviewPanel(); },
      }));
    }
    actions.appendChild(h('button', {
      class: 'btn small',
      text: '下一个',
      onclick: function () { reviewIndex++; reviewRevealed = false; renderReviewPanel(); },
    }));
    card.appendChild(actions);
    card.appendChild(h('div', {
      class: 'flash-progress',
      text: (reviewIndex + 1) + ' / ' + list.length + ' · 本地保存，不参与 git 同步',
    }));
    body.appendChild(card);
  }

  async function markReviewed(id) {
    await send({ type: 'MARK_STUDY_REVIEWED', ids: [id] });
    reviewIndex++;
    reviewRevealed = false;
    await loadStudyData();
    renderReviewPanel();
  }

  function buildReviewBlock(review) {
    const block = h('div', { class: 'ai-review' });
    const verdictClass = review.verdict === '准确' ? ' ok' : review.verdict === '不准确' ? ' bad' : '';
    block.appendChild(h('div', { class: 'ai-verdict' + verdictClass, text: 'AI 审查：' + (review.verdict || '基本准确') }));
    if (review.feedback) block.appendChild(h('div', { class: 'ai-feedback', text: review.feedback }));
    const items = studyItems.filter(function (it) { return it.sourceItemId === review.itemId; });
    if (items.length) {
      const list = h('div', { class: 'ai-items' });
      items.forEach(function (it) {
        list.appendChild(h('div', { class: 'ai-item' },
          h('span', { class: 'ai-type', text: typeLabel(it.type) }),
          h('span', { class: 'ai-text', text: it.text }),
          h('button', { class: 'icon-btn ai-speak', text: '🔊', title: '朗读', onclick: function () { speak(it.text); } }),
          h('span', { class: 'ai-meaning', text: it.meaning || '' })
        ));
      });
      block.appendChild(list);
    }
    return block;
  }

  function openAIReviewEditor(item, card) {
    let box = card.querySelector('.ai-box');
    if (!box) {
      const ta = h('textarea', { class: 'ai-text', rows: '2', placeholder: '先写下你的中文翻译，AI 会审查并提取你不熟悉的单词 / 词组 / 固定用法' });
      const status = h('div', { class: 'ai-status' });
      const submit = h('button', { class: 'btn primary small', text: '让 AI 审查' });
      submit.addEventListener('click', function () { submitAIReview(item, card, ta, status); });
      const cancel = h('button', { class: 'btn small', text: '取消', onclick: function () { box.hidden = true; scheduleLayout(); } });
      box = h('div', { class: 'ai-box' },
        ta,
        h('div', { class: 'editor-actions' }, submit, cancel),
        status
      );
      card.appendChild(box);
    }
    box.hidden = false;
    const ta = box.querySelector('.ai-text');
    const review = studyReviews[item.id];
    ta.value = review && review.userTranslation ? review.userTranslation : '';
    box.querySelector('.ai-status').textContent = '';
    ta.focus();
    scheduleLayout();
  }

  async function submitAIReview(item, card, textarea, statusEl) {
    const userTranslation = textarea.value.trim();
    if (!userTranslation) { toast('先写一下你的翻译'); return; }
    statusEl.textContent = 'AI 正在审查，请稍候…';
    const resp = await send({
      type: 'REVIEW_TRANSLATION',
      itemId: item.id,
      pageUrl: pageUrl(),
      pageTitle: pageTitle(),
      text: item.text,
      userTranslation: userTranslation,
    });
    if (!resp || !resp.ok) {
      statusEl.textContent = '审查失败：' + ((resp && resp.error) || '未知错误');
      return;
    }
    toast('AI 审查完成，学习条目已保存到本地');
    await loadStudyData();
  }

  /* ---------------- 跟随滚动的边栏定位 ---------------- */

  let layoutTimer = null;

  function scheduleLayout() {
    if (!panelOpen || layoutTimer) return;
    layoutTimer = setTimeout(function () {
      layoutTimer = null;
      layoutComments();
    }, 16);
  }

  function layoutComments() {
    if (!panelOpen) return;
    const list = qs('enb-list');
    if (!list) return;
    const cards = Array.prototype.slice.call(list.querySelectorAll('.card'));
    if (!cards.length) return;

    const listRect = list.getBoundingClientRect();
    const entries = cards.map(function (card) {
      const span = R.getSpan(card.dataset.cardId, document.body);
      const rect = span ? span.getBoundingClientRect() : null;
      return {
        card: card,
        height: card.offsetHeight || 60,
        anchorTop: rect ? rect.top - listRect.top : null,
      };
    });

    const positioned = entries.filter(function (entry) { return entry.anchorTop !== null; })
      .sort(function (a, b) { return a.anchorTop - b.anchorTop; });

    let cursor = -1e9;
    let visible = 0;
    positioned.forEach(function (entry) {
      let top = entry.anchorTop - 2;
      if (cursor > -1e8) top = Math.max(top, cursor + 8);
      entry.card.style.top = Math.round(top) + 'px';
      entry.card.style.display = '';
      cursor = top + entry.height;
      if (top + entry.height > 0 && top < listRect.height) visible++;
    });

    entries.forEach(function (entry) {
      if (entry.anchorTop === null) {
        /* 锚点找不到（常见于 PDF 文字层/页面已改版），不要隐藏卡片，否则批注栏会看起来是空的 */
        entry.card.style.display = '';
      }
    });

    /* 没有锚点的卡片按顺序堆叠显示，至少保证能阅读/编辑批注 */
    const unanchored = entries.filter(function (entry) { return entry.anchorTop === null; });
    if (unanchored.length) {
      let top = 8;
      if (positioned.length) {
        const last = positioned[positioned.length - 1];
        top = (parseFloat(last.card.style.top) || 0) + last.height + 12;
      }
      unanchored.forEach(function (entry) {
        entry.card.style.top = Math.round(top) + 'px';
        top += entry.height + 10;
        visible++;
      });
    }

    const hint = list.querySelector('.scroll-hint');
    if (hint) hint.hidden = visible > 0;
  }

  window.addEventListener('scroll', scheduleLayout, { passive: true });
  window.addEventListener('resize', scheduleLayout);
  setInterval(function () {
    if (panelOpen) scheduleLayout();
  }, 1200);

  function buildDictionaryBlock(dict) {
    const block = h('div', { class: 'dict-block' });
    const head = h('div', { class: 'dict-head' });
    head.appendChild(h('span', { class: 'dict-badge', text: 'AI 词典' }));
    if (dict.phonetic) head.appendChild(h('span', { class: 'dict-phonetic', text: dict.phonetic }));
    if (dict.partOfSpeech) head.appendChild(h('span', { class: 'dict-pos', text: dict.partOfSpeech }));
    block.appendChild(head);
    (dict.senses || []).forEach(function (sense) {
      const row = h('div', { class: 'dict-sense' });
      if (sense.zh) row.appendChild(h('div', { class: 'dict-zh', text: sense.zh }));
      if (sense.en) row.appendChild(h('div', { class: 'dict-en', text: sense.en }));
      if (sense.example) {
        row.appendChild(h('div', { class: 'dict-example' },
          h('button', { class: 'icon-btn dict-speak', text: '🔊', title: '朗读例句', onclick: function () { speak(sense.example); } }),
          h('span', { text: sense.example })
        ));
      }
      if (sense.exampleZh) row.appendChild(h('div', { class: 'dict-example-zh', text: sense.exampleZh }));
      block.appendChild(row);
    });
    return block;
  }

  function buildCard(item) {
    const depth = depthOf(item);
    const color = R.colorForDepth(depth);
    const card = h('article', {
      class: 'card',
      dataset: { cardId: item.id },
    });
    card.style.left = (10 + (depth - 1) * 10) + 'px';
    card.style.borderLeftColor = color.color;

    const quoteRow = h('div', { class: 'quote-row' });
    const quote = h('span', { class: 'quote', text: item.text });
    quote.addEventListener('click', function () { focusItem(item.id); });
    const speakBtn = h('button', { class: 'speak-btn', text: '🔊 美音', title: '朗读（美式发音）' });
    speakBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      speak(item.text);
    });
    quoteRow.appendChild(quote);
    quoteRow.appendChild(speakBtn);
    card.appendChild(quoteRow);

    const trans = h('div', {
      class: 'trans' + (item.translation ? '' : ' muted'),
      text: item.translation || '（暂无译文，点 ✎ 补充）',
    });
    card.appendChild(trans);
    if (item.dictionary) card.appendChild(buildDictionaryBlock(item.dictionary));
    if (item.note) card.appendChild(h('div', { class: 'note', text: item.note }));

    const actions = h('div', { class: 'actions' },
      actionBtn('✎', '编辑译文', function () { toggleEditor(item, card); }),
      actionBtn('⌖', '定位到原文', function () { focusItem(item.id); }),
      actionBtn('🧠', '我译 + AI 审查', function () { openAIReviewEditor(item, card); }),
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
    const review = studyReviews[item.id];
    if (review) card.appendChild(buildReviewBlock(review));
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
    setTimeout(scheduleLayout, 0);
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

  /* ---------------- 美音朗读 ---------------- */

  let cachedVoices = [];

  function loadVoices() {
    const synth = window.speechSynthesis;
    if (!synth) return;
    cachedVoices = synth.getVoices() || [];
  }

  function initVoices() {
    const synth = window.speechSynthesis;
    if (!synth) return;
    loadVoices();
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', loadVoices);
    }
  }

  /** 优先挑 en-US 的 Natural/在线语音（Edge 的 Microsoft Aria/Guy 等），退化为任意 en-US。 */
  function pickUSVoice() {
    const synth = window.speechSynthesis;
    if (!synth) return null;
    const voices = cachedVoices.length ? cachedVoices : (synth.getVoices() || []);
    let best = null;
    let bestScore = 0;
    voices.forEach(function (voice) {
      const lang = String(voice.lang || '').toLowerCase();
      const name = String(voice.name || '').toLowerCase();
      let score = 0;
      if (lang === 'en-us') score += 100;
      else if (lang.indexOf('en-us') === 0) score += 90;
      else if (lang.indexOf('en') === 0) score += 10;
      if (name.indexOf('natural') !== -1) score += 60;
      if (name.indexOf('online') !== -1) score += 20;
      if (name.indexOf('google us english') !== -1) score += 40;
      if (name.indexOf('aria') !== -1 || name.indexOf('guy') !== -1 || name.indexOf('jenny') !== -1 ||
          name.indexOf('ana') !== -1 || name.indexOf('michelle') !== -1) score += 30;
      if (voice.localService === false) score += 5;
      if (voice.default) score += 2;
      if (score > bestScore) { bestScore = score; best = voice; }
    });
    return bestScore > 0 ? best : null;
  }

  function speak(text) {
    const synth = window.speechSynthesis;
    const Utter = window.SpeechSynthesisUtterance;
    if (!synth || !Utter) { toast('当前浏览器不支持朗读'); return; }
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try {
      synth.cancel();
      const u = new Utter(clean);
      const voice = pickUSVoice();
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang || 'en-US';
      } else {
        u.lang = 'en-US';
      }
      u.rate = 0.92;
      u.pitch = 1;
      synth.speak(u);
    } catch (e) {
      toast('朗读失败');
    }
  }

  /* ---------------- 数据文件提示 ---------------- */

  function maybePromptFile(prompt) {
    if (!prompt || setupShown) return;
    setupShown = true;
    send({ type: 'MARK_SETUP_PROMPTED' });
    toast('尚未选择数据文件：点扩展图标 → 设置 → 选择数据文件（数据会直接写入该文件）');
  }

  /* ---------------- 快捷键 / 导航 / 轮询 ---------------- */

  function installHotkeys() {
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (reviewOpen) { closeReviewPanel(); e.preventDefault(); return; }
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
      const resp = await send({ type: 'FILE_TICK' });
      if (resp && resp.ok) {
        if (resp.file) fileStatus = resp.file;
        if (resp.changed) reloadPageState();
      }
    }, 6000);
  }

  /* ---------------- 后台消息 ---------------- */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message) return;
    if (message.type === 'REQUEST_CAPTURE') {
      const capture = R.captureSelection(document.body, window.getSelection(), '#' + HOST_ID);
      if (capture) {
        capture.pageUrl = pageUrl();
        capture.pageTitle = pageTitle();
      }
      sendResponse(capture);
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
    if (message.type === 'STUDY_UPDATED') {
      loadStudyData();
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

      '<aside id="enb-review" class="panel review" hidden>' +
        '<header class="panel-head">' +
          '<span class="panel-title">复习</span>' +
          '<span id="enb-review-count" class="count"></span>' +
          '<button class="icon" id="enb-review-settings" title="设置">⚙</button>' +
          '<button class="icon" id="enb-review-close" title="关闭 (Esc)">✕</button>' +
        '</header>' +
        '<div id="enb-review-filters" class="review-filters">' +
          '<button class="chip active" data-type="all">全部</button>' +
          '<button class="chip" data-type="word">单词</button>' +
          '<button class="chip" data-type="phrase">词组</button>' +
          '<button class="chip" data-type="usage">固定用法</button>' +
        '</div>' +
        '<div id="enb-review-body" class="review-body"></div>' +
        '<footer class="panel-foot"><span class="hint">来自 AI 审查 · 仅本地保存，不参与 git 同步</span></footer>' +
      '</aside>' +

      '<button id="enb-bubble" class="bubble" title="English Notebook">📚<span id="enb-bubble-badge" class="bubble-badge" hidden></span></button>' +
      '<div id="enb-bubble-menu" class="bubble-menu" hidden>' +
        '<button data-act="capture">📌 记录选中</button>' +
        '<button data-act="review">📖 复习</button>' +
        '<button data-act="panel">📝 批注栏</button>' +
        '<button data-act="options">⚙ 设置 / 选择数据文件</button>' +
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
    '#enb-panel { z-index: 1; }',
    '.review { position: fixed; top: 12px; right: 12px; bottom: 12px; width: 370px; max-width: calc(100vw - 24px); z-index: 2; }',
    '.bubble {',
    '  position: fixed; right: 18px; bottom: 18px; width: 48px; height: 48px; border-radius: 50%; border: none;',
    '  background: var(--enb-accent); color: #fff; font-size: 20px; line-height: 1; padding: 0;',
    '  box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: auto; z-index: 4;',
    '}',
    '.bubble-badge {',
    '  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; border-radius: 9px;',
    '  background: var(--enb-danger); color: #fff; font-size: 10px; line-height: 18px; padding: 0 4px;',
    '}',
    '.bubble-menu {',
    '  position: fixed; right: 18px; bottom: 76px; width: 150px; display: flex; flex-direction: column; gap: 2px;',
    '  padding: 6px; background: var(--enb-bg); border: 1px solid var(--enb-border); border-radius: 10px;',
    '  box-shadow: var(--enb-shadow); z-index: 5; pointer-events: auto;',
    '}',
    '.bubble-menu button { border: none; background: transparent; text-align: left; padding: 8px 10px; border-radius: 6px; }',
    '.bubble-menu button:hover { background: var(--enb-hover); }',
    '.review-filters { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--enb-border); flex-wrap: wrap; }',
    '.chip { border: 1px solid var(--enb-border); background: var(--enb-bg); border-radius: 999px; padding: 2px 10px; font-size: 12px; }',
    '.chip.active { background: var(--enb-accent); border-color: var(--enb-accent); color: #fff; }',
    '.review-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px; }',
    '.flashcard { border: 1px solid var(--enb-border); border-radius: 10px; padding: 14px; }',
    '.flash-type { color: var(--enb-muted); font-size: 12px; }',
    '.flash-text-row { display: flex; align-items: center; gap: 8px; margin: 6px 0 12px; }',
    '.flash-text { flex: 1; font-size: 20px; font-weight: 600; word-break: break-word; }',
    '.flash-meaning { font-size: 14px; margin-bottom: 6px; }',
    '.flash-note { color: var(--enb-muted); font-size: 12px; }',
    '.flash-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }',
    '.flash-progress { color: var(--enb-muted); font-size: 11px; margin-top: 10px; }',
    '.ai-box { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }',
    '.ai-text { width: 100%; border: 1px solid var(--enb-border); border-radius: 6px; padding: 6px 8px; background: var(--enb-bg); resize: vertical; min-height: 48px; outline: none; }',
    '.ai-status { font-size: 12px; color: var(--enb-muted); white-space: pre-wrap; }',
    '.ai-review { margin-top: 8px; border-top: 1px dashed var(--enb-border); padding-top: 8px; }',
    '.ai-verdict { font-size: 12px; font-weight: 600; }',
    '.ai-verdict.ok { color: #10b981; }',
    '.ai-verdict.bad { color: var(--enb-danger); }',
    '.ai-feedback { font-size: 12px; color: var(--enb-muted); white-space: pre-wrap; margin-top: 2px; }',
    '.ai-items { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }',
    '.ai-item { display: flex; gap: 6px; align-items: baseline; font-size: 12px; }',
    '.ai-type { color: var(--enb-muted); border: 1px solid var(--enb-border); border-radius: 4px; padding: 0 4px; font-size: 10px; }',
    '.ai-item .ai-text { border: none; background: transparent; padding: 0; min-height: 0; width: auto; font-size: 12px; font-weight: 600; }',
    '.ai-meaning { color: var(--enb-muted); }',
    '.ai-speak { font-size: 11px; padding: 1px 4px; }',
    '.backdrop { z-index: 8; }',
    '.toast { z-index: 9; }',
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
    '.list { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 0; }',
    '.card { position: absolute; left: 10px; right: 10px; will-change: top; background: var(--enb-bg); border: 1px solid var(--enb-border); border-left: 3px solid var(--enb-accent); border-radius: 8px; padding: 8px 10px; }',
    '.card.active { box-shadow: 0 0 0 2px var(--enb-accent-soft); }',
    '.quote-row { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 4px; }',
    '.quote { flex: 1; font-size: 13px; word-break: break-word; cursor: pointer; }',
    '.speak-btn { flex: none; border: 1px solid var(--enb-border); background: transparent; color: var(--enb-accent); border-radius: 6px; padding: 1px 6px; font-size: 11px; line-height: 1.6; white-space: nowrap; }',
    '.speak-btn:hover { background: var(--enb-accent-soft); }',
    '.dict-block { margin-top: 6px; border-top: 1px dashed var(--enb-border); padding-top: 6px; font-size: 12px; }',
    '.dict-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }',
    '.dict-badge { font-size: 10px; border: 1px solid var(--enb-border); border-radius: 4px; padding: 0 4px; color: var(--enb-muted); }',
    '.dict-phonetic { color: var(--enb-accent); }',
    '.dict-pos { color: var(--enb-muted); }',
    '.dict-sense { margin: 4px 0; padding-left: 6px; border-left: 2px solid var(--enb-hover); }',
    '.dict-zh { font-weight: 600; }',
    '.dict-en { color: var(--enb-muted); }',
    '.dict-example { display: flex; align-items: flex-start; gap: 4px; margin-top: 2px; }',
    '.dict-example-zh { color: var(--enb-muted); font-size: 11px; }',
    '.dict-speak { font-size: 10px; padding: 0 3px; }',
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
    '.empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--enb-muted); padding: 16px; text-align: center; }',
    '.empty p { margin: 0 0 6px; }',
    '.scroll-hint { position: absolute; left: 20px; right: 20px; top: 50%; transform: translateY(-50%); text-align: center; color: var(--enb-muted); font-size: 12px; pointer-events: none; }',
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
    '.toast { position: fixed; right: 16px; bottom: 80px; background: #111827; color: #f9fafb; border-radius: 10px; padding: 10px 14px; box-shadow: 0 10px 30px rgba(0,0,0,.25); pointer-events: auto; max-width: min(420px, calc(100vw - 32px)); }',
  ].join('\n');

  /* ---------------- 启动 ---------------- */

  init();
})();
