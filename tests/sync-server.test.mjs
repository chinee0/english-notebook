/*
 * English Notebook · 本地同步服务集成测试
 * 运行: node --test tests/sync-server.test.mjs
 *
 * 覆盖：未配置时 409 / CORS / 404；POST /config 校验与持久化；
 * GET/PUT /state 合并与落盘；revision 随外部改动变化；
 * debounce 后自动 git commit（临时 git 仓库）。
 * 每个用例使用独立的临时目录与随机端口，结束后关闭服务器并清理目录。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createSyncServer } from '../sync-server/sync-server.mjs';

const execFileAsync = promisify(execFile);
const PAGE = 'https://www.example.com/articles/1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 执行外部命令，失败也返回 {code, stdout, stderr}。 */
async function run(cmd, args, cwd) {
  try {
    const result = await execFileAsync(cmd, args, {
      cwd: cwd,
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : -1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
    };
  }
}

const GIT_INFO = await run('git', ['--version']);
const GIT_AVAILABLE = GIT_INFO.code === 0;

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'enb-sync-test-'));
}

async function cleanupDir(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(function () {});
}

/**
 * 启动一个隔离的同步服务：随机端口 + 临时配置路径。
 * @returns {Promise<{root:string, configFile:string, server:any, base:string}>}
 */
async function startServer(t, opts) {
  const root = await makeTempDir();
  const configFile = path.join(root, 'sync-config.json');
  const server = createSyncServer(Object.assign({
    port: 0,
    debounceMs: 20,
    autoCommit: false,
    configFile: configFile,
  }, opts || {}));
  const info = await server.listen();
  t.after(async function () {
    await server.close().catch(function () {});
    await cleanupDir(root);
  });
  return { root: root, configFile: configFile, server: server, base: info.url };
}

async function api(base, method, pathname, body) {
  const options = { method: method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
  return { status: res.status, json: json, text: text, headers: res.headers };
}

/**
 * 轮询等待数据文件出现至少 minCount 条 git 提交，返回提交标题列表（新 -> 旧）。
 */
async function waitForGitLog(repoDir, dataFile, minCount, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  let last = [];
  while (Date.now() < deadline) {
    const res = await run('git', ['-C', repoDir, 'log', '--pretty=%s', '--', dataFile]);
    if (res.code === 0) {
      last = res.stdout.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (last.length >= minCount) return last;
    }
    await sleep(50);
  }
  throw new Error('等待 git 自动提交超时，当前提交: ' + JSON.stringify(last));
}

/* ------------------------------------------------------------------ */

test('未配置时 /health 字段正确，/state 返回 409，并支持 CORS / 404 / 405', async function (t) {
  const ctx = await startServer(t, { autoCommit: false, debounceMs: 25 });

  const health = await api(ctx.base, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(health.json, {
    ok: true,
    server: 'english-notebook-sync',
    version: 1,
    configured: false,
    dataFile: null,
    git: { repo: false, root: null },
  });

  const config = await api(ctx.base, 'GET', '/config');
  assert.equal(config.status, 200);
  assert.deepEqual(config.json, { dataFile: null, autoCommit: false, debounceMs: 25 });

  const getState = await api(ctx.base, 'GET', '/state');
  assert.equal(getState.status, 409);
  assert.deepEqual(getState.json, { ok: false, error: 'not_configured' });

  const putState = await api(ctx.base, 'PUT', '/state', { state: { groups: [], items: [] } });
  assert.equal(putState.status, 409);
  assert.deepEqual(putState.json, { ok: false, error: 'not_configured' });

  // CORS preflight
  const preflight = await fetch(ctx.base + '/state', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /PUT/);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /Content-Type/);

  // 未知路由 / 方法不允许 / 非法 JSON
  const notFound = await api(ctx.base, 'GET', '/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error, 'not_found');

  const wrongMethod = await api(ctx.base, 'POST', '/health', {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error, 'method_not_allowed');

  const badJson = await fetch(ctx.base + '/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error, 'invalid_json');
});

test('POST /config 校验绝对路径与父目录，创建空数据文件并持久化配置（重启后仍生效）', async function (t) {
  const ctx = await startServer(t, { autoCommit: false, debounceMs: 20 });

  const badCases = [
    [{ dataFile: 'data/notes.json' }, 'path_not_absolute'],
    [{ dataFile: '' }, 'invalid_path'],
    [{ dataFile: 42 }, 'invalid_path'],
    [{ dataFile: path.join(ctx.root, 'no-such-dir', 'notes.json') }, 'parent_directory_missing'],
    [{ dataFile: ctx.root }, 'invalid_path'], // 指向目录
  ];
  for (const entry of badCases) {
    const res = await api(ctx.base, 'POST', '/config', entry[0]);
    assert.equal(res.status, 400, '应拒绝: ' + JSON.stringify(entry[0]));
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, entry[1], '错误码: ' + JSON.stringify(entry[0]));
  }

  const dataDir = path.join(ctx.root, 'data');
  await fs.mkdir(dataDir);
  const dataFile = path.join(dataDir, 'notes.json');

  const created = await api(ctx.base, 'POST', '/config', { dataFile: dataFile });
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true);
  assert.equal(created.json.dataFile, dataFile);
  assert.equal(created.json.created, true);
  assert.deepEqual(created.json.git, { repo: false, root: null });

  // 文件不存在时创建空状态（规范化 v2 结构）
  const onDisk = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.deepEqual(onDisk.groups, []);
  assert.deepEqual(onDisk.items, []);

  // 配置持久化到指定配置文件
  const saved = JSON.parse(await fs.readFile(ctx.configFile, 'utf8'));
  assert.equal(saved.dataFile, dataFile);
  assert.equal(saved.autoCommit, false);
  assert.equal(saved.debounceMs, 20);

  // 已存在的文件不重复创建
  const again = await api(ctx.base, 'POST', '/config', { dataFile: dataFile });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);

  // 配置生效：health / state
  const health = await api(ctx.base, 'GET', '/health');
  assert.equal(health.json.configured, true);
  assert.equal(health.json.dataFile, dataFile);

  const state = await api(ctx.base, 'GET', '/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(typeof state.json.revision, 'string');
  assert.deepEqual(state.json.state.groups, []);
  assert.deepEqual(state.json.state.items, []);

  // 重启后从配置文件恢复 dataFile
  await ctx.server.close();
  const restarted = createSyncServer({ configFile: ctx.configFile, port: 0, autoCommit: false, debounceMs: 20 });
  const info2 = await restarted.listen();
  t.after(async function () { await restarted.close().catch(function () {}); });
  const restartedState = await api(info2.url, 'GET', '/state');
  assert.equal(restartedState.status, 200);
  const restartedHealth = await api(info2.url, 'GET', '/health');
  assert.equal(restartedHealth.json.configured, true);
  assert.equal(restartedHealth.json.dataFile, dataFile);
});

test('createSyncServer({dataFile}) 显式参数优先于持久化配置', async function (t) {
  const root = await makeTempDir();
  t.after(async function () { await cleanupDir(root); });

  const persistedDir = path.join(root, 'persisted');
  const explicitDir = path.join(root, 'explicit');
  await fs.mkdir(persistedDir);
  await fs.mkdir(explicitDir);
  const persistedFile = path.join(persistedDir, 'persisted.json');
  const explicitFile = path.join(explicitDir, 'explicit.json');
  const configFile = path.join(root, 'sync-config.json');
  await fs.writeFile(configFile, JSON.stringify({
    dataFile: persistedFile,
    autoCommit: true,
    debounceMs: 4000,
  }), 'utf8');

  const server = createSyncServer({ dataFile: explicitFile, port: 0, autoCommit: false, configFile: configFile });
  const info = await server.listen();
  t.after(async function () { await server.close().catch(function () {}); });

  const config = await api(info.url, 'GET', '/config');
  assert.equal(config.json.dataFile, explicitFile);
  assert.equal(config.json.autoCommit, false);
  assert.equal(config.json.debounceMs, 4000, '未显式传入的 debounceMs 应沿用配置文件');

  const health = await api(info.url, 'GET', '/health');
  assert.equal(health.json.configured, true);
  assert.equal(health.json.dataFile, explicitFile);
});

test('PUT /state 写入分组+条目，落盘正确；再次 PUT 按 updatedAt 合并并返回最新完整 state', async function (t) {
  const ctx = await startServer(t, { autoCommit: false, debounceMs: 20 });
  const dataDir = path.join(ctx.root, 'data');
  await fs.mkdir(dataDir);
  const dataFile = path.join(dataDir, 'notes.json');
  await api(ctx.base, 'POST', '/config', { dataFile: dataFile });

  const empty = await api(ctx.base, 'GET', '/state');
  const rev0 = empty.json.revision;

  const group = {
    id: 'g1',
    name: 'BBC',
    hosts: ['https://www.bbc.com/news'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const firstItem = {
    id: 'i1',
    groupId: 'g1',
    text: 'The quick brown fox jumps over the lazy dog.',
    translation: '敏捷的棕色狐狸',
    note: '第一版',
    pageUrl: PAGE + '#section',
    pageTitle: 'Example Article',
    anchor: { text: 'The quick brown fox', occurrence: 1, prefix: 'x ', suffix: ' jumps' },
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };

  const put1 = await api(ctx.base, 'PUT', '/state', { state: { groups: [group], items: [firstItem] } });
  assert.equal(put1.status, 200);
  assert.equal(put1.json.ok, true);
  assert.match(put1.json.revision, /^[0-9a-f]{16}$/);
  assert.notEqual(put1.json.revision, rev0);
  assert.equal(put1.json.stats.groupsAdded, 1);
  assert.equal(put1.json.stats.itemsAdded, 1);

  // 服务端返回合并后的完整 state（扩展侧直接采用）
  assert.equal(put1.json.state.groups.length, 1);
  assert.deepEqual(put1.json.state.groups[0].hosts, ['bbc.com']);
  assert.equal(put1.json.state.items.length, 1);
  assert.equal(put1.json.state.items[0].pageUrl, PAGE); // hash 被去掉
  assert.equal(put1.json.state.items[0].sourceHost, 'example.com');
  assert.deepEqual(put1.json.state.items[0].anchor, {
    text: 'The quick brown fox',
    occurrence: 1,
    prefix: 'x ',
    suffix: ' jumps',
  });

  // 磁盘内容正确
  const disk1 = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(disk1.version, 2);
  assert.equal(disk1.groups.length, 1);
  assert.equal(disk1.items.length, 1);
  assert.equal(disk1.items[0].text, firstItem.text);
  assert.equal(disk1.items[0].translation, '敏捷的棕色狐狸');
  assert.equal(disk1.updatedAt, put1.json.state.updatedAt);

  const rev1 = put1.json.revision;

  // 第二版：i1 更新译文 + 新增 i2；未提交 groups，旧分组应保留
  const put2 = await api(ctx.base, 'PUT', '/state', {
    state: {
      items: [
        {
          id: 'i1',
          groupId: 'g1',
          text: firstItem.text,
          translation: '新版译文',
          pageUrl: PAGE,
          updatedAt: '2026-01-01T00:00:10.000Z',
        },
        {
          id: 'i2',
          text: 'A brand new sentence.',
          translation: '全新句子',
          pageUrl: PAGE,
          updatedAt: '2026-01-01T00:00:11.000Z',
        },
      ],
    },
  });
  assert.equal(put2.status, 200);
  assert.notEqual(put2.json.revision, rev1);
  assert.equal(put2.json.stats.itemsUpdated, 1);
  assert.equal(put2.json.stats.itemsAdded, 1);
  assert.equal(put2.json.state.groups.length, 1, '旧分组应保留');
  assert.equal(put2.json.state.items.length, 2);
  assert.equal(put2.json.state.items.find(function (it) { return it.id === 'i1'; }).translation, '新版译文');

  const disk2 = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(disk2.items.length, 2);
  assert.equal(disk2.items.find(function (it) { return it.id === 'i1'; }).translation, '新版译文');

  // 旧版本（updatedAt 更早）不应覆盖新版本
  const put3 = await api(ctx.base, 'PUT', '/state', {
    state: {
      items: [
        {
          id: 'i1',
          groupId: 'g1',
          text: firstItem.text,
          translation: '旧版译文',
          pageUrl: PAGE,
          updatedAt: '2026-01-01T00:00:05.000Z',
        },
      ],
    },
  });
  assert.equal(put3.status, 200);
  assert.equal(put3.json.stats.itemsSkipped, 1);
  assert.equal(put3.json.state.items.find(function (it) { return it.id === 'i1'; }).translation, '新版译文');

  // GET 返回刚写入的 revision 和完整 state
  const readBack = await api(ctx.base, 'GET', '/state');
  assert.equal(readBack.status, 200);
  assert.equal(readBack.json.revision, put3.json.revision);
  assert.equal(readBack.json.state.items.length, 2);
});

test('外部修改数据文件后 GET /state 返回新 revision；PUT 触发 debounce 后的 git 自动提交', { skip: !GIT_AVAILABLE && 'git 不可用，跳过 git 集成测试' }, async function (t) {
  const ctx = await startServer(t, { autoCommit: true, debounceMs: 30 });

  // 临时 git 仓库
  const repoDir = path.join(ctx.root, 'repo');
  await fs.mkdir(repoDir);
  assert.equal((await run('git', ['init', '-q'], repoDir)).code, 0);
  assert.equal((await run('git', ['config', 'user.name', 'English Notebook Test'], repoDir)).code, 0);
  assert.equal((await run('git', ['config', 'user.email', 'test@example.com'], repoDir)).code, 0);
  assert.equal((await run('git', ['config', 'commit.gpgsign', 'false'], repoDir)).code, 0);

  const dataDir = path.join(repoDir, 'data');
  await fs.mkdir(dataDir);
  const dataFile = path.join(dataDir, 'notes.json');

  const created = await api(ctx.base, 'POST', '/config', { dataFile: dataFile });
  assert.equal(created.status, 200);
  assert.equal(created.json.git.repo, true);
  assert.equal(path.resolve(created.json.git.root), path.resolve(repoDir));

  const health = await api(ctx.base, 'GET', '/health');
  assert.equal(health.json.configured, true);
  assert.equal(health.json.git.repo, true);
  assert.equal(path.resolve(health.json.git.root), path.resolve(repoDir));

  const rev0 = (await api(ctx.base, 'GET', '/state')).json.revision;
  const put1 = await api(ctx.base, 'PUT', '/state', {
    state: {
      groups: [{ id: 'g1', name: 'Git 组', hosts: [] }],
      items: [{ id: 'i1', text: 'Committed sentence.', pageUrl: PAGE, updatedAt: '2026-01-01T00:00:01.000Z' }],
    },
  });
  assert.equal(put1.status, 200);
  assert.equal(put1.json.stats.itemsAdded, 1);
  const rev1 = put1.json.revision;
  assert.notEqual(rev1, rev0);

  // debounce 到期后自动 commit（消息前缀符合契约）
  const subjects1 = await waitForGitLog(repoDir, dataFile, 1);
  assert.match(subjects1[0], /^notes: 自动同步 /);

  // 只提交数据文件，不 push
  const show = await run('git', ['-C', repoDir, 'show', '--name-only', '--pretty=format:', 'HEAD']);
  assert.equal(show.code, 0);
  assert.deepEqual(show.stdout.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean), ['data/notes.json']);

  // 外部改动数据文件（模拟编辑器/其他进程写入）-> revision 必须变化
  const external = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  external.items.push({
    id: 'i-ext',
    text: '外部新增的句子',
    pageUrl: PAGE,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  external.updatedAt = '2026-01-02T00:00:00.000Z';
  await fs.writeFile(dataFile, JSON.stringify(external, null, 2) + '\n', 'utf8');

  const afterExternal = await api(ctx.base, 'GET', '/state');
  assert.equal(afterExternal.status, 200);
  assert.notEqual(afterExternal.json.revision, rev1);
  assert.ok(afterExternal.json.state.items.some(function (it) { return it.id === 'i-ext'; }));

  // 外部改动后再 PUT：服务端 merge 外部条目 + 新条目，并再次自动提交
  const put2 = await api(ctx.base, 'PUT', '/state', {
    state: {
      items: [{ id: 'i-new', text: '再新增一句', pageUrl: PAGE, updatedAt: '2026-01-03T00:00:00.000Z' }],
    },
  });
  assert.equal(put2.status, 200);
  assert.ok(put2.json.state.items.some(function (it) { return it.id === 'i-new'; }));
  assert.ok(put2.json.state.items.some(function (it) { return it.id === 'i-ext'; }), '合并结果应保留外部新增条目');
  assert.ok(put2.json.state.items.some(function (it) { return it.id === 'i1'; }), '合并结果应保留已提交条目');

  const subjects2 = await waitForGitLog(repoDir, dataFile, 2);
  assert.match(subjects2[0], /^notes: 自动同步 /);
});

test('start-sync.bat 存在且指向 sync-server.mjs', async function () {
  const bat = await fs.readFile(path.join(REPO_ROOT, 'sync-server', 'start-sync.bat'), 'utf8');
  assert.match(bat, /sync-server\.mjs/);
  assert.match(bat, /pause/);
});
