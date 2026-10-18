/*
 * English Notebook · background(service worker) ↔ 真实 sync-server 联调测试
 * 运行: node --test tests/background.test.mjs
 *
 * 做法：用 node:vm 造一个最小 chrome 扩展沙箱，加载真实的 extension/background.js，
 * 用 chrome 桩捕获 onMessage / contextMenus.onClicked 等监听器；sync-server 用
 * createSyncServer 在随机端口启动（临时数据文件 + 临时配置），从而验证完整链路：
 *   消息设置 endpoint / 数据文件 → 右键记录（本地 state）→ 自动 PUT 到服务
 *   → 外部设备 PUT → SYNC_NOW 拉取合并回本地。
 *
 * 不联网：translation.provider 设为 'none'；不监听默认端口 17890。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createSyncServer } from '../sync-server/sync-server.mjs';

const require = createRequire(import.meta.url);
const C = require('../extension/core.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');
const PAGE = 'https://www.example.com/articles/1';

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 跨 realm 安全的结构断言辅助：JSON 深拷贝后再比较。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(50);
  }
  throw new Error('等待超时' + (label ? '（' + label + '）' : '') + (lastError ? ': ' + lastError.message : ''));
}

async function httpJson(base, method, pathname, body) {
  const options = { method: method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
  return { status: res.status, json: json };
}

/* ------------------------------------------------------------------ */
/* chrome API 桩                                                       */
/* ------------------------------------------------------------------ */

function listenerRegistry() {
  return {
    listeners: [],
    addListener: function (fn) { this.listeners.push(fn); },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 最小 chrome 扩展 API 桩：内存 storage、可触发的监听器、可编排的 tab 消息。
 * tabs.sendMessage 对 REQUEST_CAPTURE 返回预置的 captureSelection 形状对象。
 */
function createChromeMock() {
  const store = new Map();
  const menus = [];
  const tabMessages = [];
  const tab = { id: 1, url: PAGE, title: 'Example Article' };
  let captureResponse = null;
  let openedOptionsPage = 0;

  const chromeMock = {
    runtime: {
      lastError: undefined,
      onMessage: listenerRegistry(),
      onInstalled: listenerRegistry(),
      onStartup: listenerRegistry(),
      openOptionsPage: function () { openedOptionsPage++; },
    },
    storage: {
      local: {
        get: function (keys, callback) {
          const out = {};
          const list = keys === null || keys === undefined ? [] :
            Array.isArray(keys) ? keys :
              typeof keys === 'string' ? [keys] : Object.keys(keys);
          list.forEach(function (key) {
            if (store.has(key)) out[key] = clone(store.get(key));
          });
          if (typeof callback === 'function') callback(out);
          return out;
        },
        set: function (items, callback) {
          Object.keys(items || {}).forEach(function (key) {
            store.set(key, clone(items[key]));
          });
          if (typeof callback === 'function') callback();
        },
      },
    },
    tabs: {
      query: function (queryInfo, callback) {
        const result = [tab];
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      },
      sendMessage: function (tabId, message, callback) {
        tabMessages.push({ tabId: tabId, message: clone(message) });
        let response;
        if (message && message.type === 'REQUEST_CAPTURE' && captureResponse) {
          response = clone(captureResponse);
        }
        if (typeof callback === 'function') callback(response);
        return Promise.resolve(response);
      },
    },
    contextMenus: {
      removeAll: function (callback) {
        menus.length = 0;
        if (typeof callback === 'function') callback();
      },
      create: function (props) {
        menus.push(clone(props));
        return props && props.id;
      },
      onClicked: listenerRegistry(),
    },
    commands: {
      onCommand: listenerRegistry(),
    },
  };

  return {
    chrome: chromeMock,
    store: store,
    menus: menus,
    tabMessages: tabMessages,
    setCapture: function (capture) { captureResponse = capture; },
    get openedOptionsPage() { return openedOptionsPage; },
  };
}

/* ------------------------------------------------------------------ */
/* 加载 background.js                                                  */
/* ------------------------------------------------------------------ */

async function loadBackground(chromeMock) {
  const source = await fs.readFile(BACKGROUND_PATH, 'utf8');
  const sandbox = {
    ENB: C,
    importScripts: function () { /* core.js 已通过 ENB 注入 */ },
    chrome: chromeMock,
    fetch: fetch,
    AbortController: AbortController,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: console,
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'extension/background.js', displayErrors: true });
  return { sandbox: sandbox, context: context };
}

/** 把捕获到的 chrome.runtime.onMessage 监听器包装成 Promise 风格的消息发送器。 */
function makeMessageSender(chromeMock) {
  const listener = chromeMock.runtime.onMessage.listeners[0];
  assert.ok(listener, 'background.js 应注册 chrome.runtime.onMessage 监听器');
  return function send(message, sender) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error('等待 sendResponse 超时: ' + (message && message.type)));
      }, 15000);
      let responded = false;
      function sendResponse(response) {
        responded = true;
        clearTimeout(timer);
        resolve(response);
      }
      let returned;
      try {
        returned = listener(message, sender || {}, sendResponse);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      if (returned !== true && !responded) {
        clearTimeout(timer);
        reject(new Error('onMessage handler 应返回 true 以支持异步 sendResponse: ' + (message && message.type)));
      }
    });
  };
}

/* ------------------------------------------------------------------ */
/* 测试 harness                                                        */
/* ------------------------------------------------------------------ */

async function createHarness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enb-bg-test-'));
  const dataFile = path.join(root, 'notes.json');
  const configFile = path.join(root, 'sync-config.json');
  const server = createSyncServer({
    dataFile: dataFile,
    port: 0,
    configFile: configFile,
    debounceMs: 50,
    autoCommit: false,
  });
  const info = await server.listen();

  const mock = createChromeMock();
  await loadBackground(mock.chrome);
  const send = makeMessageSender(mock.chrome);

  t.after(async function () {
    await server.close().catch(function () {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(function () {});
  });

  return {
    root: root,
    dataFile: dataFile,
    configFile: configFile,
    server: server,
    base: info.url,
    mock: mock,
    send: send,
  };
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

test('background 消息路由：SAVE_SETTINGS / SET_SYNC_PATH 接入真实服务并得到初始空状态', async function (t) {
  const h = await createHarness(t);

  // 监听器已注册（onMessage / 右键菜单 / 安装启动 / 命令）
  assert.equal(h.mock.chrome.runtime.onMessage.listeners.length, 1);
  assert.equal(h.mock.chrome.runtime.onInstalled.listeners.length, 1);
  assert.equal(h.mock.chrome.runtime.onStartup.listeners.length, 1);
  assert.equal(h.mock.chrome.contextMenus.onClicked.listeners.length, 1);
  assert.equal(h.mock.chrome.commands.onCommand.listeners.length, 1);

  // SAVE_SETTINGS：指向随机端口 + autoSync，翻译 provider=none 避免联网
  const saved = await h.send({
    type: 'SAVE_SETTINGS',
    settings: {
      sync: { endpoint: h.base, autoSync: true },
      translation: { provider: 'none' },
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.sync.endpoint, h.base);
  assert.equal(saved.settings.sync.autoSync, true);
  assert.equal(saved.settings.translation.provider, 'none');
  assert.equal(plain(h.mock.store.get('settings')).sync.endpoint, h.base);

  // SET_SYNC_PATH：非法相对路径被扩展侧直接拒绝
  const rejected = await h.send({ type: 'SET_SYNC_PATH', dataFile: 'relative/notes.json' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /绝对路径/);

  // SET_SYNC_PATH：合法绝对路径 → POST /config 到真实服务
  const configured = await h.send({ type: 'SET_SYNC_PATH', dataFile: h.dataFile });
  assert.equal(configured.ok, true);
  assert.equal(configured.sync.configured, true);
  assert.equal(configured.sync.dataFile, h.dataFile);
  assert.equal(configured.sync.git.repo, false);

  // 真实服务侧也已配置，并创建了空状态文件
  const health = await httpJson(h.base, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.configured, true);
  assert.equal(health.json.dataFile, h.dataFile);
  const disk = JSON.parse(await fs.readFile(h.dataFile, 'utf8'));
  assert.equal(disk.version, 2);
  assert.deepEqual(disk.items, []);

  // GET_PAGE_STATE：初始无批注
  const initial = await h.send({ type: 'GET_PAGE_STATE', url: PAGE });
  assert.equal(initial.ok, true);
  assert.deepEqual(plain(initial.items), []);
  assert.equal(initial.sync.configured, true);

  // GET_STATE_SUMMARY 能拿到当前 settings / sync 状态
  const summary = await h.send({ type: 'GET_STATE_SUMMARY' });
  assert.equal(summary.ok, true);
  assert.equal(summary.settings.sync.endpoint, h.base);
  assert.equal(summary.sync.configured, true);
});

test('右键记录 → 本地 state → 自动 PUT → 外部 PUT → SYNC_NOW 拉取合并', async function (t) {
  const h = await createHarness(t);

  await h.send({
    type: 'SAVE_SETTINGS',
    settings: {
      sync: { endpoint: h.base, autoSync: true },
      translation: { provider: 'none' },
    },
  });
  const configured = await h.send({ type: 'SET_SYNC_PATH', dataFile: h.dataFile });
  assert.equal(configured.ok, true);

  const initial = await h.send({ type: 'GET_PAGE_STATE', url: PAGE });
  assert.deepEqual(plain(initial.items), []);

  // ---- 模拟右键「翻译并记录」：内容脚本返回 captureSelection 形状 ----
  const capture = {
    text: 'The committee has yet to reach a decision.',
    pageUrl: PAGE,
    pageTitle: 'Example Article',
    parentId: null,
    occurrence: 3,
    prefix: 'before ',
    suffix: ' after',
  };
  h.mock.setCapture(capture);

  const onClicked = h.mock.chrome.contextMenus.onClicked.listeners[0];
  assert.ok(onClicked, 'background.js 应注册 contextMenus.onClicked 监听器');
  onClicked(
    { menuItemId: 'enb_translate_record', selectionText: '' },
    { id: 1, url: PAGE, title: 'Example Article' }
  );

  // 本地 state 很快出现该批注（翻译 provider=none 所以 translation 为空）
  const localState = await waitFor(async function () {
    const res = await h.send({ type: 'GET_PAGE_STATE', url: PAGE });
    return res.items.length >= 1 ? res : null;
  }, 8000, '本地 state 出现右键记录的批注');

  const localItems = plain(localState.items);
  assert.equal(localItems.length, 1);
  const localItem = localItems[0];
  assert.equal(localItem.text, capture.text);
  assert.equal(localItem.translation, '');
  assert.equal(localItem.pageUrl, PAGE);
  assert.equal(localItem.pageTitle, capture.pageTitle);
  assert.equal(localItem.anchor.text, capture.text);
  assert.equal(localItem.anchor.occurrence, capture.occurrence);
  assert.equal(localItem.anchor.prefix, capture.prefix);
  assert.equal(localItem.anchor.suffix, capture.suffix);
  assert.equal(localItem.parentId, null);

  // 自动 push（syncSoon 500ms + PUT）后，真实服务里也能读到该批注
  const remoteState = await waitFor(async function () {
    const res = await httpJson(h.base, 'GET', '/state');
    return res.status === 200 && res.json.state.items.length >= 1 ? res.json.state : null;
  }, 10000, 'sync-server /state 出现 push 的批注');

  assert.equal(remoteState.items.length, 1);
  assert.equal(remoteState.items[0].text, capture.text);
  assert.equal(remoteState.items[0].anchor.text, capture.text);
  assert.equal(remoteState.items[0].translation, '');

  // ---- 模拟另一台设备：直接 PUT 一条新批注到服务 ----
  const externalItem = {
    id: 'i-ext-device',
    groupId: null,
    text: 'External device sentence.',
    translation: '外部设备写入的译文',
    note: '',
    pageUrl: PAGE,
    pageTitle: 'Example Article',
    sourceHost: 'example.com',
    anchor: { text: 'External device sentence.', occurrence: 0, prefix: '', suffix: '' },
    parentId: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  };
  const externalPut = await httpJson(h.base, 'PUT', '/state', { state: { items: [externalItem] } });
  assert.equal(externalPut.status, 200);
  assert.equal(externalPut.json.ok, true);
  assert.equal(externalPut.json.state.items.length, 2, '服务端应把外部条目与已有条目合并');

  // ---- SYNC_NOW：拉取服务端 revision 变化并 merge 到本地 ----
  const syncNow = await h.send({ type: 'SYNC_NOW' });
  assert.equal(syncNow.ok, true);
  assert.equal(syncNow.changed, true, '外部改动后 SYNC_NOW 应检测到 revision 变化');
  assert.equal(syncNow.sync.configured, true);

  const afterSync = await h.send({ type: 'GET_PAGE_STATE', url: PAGE });
  assert.equal(afterSync.ok, true);
  const mergedItems = plain(afterSync.items);
  assert.equal(mergedItems.length, 2, '本地应同时保留右键记录与外部批注');
  assert.ok(mergedItems.some(function (it) { return it.id === localItem.id; }), '本地右键记录应保留');
  const external = mergedItems.find(function (it) { return it.id === 'i-ext-device'; });
  assert.ok(external, '本地应合并进外部批注');
  assert.equal(external.translation, '外部设备写入的译文');
  assert.equal(external.anchor.text, 'External device sentence.');

  // 本地持久化（chrome.storage.local 桩）也已包含两条批注
  const persisted = plain(h.mock.store.get('state'));
  assert.equal(persisted.items.length, 2);

  // SYNC_NOW 内部会 pushState，服务端最终应保留两条批注
  const serverAfterSync = await httpJson(h.base, 'GET', '/state');
  assert.equal(serverAfterSync.status, 200);
  const serverItems = serverAfterSync.json.state.items;
  assert.equal(serverItems.length, 2);
  assert.ok(serverItems.some(function (it) { return it.id === 'i-ext-device'; }));
  assert.ok(serverItems.some(function (it) { return it.id === localItem.id; }));
});
