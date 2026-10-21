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

test('splitForTranslation: 短文本原样，长文本切块且不超过 450 字符', function () {
  assert.deepEqual(C.splitForTranslation('short sentence', 450), ['short sentence']);

  const long = 'This is a sentence for translation. '.repeat(40) + 'The end.';
  const chunks = C.splitForTranslation(long, 450);
  assert.ok(chunks.length > 1, '长文本应切成多块');
  chunks.forEach(function (chunk) {
    assert.ok(chunk.length <= 450, '每块不超过 450 字符，实际 ' + chunk.length);
  });
  assert.equal(
    chunks.join(' ').replace(/\s+/g, ' ').trim(),
    long.replace(/\s+/g, ' ').trim(),
    '拼回后应与原文一致'
  );
  assert.ok(chunks[0].endsWith('.'), '优先在句末切');
});

test('splitForTranslation: 无标点时按空格切，空文本返回空数组', function () {
  const chunks = C.splitForTranslation('word '.repeat(200), 100);
  assert.ok(chunks.length > 1);
  assert.deepEqual(C.splitForTranslation('   ', 450), []);
  assert.deepEqual(C.splitForTranslation('', 450), []);
});

test('parseAIReview: 解析标准 JSON 并规范字段', function () {
  const parsed = C.parseAIReview(JSON.stringify({
    verdict: '基本准确',
    feedback: '整体不错，"reach a decision" 可以更自然。',
    items: [
      { type: 'word', text: 'committee', meaning: '委员会', note: '集合名词' },
      { type: 'phrase', text: 'reach a decision', meaning: '作出决定', note: '' },
      { type: 'usage', text: 'has yet to', meaning: '尚未', note: '后接动词原形' },
    ],
  }));
  assert.ok(parsed);
  assert.equal(parsed.verdict, '基本准确');
  assert.equal(parsed.feedback.indexOf('整体不错'), 0);
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[1].type, 'phrase');
  assert.equal(parsed.items[2].text, 'has yet to');
});

test('parseAIReview: 容忍代码块/前后废话/非法 type/空文本', function () {
  const parsed = C.parseAIReview([
    '好的，以下是审查结果：',
    '```json',
    JSON.stringify({
      verdict: '不准确',
      feedback: '误译了 "yet to"。',
      items: [
        { type: 'unknown', text: 'yet to reach', meaning: '尚未达到' },
        { type: 'word', text: '   ', meaning: '空文本应丢弃' },
        { type: 'word', text: 'proposal', meaning: '提案' },
      ],
    }),
    '```',
  ].join('\n'));
  assert.ok(parsed);
  assert.equal(parsed.verdict, '不准确');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].type, 'phrase', '非法 type 回退为 phrase');
  assert.equal(parsed.items[1].text, 'proposal');
});

test('parseAIReview: 非法 JSON 返回 null，非法 verdict 回退，items 上限 12', function () {
  assert.equal(C.parseAIReview('not json at all'), null);
  assert.equal(C.parseAIReview(''), null);

  const many = [];
  for (let i = 0; i < 20; i++) many.push({ type: 'word', text: 'w' + i, meaning: 'm' + i });
  const parsed = C.parseAIReview(JSON.stringify({ verdict: '完美', feedback: '', items: many }));
  assert.ok(parsed);
  assert.equal(parsed.verdict, '基本准确');
  assert.equal(parsed.items.length, 12);
});

test('parseWordDictionary: 解析音标/词性/义项并过滤空义项', function () {
  const parsed = C.parseWordDictionary(JSON.stringify({
    word: 'decision',
    phonetic: '/dɪˈsɪʒən/',
    partOfSpeech: 'n.',
    senses: [
      { zh: '决定', en: 'a choice or judgment', example: 'She made a decision.', exampleZh: '她做了一个决定。' },
      { zh: '   ', en: '', example: 'x' },
      null,
    ],
  }), 'decision');
  assert.ok(parsed);
  assert.equal(parsed.word, 'decision');
  assert.equal(parsed.phonetic, '/dɪˈsɪʒən/');
  assert.equal(parsed.partOfSpeech, 'n.');
  assert.equal(parsed.senses.length, 1);
  assert.equal(parsed.senses[0].zh, '决定');
  assert.equal(parsed.senses[0].exampleZh, '她做了一个决定。');
});

test('parseWordDictionary: 容忍代码块/前后废话，非法 JSON 返回 null', function () {
  const parsed = C.parseWordDictionary([
    '结果如下：',
    '```json',
    '{"phonetic":"/test/","senses":[{"zh":"测试"}]}',
    '```',
  ].join('\n'), 'test');
  assert.ok(parsed);
  assert.equal(parsed.word, 'test');
  assert.equal(parsed.phonetic, '/test/');
  assert.equal(parsed.senses[0].zh, '测试');
  assert.equal(C.parseWordDictionary('not json', 'x'), null);
});

test('normalizeState: 保留 items 上的单词词典字段', function () {
  const normalized = C.normalizeState({
    groups: [],
    items: [{
      id: 'i_dict',
      text: 'decision',
      pageUrl: 'https://example.com/a',
      dictionary: { word: 'decision', phonetic: '/dɪˈsɪʒən/', partOfSpeech: 'n.', senses: [{ zh: '决定' }] },
    }],
  });
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].dictionary.phonetic, '/dɪˈsɪʒən/');
  assert.equal(normalized.items[0].dictionary.senses[0].zh, '决定');
});
