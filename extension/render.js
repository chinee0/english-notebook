/*
 * English Notebook · annotation renderer
 * 只做 DOM 批注渲染与选区采集，不依赖 chrome API，便于在普通页面做冒烟测试。
 * 用法：<script src="core.js"></script><script src="render.js"></script>
 *       ENB.Render.applyAnnotations(document.body, items, {...})
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.ENB = root.ENB || {};
    root.ENB.Render = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLASS = 'enb-ann';
  const COLORS = [
    { name: 'amber', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.14)' },
    { name: 'green', color: '#10b981', bg: 'rgba(16, 185, 129, 0.14)' },
    { name: 'blue', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.14)' },
    { name: 'purple', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.14)' },
    { name: 'pink', color: '#ec4899', bg: 'rgba(236, 72, 153, 0.14)' },
    { name: 'cyan', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.14)' },
  ];

  const SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'PRE', 'CODE', 'KBD', 'SAMP', 'SVG', 'MATH', 'IFRAME', 'CANVAS', 'VIDEO'];

  function colorForDepth(depth) {
    const d = Math.max(1, Number(depth) || 1);
    return COLORS[(d - 1) % COLORS.length];
  }

  function collapse(str) {
    return String(str === null || str === undefined ? '' : str).replace(/\s+/g, ' ').trim();
  }

  function skipElement(el, exclude) {
    if (!el) return true;
    if (SKIP_TAGS.indexOf(el.tagName) !== -1) return true;
    if (el.isContentEditable) return true;
    if (exclude && el.closest && el.closest(exclude)) return true;
    return false;
  }

  function textNodes(root, exclude) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return skipElement(node.parentElement, exclude) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  /* 把页面文本节点拼成「规范化字符串」（连续空白折叠为单空格），并保留每个字符到原始节点的映射 */
  function buildIndex(root, exclude) {
    const nodes = textNodes(root, exclude);
    const chars = [];
    let prevSpace = true;
    nodes.forEach(function (node) {
      const v = node.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const ch = v.charAt(i);
        if (/\s/.test(ch)) {
          if (prevSpace) {
            const last = chars[chars.length - 1];
            if (last && last.ch === ' ' && last.node === node) last.end = i + 1;
            continue;
          }
          chars.push({ ch: ' ', node: node, start: i, end: i + 1 });
          prevSpace = true;
        } else {
          chars.push({ ch: ch, node: node, start: i, end: i + 1 });
          prevSpace = false;
        }
      }
    });
    while (chars.length && chars[chars.length - 1].ch === ' ') chars.pop();
    return { chars: chars, text: chars.map(function (c) { return c.ch; }).join('') };
  }

  function findTextRange(root, rawText, occurrence, exclude) {
    const needle = collapse(rawText);
    if (!needle) return null;
    const idx = buildIndex(root, exclude);
    let from = 0;
    let count = 0;
    let pos = -1;
    while (true) {
      const i = idx.text.indexOf(needle, from);
      if (i === -1) break;
      if (count === (Number(occurrence) || 0)) { pos = i; break; }
      count++;
      from = i + 1;
    }
    if (pos < 0) return null;
    const start = idx.chars[pos];
    const end = idx.chars[pos + needle.length - 1];
    if (!start || !end) return null;
    return { startNode: start.node, startOffset: start.start, endNode: end.node, endOffset: end.end };
  }

  function countBefore(root, rawText, node, offset, exclude) {
    const needle = collapse(rawText);
    if (!needle) return 0;
    const idx = buildIndex(root, exclude);
    let charIndex = idx.chars.length;
    for (let i = 0; i < idx.chars.length; i++) {
      const c = idx.chars[i];
      if (c.node === node && c.start >= offset) { charIndex = i; break; }
    }
    let count = 0;
    let from = 0;
    while (true) {
      const i = idx.text.indexOf(needle, from);
      if (i === -1 || i + needle.length > charIndex) break;
      count++;
      from = i + 1;
    }
    return count;
  }

  function commonAncestor(a, b) {
    let cur = a;
    while (cur && !cur.contains(b)) cur = cur.parentNode;
    return cur;
  }

  function wrapRange(startNode, startOffset, endNode, endOffset, opts) {
    const spans = [];

    function wrapNode(node) {
      if (!node || !node.nodeValue || !node.nodeValue.trim()) return null;
      const span = document.createElement('span');
      span.className = CLASS;
      span.dataset.annId = opts.id;
      span.dataset.depth = String(opts.depth || 1);
      span.style.textDecorationLine = 'underline';
      span.style.textDecorationStyle = 'wavy';
      span.style.textDecorationColor = opts.color.color;
      span.style.textDecorationThickness = '2px';
      span.style.textUnderlineOffset = '3px';
      span.style.borderRadius = '2px';
      span.style.backgroundColor = opts.color.bg;
      span.style.cursor = 'pointer';
      if (opts.title) span.title = opts.title;
      span.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (opts.onClick) opts.onClick(opts.id);
      }, true);
      node.parentNode.insertBefore(span, node);
      span.appendChild(node);
      return span;
    }

    if (startNode === endNode) {
      if (endOffset <= startOffset) return spans;
      const after = startNode.splitText(startOffset);
      after.splitText(endOffset - startOffset);
      const span = wrapNode(after);
      if (span) spans.push(span);
      return spans;
    }

    let startPart = startNode;
    if (startOffset > 0) startPart = startNode.splitText(startOffset);
    if (endOffset < endNode.nodeValue.length) endNode.splitText(endOffset);

    const range = document.createRange();
    range.setStart(startPart, 0);
    range.setEnd(endNode, endNode.nodeValue.length);

    const ancestor = commonAncestor(startPart, endNode) || document.body;
    const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      if (range.intersectsNode(n) && n.nodeValue.trim()) targets.push(n);
    }
    targets.forEach(function (node) {
      const span = wrapNode(node);
      if (span) spans.push(span);
    });
    return spans;
  }

  function clearAnnotations(root) {
    const spans = Array.prototype.slice.call(root.querySelectorAll('.' + CLASS));
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i];
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    }
  }

  function applyAnnotations(root, items, handlers) {
    handlers = handlers || {};
    clearAnnotations(root);

    const byId = {};
    (items || []).forEach(function (it) { byId[it.id] = it; });

    function depthOf(item) {
      let depth = 1;
      let cur = item;
      const seen = new Set([item.id]);
      while (cur && cur.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        cur = byId[cur.parentId];
        if (cur) depth++;
      }
      return Math.min(depth, 20);
    }

    const sorted = (items || []).slice().sort(function (a, b) {
      const da = depthOf(a);
      const db = depthOf(b);
      if (da !== db) return da - db;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });

    const spanById = {};
    const allSpansById = {};
    let applied = 0;
    let missed = 0;

    sorted.forEach(function (item) {
      const depth = depthOf(item);
      const anchorText = (item.anchor && item.anchor.text) || item.text;
      const occurrence = (item.anchor && item.anchor.occurrence) || 0;

      const scopes = [];
      if (item.parentId && allSpansById[item.parentId]) {
        allSpansById[item.parentId].forEach(function (span) { scopes.push(span); });
      }
      scopes.push(root);

      let found = null;
      for (let i = 0; i < scopes.length && !found; i++) {
        found = findTextRange(scopes[i], anchorText, occurrence, handlers.exclude);
      }
      if (!found) { missed++; return; }

      const title = [item.translation, item.note].filter(Boolean).join('\n');
      const spans = wrapRange(found.startNode, found.startOffset, found.endNode, found.endOffset, {
        id: item.id,
        depth: depth,
        color: colorForDepth(depth),
        title: title,
        onClick: handlers.onClick,
      });
      if (!spans.length) { missed++; return; }
      allSpansById[item.id] = spans;
      spanById[item.id] = spans[0];
      applied++;
    });

    return { applied: applied, missed: missed, spans: spanById };
  }

  function getSpan(itemId, root) {
    return (root || document.body).querySelector('.' + CLASS + '[data-ann-id="' + String(itemId) + '"]');
  }

  function getSpanRect(itemId, root) {
    const span = getSpan(itemId, root);
    return span ? span.getBoundingClientRect() : null;
  }

  function captureSelection(root, selection, exclude) {
    if (!selection || selection.rangeCount === 0) return null;
    const text = collapse(selection.toString());
    if (!text) return null;
    const range = selection.getRangeAt(0);

    function closestAnn(node) {
      let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
      return el && el.closest ? el.closest('.' + CLASS) : null;
    }
    const startSpan = closestAnn(range.startContainer);
    const endSpan = closestAnn(range.endContainer);
    let parentId = null;
    if (startSpan && endSpan && startSpan.dataset.annId === endSpan.dataset.annId) {
      parentId = startSpan.dataset.annId;
    }

    const scope = parentId && startSpan ? startSpan : root;
    const occurrence = countBefore(scope, text, range.startContainer, range.startOffset, exclude);

    let prefix = '';
    let suffix = '';
    try {
      const pre = document.createRange();
      pre.selectNodeContents(root);
      pre.setEnd(range.startContainer, range.startOffset);
      prefix = collapse(pre.toString()).slice(-80);

      const post = document.createRange();
      post.selectNodeContents(root);
      post.setStart(range.endContainer, range.endOffset);
      suffix = collapse(post.toString()).slice(0, 80);
    } catch (e) { /* ignore */ }

    return {
      text: text,
      pageUrl: location.href,
      pageTitle: document.title,
      parentId: parentId,
      occurrence: occurrence,
      prefix: prefix,
      suffix: suffix,
    };
  }

  return {
    CLASS: CLASS,
    COLORS: COLORS,
    colorForDepth: colorForDepth,
    applyAnnotations: applyAnnotations,
    clearAnnotations: clearAnnotations,
    captureSelection: captureSelection,
    findTextRange: findTextRange,
    countBefore: countBefore,
    getSpan: getSpan,
    getSpanRect: getSpanRect,
    wrapRange: wrapRange,
  };
});
