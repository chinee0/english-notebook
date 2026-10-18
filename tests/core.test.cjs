'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../src/core.js');

test('normalizeState: 空输入得到合法空状态', function () {
  const s = C.normalizeState(null);
  assert.equal(s.version, 1);
  assert.deepEqual(s.groups, []);
  assert.deepEqual(s.items, []);
  assert.ok(typeof s.updatedAt === 'string');
});

test('normalizeState: 清洗非法条目并生成 id', function () {
  const s = C.normalizeState({
    groups: [{ id: 'g1', name: '  BBC   News ', hosts: ['https://www.bbc.com/news', 'bbc.com', 'bbc.com'] }],
    items: [
      { id: 'i1', groupId: 'g1', text: '  A   sample\n sentence.  ', sourceUrl: 'https://www.bbc.com/story', note: '例句' },
      { id: 'i2', groupId: 'missing', text: 'orphan item' },
      { id: 'i3', text: '   ' },
      null,
    ],
  });
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].name, 'BBC News');
  assert.deepEqual(s.groups[0].hosts, ['bbc.com']);
  assert.equal(s.items.length, 2, '空文本和 null 条目应被丢弃');
  assert.equal(s.items[0].text, 'A sample sentence.');
  assert.equal(s.items[0].sourceHost, 'bbc.com');
  assert.equal(s.items[1].groupId, null, '不存在的分组应置空');
});

test('normalizeHost: 协议/端口/www/通配符', function () {
  assert.equal(C.normalizeHost('https://www.Example.com:8443/a?b=1#c'), 'example.com');
  assert.equal(C.normalizeHost('*.foo.com'), 'foo.com');
  assert.equal(C.normalizeHost('HTTP://news.bbc.co.uk:80/x'), 'news.bbc.co.uk');
  assert.equal(C.normalizeHost('  localhost:3000  '), 'localhost');
  assert.equal(C.normalizeHost(''), '');
  assert.equal(C.normalizeHost('not a host!!'), '');
});

test('hostOf: 从 URL 提取主机', function () {
  assert.equal(C.hostOf('https://www.bbc.com/news/articles/1'), 'bbc.com');
  assert.equal(C.hostOf('not a url'), '');
  assert.equal(C.hostOf(''), '');
});

test('hostMatches: 子域匹配但不同域名不匹配', function () {
  assert.equal(C.hostMatches('www.bbc.com', 'bbc.com'), true);
  assert.equal(C.hostMatches('news.bbc.com', 'bbc.com'), true);
  assert.equal(C.hostMatches('bbc.com', 'bbc.com'), true);
  assert.equal(C.hostMatches('bbc.co.uk', 'bbc.com'), false);
  assert.equal(C.hostMatches('example.com', ''), false);
});

test('groupsForHost: 只返回绑定当前网站的组', function () {
  const s = C.normalizeState({
    groups: [
      { id: 'g1', name: 'BBC', hosts: ['bbc.com'] },
      { id: 'g2', name: '通用', hosts: [] },
    ],
  });
  assert.deepEqual(C.groupsForHost(s, 'news.bbc.com').map(function (g) { return g.id; }), ['g1']);
  assert.deepEqual(C.groupsForHost(s, 'example.com'), []);
});

test('addGroup / updateGroup / deleteGroup', function () {
  const s = C.normalizeState(null);
  const g = C.addGroup(s, ' 阅读 ', ['www.bbc.com', 'https://example.com/x']);
  assert.equal(g.name, '阅读');
  assert.deepEqual(g.hosts, ['bbc.com', 'example.com']);

  C.updateGroup(s, g.id, { name: '精读', hosts: ['theguardian.com'] });
  assert.equal(g.name, '精读');
  assert.deepEqual(g.hosts, ['theguardian.com']);

  const item = C.addItem(s, { text: 'hello world', groupId: g.id });
  assert.equal(item.groupId, g.id);
  const moved = C.deleteGroup(s, g.id);
  assert.equal(moved, 1);
  assert.equal(s.items[0].groupId, null, '删组后记录移到未分组');
  assert.equal(s.groups.length, 0);
});

test('addItem: 修剪空白、拒绝空文本、非法分组置空', function () {
  const s = C.normalizeState(null);
  assert.equal(C.addItem(s, { text: '   ' }), null);
  const it = C.addItem(s, { text: '  Keep   it  simple. ', groupId: 'nope' });
  assert.equal(it.text, 'Keep it simple.');
  assert.equal(it.groupId, null);
  assert.ok(it.id.startsWith('i_'));
});

test('updateItem / deleteItem', function () {
  const s = C.normalizeState(null);
  const g = C.addGroup(s, 'G', []);
  const it = C.addItem(s, { text: 'a b', groupId: g.id });
  const oldUpdated = it.updatedAt;

  C.updateItem(s, it.id, { text: 'a  b  c', note: 'note', groupId: null });
  assert.equal(it.text, 'a b c');
  assert.equal(it.note, 'note');
  assert.equal(it.groupId, null);
  assert.ok(it.updatedAt >= oldUpdated);

  assert.equal(C.deleteItem(s, it.id), true);
  assert.equal(s.items.length, 0);
  assert.equal(C.deleteItem(s, 'nope'), false);
});

test('countItems', function () {
  const s = C.normalizeState(null);
  const g = C.addGroup(s, 'G', []);
  C.addItem(s, { text: 'one', groupId: g.id });
  C.addItem(s, { text: 'two', groupId: g.id });
  C.addItem(s, { text: 'three' });
  assert.equal(C.countItems(s), 3);
  assert.equal(C.countItems(s, g.id), 2);
  assert.equal(C.countItems(s, null), 1);
});

test('exportState: 深拷贝且带导出时间', function () {
  const s = C.normalizeState({ items: [{ id: 'i1', text: 'hi' }] });
  const out = C.exportState(s);
  assert.equal(out.version, 1);
  assert.ok(out.exportedAt);
  out.items[0].text = 'changed';
  assert.equal(s.items[0].text, 'hi', '导出副本不应影响原状态');
});

test('mergeImport: 合并时按 id 取较新版本', function () {
  const base = C.normalizeState({
    groups: [{ id: 'g1', name: 'G1', hosts: ['a.com'], updatedAt: '2026-01-01T00:00:00.000Z' }],
    items: [
      { id: 'i1', groupId: 'g1', text: 'old text', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'i2', groupId: 'g1', text: 'keep', updatedAt: '2026-03-01T00:00:00.000Z' },
    ],
  });
  const incoming = {
    groups: [{ id: 'g1', name: 'G1 new', hosts: ['a.com'], updatedAt: '2026-02-01T00:00:00.000Z' }],
    items: [
      { id: 'i1', groupId: 'g1', text: 'new text', updatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'i2', groupId: 'g1', text: 'older overwrite attempt', updatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'i3', groupId: null, text: 'brand new', updatedAt: '2026-02-01T00:00:00.000Z' },
    ],
  };

  const res = C.mergeImport(base, incoming, 'merge');
  assert.equal(res.stats.groupsUpdated, 1);
  assert.equal(res.stats.itemsAdded, 1);
  assert.equal(res.stats.itemsUpdated, 1);
  assert.equal(res.stats.itemsSkipped, 1);
  assert.equal(base.groups[0].name, 'G1 new');
  assert.equal(base.items.find(function (i) { return i.id === 'i1'; }).text, 'new text');
  assert.equal(base.items.find(function (i) { return i.id === 'i2'; }).text, 'keep');
  assert.equal(base.items.length, 3);
});

test('mergeImport: 覆盖模式完全替换', function () {
  const base = C.normalizeState({ items: [{ id: 'i1', text: 'old' }] });
  const res = C.mergeImport(base, { groups: [{ id: 'g9', name: 'New', hosts: [] }], items: [{ id: 'i9', text: 'fresh' }] }, 'replace');
  assert.equal(res.stats.itemsAdded, 1);
  assert.equal(base.items.length, 1);
  assert.equal(base.items[0].id, 'i9');
  assert.equal(base.groups[0].id, 'g9');
});
