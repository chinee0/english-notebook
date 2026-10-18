/*
 * English Notebook · shared core (v2)
 * 纯数据逻辑，不依赖 DOM。
 * 浏览器扩展里通过 <script> 加载得到 ENB；Node 里 require() 得到模块对象。
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.ENB = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 2;
  const TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'yclid', 'spm', 'from', 'ref_src', 'ref_url',
  ];

  function nowIso() { return new Date().toISOString(); }

  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function cloneState(state) { return JSON.parse(JSON.stringify(state)); }

  function touch(state) { state.updatedAt = nowIso(); }

  function cleanText(s, max) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 4000);
  }

  /* ---------- 页面 / 网址 ---------- */

  function normalizePageUrl(raw) {
    if (!raw) return '';
    try {
      const u = new URL(String(raw));
      u.hash = '';
      TRACKING_PARAMS.forEach(function (p) { u.searchParams.delete(p); });
      u.searchParams.sort();
      if (u.pathname.length > 1 && u.pathname.charAt(u.pathname.length - 1) === '/') {
        u.pathname = u.pathname.slice(0, -1);
      }
      return u.toString();
    } catch (e) {
      return String(raw).split('#')[0];
    }
  }

  function normalizeHost(raw) {
    if (!raw) return '';
    let s = String(raw).trim().toLowerCase();
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = new URL(s).hostname;
    } catch (e) { /* ignore */ }
    s = s.split('/')[0].split('?')[0].split('#')[0];
    s = s.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) && !/^[a-z0-9.-]+$/.test(s)) return '';
    return s;
  }

  function hostOfPage(url) {
    try { return normalizeHost(new URL(String(url)).hostname); } catch (e) { return ''; }
  }

  function hostMatches(host, bound) {
    const h = normalizeHost(host);
    const b = normalizeHost(bound);
    if (!h || !b) return false;
    return h === b || h.slice(-(b.length + 1)) === '.' + b;
  }

  function groupMatchesHost(group, host) {
    if (!group || !Array.isArray(group.hosts)) return false;
    return group.hosts.some(function (b) { return hostMatches(host, b); });
  }

  function groupsForHost(state, host) {
    const h = normalizeHost(host);
    if (!h) return [];
    return state.groups.filter(function (g) { return groupMatchesHost(g, h); });
  }

  /* ---------- 规范化 ---------- */

  function normalizeAnchor(raw, fallbackText) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return {
      text: cleanText(raw.text || fallbackText, 4000),
      occurrence: Math.max(0, Math.min(9999, Number(raw.occurrence) || 0)),
      prefix: String(raw.prefix || '').slice(-80),
      suffix: String(raw.suffix || '').slice(0, 80),
    };
  }

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
        name: cleanText(g.name, 80) || '未命名分组',
        hosts: Array.from(new Set(hosts.map(normalizeHost).filter(Boolean))),
        createdAt: g.createdAt || nowIso(),
        updatedAt: g.updatedAt || g.createdAt || nowIso(),
      });
    });

    const groupIds = new Set(out.groups.map(function (g) { return g.id; }));

    items.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      const text = cleanText(it.text, 4000);
      if (!text) return;
      const pageUrl = normalizePageUrl(it.pageUrl || it.sourceUrl || '');
      if (!pageUrl) return;
      out.items.push({
        id: String(it.id || newId('i')),
        groupId: it.groupId && groupIds.has(it.groupId) ? it.groupId : null,
        text: text,
        translation: cleanText(it.translation, 5000),
        note: String(it.note || '').slice(0, 5000),
        pageUrl: pageUrl,
        pageTitle: cleanText(it.pageTitle || it.sourceTitle || '', 300),
        sourceHost: normalizeHost(it.sourceHost || hostOfPage(pageUrl)),
        anchor: normalizeAnchor(it.anchor, text),
        parentId: it.parentId ? String(it.parentId) : null,
        createdAt: it.createdAt || nowIso(),
        updatedAt: it.updatedAt || it.createdAt || nowIso(),
      });
    });

    // 校验父批注：必须存在、同页面，且不能成环
    const byId = new Map(out.items.map(function (it) { return [it.id, it]; }));
    out.items.forEach(function (it) {
      if (!it.parentId) return;
      const parent = byId.get(it.parentId);
      if (!parent || parent.pageUrl !== it.pageUrl) it.parentId = null;
    });
    out.items.forEach(function (it) {
      let cur = it;
      const seen = new Set([it.id]);
      while (cur && cur.parentId) {
        if (seen.has(cur.parentId)) { cur.parentId = null; break; }
        seen.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
    });

    if (raw.updatedAt) out.updatedAt = raw.updatedAt;
    return out;
  }

  /* ---------- 分组 ---------- */

  function groupExists(state, id) {
    return !!(id && state.groups.some(function (g) { return g.id === id; }));
  }

  function addGroup(state, name, hosts) {
    const cleanName = cleanText(name, 80) || '未命名分组';
    const cleanHosts = Array.from(new Set((Array.isArray(hosts) ? hosts : []).map(normalizeHost).filter(Boolean)));
    const g = { id: newId('g'), name: cleanName, hosts: cleanHosts, createdAt: nowIso(), updatedAt: nowIso() };
    state.groups.push(g);
    touch(state);
    return g;
  }

  function updateGroup(state, id, patch) {
    const g = state.groups.find(function (x) { return x.id === id; });
    if (!g) return null;
    patch = patch || {};
    if (patch.name !== undefined) {
      const n = cleanText(patch.name, 80);
      if (n) g.name = n;
    }
    if (patch.hosts !== undefined) {
      g.hosts = Array.from(new Set((Array.isArray(patch.hosts) ? patch.hosts : []).map(normalizeHost).filter(Boolean)));
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
      if (it.groupId === id) { it.groupId = null; it.updatedAt = nowIso(); moved++; }
    });
    touch(state);
    return moved;
  }

  /* ---------- 记录 / 批注 ---------- */

  function findItem(state, id) {
    return state.items.find(function (it) { return it.id === id; }) || null;
  }

  function itemsForPage(state, url) {
    const pageUrl = normalizePageUrl(url);
    if (!pageUrl) return [];
    return state.items.filter(function (it) { return it.pageUrl === pageUrl; });
  }

  function depthOf(state, itemId) {
    let depth = 1;
    let cur = findItem(state, itemId);
    const seen = new Set([itemId]);
    while (cur && cur.parentId) {
      if (seen.has(cur.parentId)) break;
      seen.add(cur.parentId);
      cur = findItem(state, cur.parentId);
      if (cur) depth++;
    }
    return Math.min(depth, 20);
  }

  function addItem(state, data) {
    data = data || {};
    const text = cleanText(data.text, 4000);
    if (!text) return null;
    const pageUrl = normalizePageUrl(data.pageUrl || data.sourceUrl || '');
    if (!pageUrl) return null;

    let parentId = data.parentId || null;
    if (parentId) {
      const parent = findItem(state, parentId);
      if (!parent || parent.pageUrl !== pageUrl) parentId = null;
    }
    let groupId = data.groupId || null;
    if (groupId && !groupExists(state, groupId)) groupId = null;

    const item = {
      id: newId('i'),
      groupId: groupId,
      text: text,
      translation: cleanText(data.translation, 5000),
      note: String(data.note || '').slice(0, 5000),
      pageUrl: pageUrl,
      pageTitle: cleanText(data.pageTitle, 300),
      sourceHost: normalizeHost(data.sourceHost || hostOfPage(pageUrl)),
      anchor: normalizeAnchor(data.anchor, text),
      parentId: parentId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.items.push(item);
    touch(state);
    return item;
  }

  function updateItem(state, id, patch) {
    const item = findItem(state, id);
    if (!item) return null;
    patch = patch || {};
    if (patch.translation !== undefined) item.translation = cleanText(patch.translation, 5000);
    if (patch.note !== undefined) item.note = String(patch.note || '').slice(0, 5000);
    if (patch.groupId !== undefined) {
      item.groupId = patch.groupId && groupExists(state, patch.groupId) ? patch.groupId : null;
    }
    if (patch.parentId !== undefined) {
      let next = patch.parentId || null;
      if (next && next !== id) {
        const parent = findItem(state, next);
        if (!parent || parent.pageUrl !== item.pageUrl) {
          next = null;
        } else {
          let cur = parent;
          const seen = new Set([id]);
          while (cur) {
            if (cur.id === id) { next = null; break; }
            if (seen.has(cur.id)) { next = null; break; }
            seen.add(cur.id);
            cur = cur.parentId ? findItem(state, cur.parentId) : null;
          }
        }
      } else if (next === id) {
        next = null;
      }
      item.parentId = next;
    }
    item.updatedAt = nowIso();
    touch(state);
    return item;
  }

  function deleteItem(state, id) {
    if (!findItem(state, id)) return 0;
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      state.items.forEach(function (it) {
        if (it.parentId && ids.has(it.parentId) && !ids.has(it.id)) {
          ids.add(it.id);
          changed = true;
        }
      });
    }
    state.items = state.items.filter(function (it) { return !ids.has(it.id); });
    touch(state);
    return ids.size;
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

    const groupById = new Map(state.groups.map(function (g) { return [g.id, g]; }));
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

    const itemById = new Map(state.items.map(function (it) { return [it.id, it]; }));
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

    const fixed = normalizeState(state);
    fixed.updatedAt = nowIso();
    return { state: fixed, stats: stats };
  }

  return {
    VERSION: VERSION,
    nowIso: nowIso,
    newId: newId,
    cloneState: cloneState,
    touch: touch,
    cleanText: cleanText,
    normalizePageUrl: normalizePageUrl,
    normalizeHost: normalizeHost,
    hostOfPage: hostOfPage,
    hostMatches: hostMatches,
    groupMatchesHost: groupMatchesHost,
    groupsForHost: groupsForHost,
    normalizeAnchor: normalizeAnchor,
    normalizeState: normalizeState,
    groupExists: groupExists,
    addGroup: addGroup,
    updateGroup: updateGroup,
    deleteGroup: deleteGroup,
    findItem: findItem,
    itemsForPage: itemsForPage,
    depthOf: depthOf,
    addItem: addItem,
    updateItem: updateItem,
    deleteItem: deleteItem,
    countItems: countItems,
    exportState: exportState,
    mergeImport: mergeImport,
  };
});
