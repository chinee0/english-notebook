import test from 'node:test';
import assert from 'node:assert/strict';

import C from '../extension/core.js';

const PAGE = 'https://www.example.com/articles/1';

test('normalizePageUrl: 去 hash、去追踪参数、排序 query、去尾部斜杠', function () {
  assert.equal(
    C.normalizePageUrl('https://Example.com:443/a/?utm_source=x&z=1&a=2#frag'),
    'https://example.com/a?a=2&z=1'
  );
  assert.equal(C.normalizePageUrl('https://example.com/'), 'https://example.com/');
  assert.equal(C.normalizePageUrl(''), '');
  assert.equal(C.normalizePageUrl('not a url'), 'not a url');
});

test('normalizeHost: 协议/端口/www/子域', function () {
  assert.equal(C.normalizeHost('https://www.Example.com:8443/a'), 'example.com');
  assert.equal(C.normalizeHost('news.bbc.co.uk'), 'news.bbc.co.uk');
  assert.equal(C.normalizeHost('www.bbc.com'), 'bbc.com');
  assert.equal(C.normalizeHost(''), '');
  assert.equal(C.hostOfPage(PAGE), 'example.com');
});

test('hostMatches / groupsForHost', function () {
  assert.equal(C.hostMatches('news.bbc.com', 'bbc.com'), true);
  assert.equal(C.hostMatches('bbc.co.uk', 'bbc.com'), false);
  const s = C.normalizeState({
    groups: [
      { id: 'g1', name: 'BBC', hosts: ['bbc.com'] },
      { id: 'g2', name: '通用', hosts: [] },
    ],
  });
  assert.deepEqual(C.groupsForHost(s, 'news.bbc.com').map(function (g) { return g.id; }), ['g1']);
  assert.deepEqual(C.groupsForHost(s, 'example.com'), []);
});

test('normalizeState: v1 迁移到 v2 字段', function () {
  const s = C.normalizeState({
    groups: [{ id: 'g1', name: 'BBC', hosts: ['https://www.bbc.com/news'] }],
    items: [
      {
        id: 'i1',
        groupId: 'g1',
        text: '  A   sample\n sentence. ',
        note: '旧备注',
        sourceUrl: 'https://www.bbc.com/news/1#section',
        sourceTitle: 'BBC News',
        sourceHost: 'bbc.com',
      },
    ],
  });
  assert.deepEqual(s.groups[0].hosts, ['bbc.com']);
  const it = s.items[0];
  assert.equal(it.text, 'A sample sentence.');
  assert.equal(it.translation, '');
  assert.equal(it.note, '旧备注');
  assert.equal(it.pageUrl, 'https://www.bbc.com/news/1');
  assert.equal(it.pageTitle, 'BBC News');
  assert.equal(it.sourceHost, 'bbc.com');
  assert.deepEqual(it.anchor, { text: 'A sample sentence.', occurrence: 0, prefix: '', suffix: '' });
  assert.equal(it.parentId, null);
});

test('normalizeState: 校验父批注（悬空/跨页/成环）', function () {
  const s = C.normalizeState({
    items: [
      { id: 'a', text: 'top', pageUrl: PAGE },
      { id: 'b', text: 'child', pageUrl: PAGE, parentId: 'a' },
      { id: 'c', text: 'dangling', pageUrl: PAGE, parentId: 'missing' },
      { id: 'd', text: 'cross-page', pageUrl: 'https://other.com/x', parentId: 'a' },
      { id: 'e', text: 'cycle-1', pageUrl: PAGE, parentId: 'f' },
      { id: 'f', text: 'cycle-2', pageUrl: PAGE, parentId: 'e' },
    ],
  });
  const byId = {};
  s.items.forEach(function (it) { byId[it.id] = it; });
  assert.equal(byId.b.parentId, 'a');
  assert.equal(byId.c.parentId, null);
  assert.equal(byId.d.parentId, null);
  assert.equal(byId.e.parentId === 'f' && byId.f.parentId === 'e', false, '环应被打断');
});

test('addItem: 必填文本和页面、父批注校验、深度', function () {
  const s = C.normalizeState(null);
  assert.equal(C.addItem(s, { text: 'no page' }), null);
  assert.equal(C.addItem(s, { text: '   ', pageUrl: PAGE }), null);

  const parent = C.addItem(s, { text: 'The whole sentence.', pageUrl: PAGE });
  assert.ok(parent);

  const child = C.addItem(s, { text: 'whole sentence', pageUrl: PAGE, parentId: parent.id, translation: '整句话' });
  assert.equal(child.parentId, parent.id);
  assert.equal(child.translation, '整句话');
  assert.equal(child.pageUrl, PAGE);

  const crossParent = C.addItem(s, { text: 'x', pageUrl: 'https://other.com/x', parentId: parent.id });
  assert.equal(crossParent.parentId, null);
  assert.equal(C.depthOf(s, parent.id), 1);
  assert.equal(C.depthOf(s, child.id), 2);
});

test('itemsForPage: 只返回规范化后完全相同的页面', function () {
  const s = C.normalizeState(null);
  C.addItem(s, { text: 'one', pageUrl: PAGE + '#top' });
  C.addItem(s, { text: 'two', pageUrl: PAGE + '?utm_source=feed' });
  C.addItem(s, { text: 'three', pageUrl: 'https://www.example.com/articles/2' });
  const items = C.itemsForPage(s, PAGE);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(function (it) { return it.text; }).sort(), ['one', 'two']);
});

test('updateItem: 改译文/备注/父级并阻止环', function () {
  const s = C.normalizeState(null);
  const a = C.addItem(s, { text: 'a', pageUrl: PAGE });
  const b = C.addItem(s, { text: 'b', pageUrl: PAGE, parentId: a.id });

  C.updateItem(s, a.id, { translation: '译A', note: '备注A' });
  assert.equal(a.translation, '译A');
  assert.equal(a.note, '备注A');

  C.updateItem(s, a.id, { parentId: b.id });
  assert.equal(a.parentId, null, '不能形成环');
});

test('deleteItem: 级联删除子孙批注', function () {
  const s = C.normalizeState(null);
  const a = C.addItem(s, { text: 'a', pageUrl: PAGE });
  const b = C.addItem(s, { text: 'b', pageUrl: PAGE, parentId: a.id });
  const c = C.addItem(s, { text: 'c', pageUrl: PAGE, parentId: b.id });
  const d = C.addItem(s, { text: 'd', pageUrl: PAGE });
  const removed = C.deleteItem(s, a.id);
  assert.equal(removed, 3);
  assert.deepEqual(s.items.map(function (it) { return it.id; }), [d.id]);
});

test('mergeImport: 合并按 id 取较新，保留 v2 字段', function () {
  const base = C.normalizeState({
    groups: [{ id: 'g1', name: 'G1', hosts: ['a.com'], updatedAt: '2026-01-01T00:00:00.000Z' }],
    items: [
      { id: 'i1', groupId: 'g1', text: 'old', translation: '旧译', pageUrl: PAGE, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'i2', groupId: 'g1', text: 'keep', pageUrl: PAGE, updatedAt: '2026-03-01T00:00:00.000Z' },
    ],
  });
  const incoming = {
    groups: [{ id: 'g1', name: 'G1 new', hosts: ['a.com'], updatedAt: '2026-02-01T00:00:00.000Z' }],
    items: [
      {
        id: 'i1',
        groupId: 'g1',
        text: 'old',
        translation: '新译',
        pageUrl: PAGE,
        anchor: { text: 'old', occurrence: 0, prefix: 'p', suffix: 's' },
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      { id: 'i2', groupId: 'g1', text: 'keep', pageUrl: PAGE, updatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'i3', text: 'new', pageUrl: PAGE, parentId: 'i1', updatedAt: '2026-02-01T00:00:00.000Z' },
    ],
  };

  const res = C.mergeImport(base, incoming, 'merge');
  assert.equal(res.stats.groupsUpdated, 1);
  assert.equal(res.stats.itemsAdded, 1);
  assert.equal(res.stats.itemsUpdated, 1);
  assert.equal(res.stats.itemsSkipped, 1);
  assert.equal(res.state.groups[0].name, 'G1 new');
  assert.equal(res.state.items.find(function (i) { return i.id === 'i1'; }).translation, '新译');
  assert.equal(res.state.items.find(function (i) { return i.id === 'i3'; }).parentId, 'i1');
});

test('mergeImport: 覆盖模式完全替换', function () {
  const base = C.normalizeState({ items: [{ id: 'i1', text: 'old', pageUrl: PAGE }] });
  const res = C.mergeImport(base, { groups: [{ id: 'g9', name: 'New', hosts: [] }], items: [{ id: 'i9', text: 'fresh', pageUrl: PAGE }] }, 'replace');
  assert.equal(res.state.items.length, 1);
  assert.equal(res.state.items[0].id, 'i9');
  assert.equal(res.state.groups[0].id, 'g9');
});

test('exportState: 深拷贝并带版本', function () {
  const s = C.normalizeState({ items: [{ id: 'i1', text: 'hi', pageUrl: PAGE }] });
  const out = C.exportState(s);
  assert.equal(out.version, 2);
  assert.ok(out.exportedAt);
  out.items[0].text = 'changed';
  assert.equal(s.items[0].text, 'hi');
});
