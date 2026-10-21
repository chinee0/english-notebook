import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import C from '../extension/core.js';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, '..', 'extension', 'background.js'), 'utf8');

function createChromeMock(state) {
  const listeners = {};
  const store = {};
  const metrics = { invalidSend: 0 };
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          (Array.isArray(keys) ? keys : Object.keys(keys || {})).forEach(function (k) {
            if (k in store) out[k] = store[k];
          });
          cb(out);
        },
        set(obj, cb) {
          Object.assign(store, obj);
          if (cb) cb();
        },
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
      query: function (query, cb) {
        if (typeof cb === 'function') cb([{ id: -1 }, { id: 0 }, {}, null]);
      },
      sendMessage: function (tabId) {
        if (!(typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0)) {
          metrics.invalidSend++;
        }
      },
    },
    contextMenus: {
      removeAll: function (cb) { if (cb) cb(); },
      create: function () {},
      onClicked: { addListener: function () {} },
    },
    commands: { onCommand: { addListener: function () {} } },
  };
  return { chrome: chrome, listeners: listeners, store: store, metrics: metrics };
}

function createFileStoreMock(initialText) {
  let text = initialText;
  let lastModified = 1000;
  const handle = {
    name: 'english-notes.json',
    queryPermission: async function () { return 'granted'; },
    getFile: async function () { return new File([text], 'english-notes.json', { lastModified: lastModified }); },
    createWritable: async function () {
      return {
        write: async function (chunk) { text = String(chunk); },
        close: async function () {},
      };
    },
  };
  return {
    handle: handle,
    get text() { return text; },
    set text(v) { text = String(v); lastModified += 1000; },
    touch: function () { lastModified += 1000; },
    getHandle: async function () { return handle; },
    setHandle: async function () {},
    clearHandle: async function () {},
    permission: async function () { return 'granted'; },
    ensurePermission: async function () { return 'granted'; },
    readFile: async function () { return text; },
    writeFile: async function (_h, next) { text = String(next); lastModified += 1000; },
    fileMeta: async function () {
      return { name: handle.name, size: Buffer.byteLength(text), lastModified: lastModified };
    },
  };
}

function loadBackground(chrome, fileStore) {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ENB = Object.assign({}, C, { FileStore: fileStore });
  sandbox.importScripts = function () {};
  sandbox.chrome = chrome;
  sandbox.fetch = globalThis.fetch;
  sandbox.AbortController = globalThis.AbortController;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.console = console;
  vm.runInNewContext(source, sandbox, { filename: 'background.js' });
  return sandbox;
}

function makeSend(listeners) {
  return function send(message) {
    return new Promise(function (resolve) {
      if (!listeners.message) { resolve({ ok: false, error: 'no listener' }); return; }
      const timer = setTimeout(function () { resolve({ ok: false, error: 'timeout' }); }, 8000);
      listeners.message(message, {}, function (resp) {
        clearTimeout(timer);
        resolve(resp || { ok: false });
      });
    });
  };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

test('文件模式：启动读文件合并、修改写回、外部修改拉取、断开文件', async function () {
  const pageUrl = 'https://example.com/article';
  const fileState = C.normalizeState({
    groups: [{ id: 'g_file', name: '来自文件', hosts: ['example.com'], updatedAt: '2026-01-01T00:00:00.000Z' }],
    items: [{
      id: 'i_file',
      groupId: 'g_file',
      text: 'File sentence one.',
      translation: '文件句一',
      pageUrl: pageUrl,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  });
  const fileStore = createFileStoreMock(JSON.stringify(fileState, null, 2));
  const mock = createChromeMock({});
  loadBackground(mock.chrome, fileStore);
  const send = makeSend(mock.listeners);

  const status = await send({ type: 'GET_FILE_STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.file.configured, true);
  assert.equal(status.file.permission, 'granted');

  const summary = await send({ type: 'GET_STATE_SUMMARY' });
  assert.equal(summary.state.items.length, 1);
  assert.equal(summary.state.items[0].text, 'File sentence one.');
  assert.equal(summary.state.groups.length, 1);

  const added = await send({ type: 'ADD_GROUP', name: '新分组', hosts: ['news.com'] });
  assert.equal(added.ok, true);
  assert.equal(mock.metrics.invalidSend, 0, '不应向非法 tabId 发送消息');
  await sleep(800);
  const written = JSON.parse(fileStore.text);
  assert.ok(written.groups.some(function (g) { return g.name === '新分组'; }), '修改应写回文件');

  // 模拟文件被外部程序修改
  const external = JSON.parse(fileStore.text);
  external.items.push({
    id: 'i_external',
    groupId: null,
    text: 'External sentence.',
    translation: '外部句',
    pageUrl: pageUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  fileStore.text = JSON.stringify(external, null, 2);
  fileStore.touch();
  const tick = await send({ type: 'FILE_TICK' });
  assert.equal(tick.ok, true);
  assert.equal(tick.changed, true);
  const after = await send({ type: 'GET_STATE_SUMMARY' });
  assert.equal(after.state.items.length, 2);
  assert.ok(after.state.items.some(function (it) { return it.id === 'i_external'; }));

  const cleared = await send({ type: 'CLEAR_FILE' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.file.configured, false);
});
