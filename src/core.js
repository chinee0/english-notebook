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
