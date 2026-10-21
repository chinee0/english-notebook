import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import C from '../extension/core.js';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, '..', 'extension', 'background.js'), 'utf8');

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function createEnv() {
  const store = {
    settings: {
      llm: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' },
      dictionary: { enabled: true },
    },
  };
  const listeners = {};
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          (Array.isArray(keys) ? keys : Object.keys(keys || {})).forEach(function (k) { if (k in store) out[k] = store[k]; });
          cb(out);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
      },
    },
    runtime: {
      onMessage: { addListener: function (fn) { listeners.message = fn; } },
      onInstalled: { addListener: function () {} },
      onStartup: { addListener: function () {} },
      openOptionsPage: function () {},
      lastError: undefined,
    },
    tabs: {
      query: function (query, cb) { if (typeof cb === 'function') cb([{ id: 1, url: 'https://example.com/x', title: 'Example' }]); },
      sendMessage: function (tabId, msg, cb) {
        if (msg && msg.type === 'REQUEST_CAPTURE') {
          const capture = {
            text: 'decision',
            pageUrl: 'https://example.com/x',
            pageTitle: 'Example',
            parentId: null,
            occurrence: 0,
            prefix: '',
            suffix: '',
          };
          if (cb) cb(capture);
          return Promise.resolve(capture);
        }
        if (cb) cb({ ok: true });
        return Promise.resolve({ ok: true });
      },
    },
    contextMenus: {
      removeAll: function (cb) { if (cb) cb(); },
      create: function () {},
      onClicked: {
        addListener: function (fn) { listeners.contextMenu = fn; },
      },
    },
    commands: { onCommand: { addListener: function () {} } },
  };

  const fakeFS = {
    getHandle: async function () { return null; },
    setHandle: async function () {},
    clearHandle: async function () {},
    permission: async function () { return 'none'; },
    ensurePermission: async function () { return 'none'; },
    readFile: async function () { return ''; },
    writeFile: async function () {},
    fileMeta: async function () { return { name: '', size: 0, lastModified: 0 }; },
  };

  const calls = [];
  const fetchStub = async function (url, options) {
    calls.push(String(url));
    const u = String(url);
    if (u.indexOf('mymemory') !== -1) {
      return { status: 200, json: async function () { return { responseData: { translatedText: '决定' } }; } };
    }
    if (u.indexOf('/chat/completions') !== -1) {
      const content = JSON.stringify({
        word: 'decision',
        phonetic: '/dɪˈsɪʒən/',
        partOfSpeech: 'n.',
        senses: [{ zh: '决定；抉择', en: 'a choice or judgment', example: 'She made a decision.', exampleZh: '她做了一个决定。' }],
      });
      return { status: 200, json: async function () { return { choices: [{ message: { content: content } }] }; } };
    }
    return { status: 404, json: async function () { return {}; } };
  };

  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ENB = Object.assign({}, C, { FileStore: fakeFS });
  sandbox.importScripts = function () {};
  sandbox.chrome = chrome;
  sandbox.fetch = fetchStub;
  sandbox.AbortController = globalThis.AbortController;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.console = console;
  vm.runInNewContext(source, sandbox, { filename: 'background.js' });

  return { sandbox: sandbox, chrome: chrome, listeners: listeners, store: store, calls: calls };
}

function makeSend(listeners) {
  return function send(message) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve({ ok: false, error: 'timeout' }); }, 8000);
      listeners.message(message, {}, function (resp) {
        clearTimeout(timer);
        resolve(resp || { ok: false });
      });
    });
  };
}

test('单词记录：并行翻译 + DeepSeek 词典释义，写入 state 并可被页面读取', async function () {
  const env = createEnv();
  const send = makeSend(env.listeners);

  await send({ type: 'GET_STATE_SUMMARY' });
  assert.equal(typeof env.listeners.contextMenu, 'function', '应注册右键菜单监听');

  env.listeners.contextMenu(
    { menuItemId: 'enb_translate_record', selectionText: 'decision' },
    { id: 1, url: 'https://example.com/x', title: 'Example' }
  );

  let item = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const summary = await send({ type: 'GET_STATE_SUMMARY' });
    const items = (summary.state && summary.state.items) || [];
    if (items.length) { item = items[0]; break; }
  }

  assert.ok(item, '应新增一条批注');
  assert.equal(item.text, 'decision');
  assert.equal(item.translation, '决定');
  assert.ok(item.dictionary, '应有 AI 词典数据');
  assert.equal(item.dictionary.phonetic, '/dɪˈsɪʒən/');
  assert.equal(item.dictionary.partOfSpeech, 'n.');
  assert.equal(item.dictionary.senses[0].zh, '决定；抉择');
  assert.ok(env.calls.some(function (u) { return u.indexOf('mymemory') !== -1; }), '应调用翻译');
  assert.ok(env.calls.some(function (u) { return u.indexOf('/chat/completions') !== -1; }), '应调用 LLM 词典');

  const page = await send({ type: 'GET_PAGE_STATE', url: 'https://example.com/x', title: 'Example' });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].dictionary.word, 'decision');
});
