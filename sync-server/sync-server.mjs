/*
 * English Notebook · 本地同步服务
 * ---------------------------------------------------------------------------
 * 浏览器扩展 <-> 本地数据文件 的 HTTP 桥：
 *   - 只监听 127.0.0.1，默认端口 17890
 *   - GET  /health       服务 / 配置 / git 状态
 *   - GET  /config       当前配置 { dataFile, autoCommit, debounceMs }
 *   - POST /config       设置数据文件绝对路径（持久化到 sync-server/sync-config.json）
 *   - GET  /state        读取数据文件（返回规范化后的 state + revision）
 *   - PUT  /state        与文件现有内容 merge（core.mergeImport），写回并返回完整 state
 *
 * 数据合并逻辑全部复用 ../extension/core.js，服务端不重复实现。
 * 写文件后 debounce 自动 git commit（只 add 数据文件，不 push；失败静默降级）。
 * ---------------------------------------------------------------------------
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {any} UMD 核心模块（normalizeState / addItem / mergeImport / exportState / nowIso ...） */
const core = require('../extension/core.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = '127.0.0.1';
const DEFAULT_PORT = 17890;
const DEFAULT_DEBOUNCE_MS = 4000;
const SERVER_NAME = 'english-notebook-sync';
const SERVER_VERSION = 1;
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'sync-config.json');
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

/** 文件内容 revision（内容 hash，任何外部改动都会变化）。 */
function revisionOf(content) {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 16);
}

function serializeState(state) {
  return JSON.stringify(state, null, 2) + '\n';
}

/**
 * 读取并规范化数据文件。
 * 文件不存在 / 内容损坏都不抛错，返回空 state（便于扩展首次同步）。
 * @returns {Promise<{state:any, revision:string, exists:boolean}>}
 */
async function readStateFile(dataFile) {
  let content;
  try {
    content = await fs.readFile(dataFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { state: core.normalizeState(null), revision: 'empty', exists: false };
    }
    throw err;
  }
  const revision = revisionOf(content);
  let raw = null;
  try {
    raw = content.trim() ? JSON.parse(content) : null;
  } catch (err) {
    raw = null; // 文件被外部改坏时按空状态处理，PUT 时会被合并写回
  }
  return { state: core.normalizeState(raw), revision, exists: true };
}

/** 原子写入数据文件（同目录临时文件 + rename，失败回退直接写）。 */
async function writeStateFile(dataFile, state) {
  const content = serializeState(state);
  const dir = path.dirname(dataFile);
  const tmp = path.join(dir, `.${path.basename(dataFile)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, dataFile);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(function () {});
    await fs.writeFile(dataFile, content, 'utf8');
  }
  return content;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }, CORS_HEADERS));
  res.end(body);
}

/** 读取 JSON 请求体；空 body 视为 {}。 */
function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('请求体过大');
        err.code = 'payload_too_large';
        fail(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (err) {
        const e = new Error('请求体不是合法 JSON');
        e.code = 'invalid_json';
        fail(e);
      }
    });
    req.on('error', fail);
  });
}

/* ------------------------------------------------------------------ */
/* git 集成                                                            */
/* ------------------------------------------------------------------ */

/**
 * 执行 git 命令并返回 {code, stdout, stderr}（永不 reject）。
 * code: 进程退出码；git 不存在时为 -1。
 */
function runGit(args) {
  return new Promise(function (resolve) {
    execFile(
      'git',
      args,
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      function (err, stdout, stderr) {
        const code = !err ? 0 : (typeof err.code === 'number' ? err.code : -1);
        resolve({ code: code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

/** 返回数据文件所在 git 仓库根目录；不是仓库 / 没有 git 时返回 null。 */
async function gitTopLevel(dir) {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return null;
  } catch (err) {
    return null;
  }
  const res = await runGit(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (res.code !== 0) return null;
  const root = res.stdout.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)[0];
  return root || null;
}

/** GET /health 里的 git 信息。 */
async function gitInfo(dataFile) {
  if (!dataFile) return { repo: false, root: null };
  const root = await gitTopLevel(path.dirname(dataFile));
  return root ? { repo: true, root: root } : { repo: false, root: null };
}

/**
 * 把数据文件提交到它所在的 git 仓库。
 * 只 `git add` 数据文件、只提交该路径；非仓库 / 无 git / 提交失败一律静默返回。
 * @returns {Promise<{repo:boolean, committed:boolean, root?:string, reason?:string}>}
 */
async function gitCommit(dataFile) {
  const root = await gitTopLevel(path.dirname(dataFile));
  if (!root) return { repo: false, committed: false, reason: 'not_a_git_repo' };

  const add = await runGit(['-C', root, 'add', '--', dataFile]);
  if (add.code !== 0) return { repo: true, committed: false, root: root, reason: 'git_add_failed' };

  const staged = await runGit(['-C', root, 'diff', '--cached', '--quiet', '--', dataFile]);
  if (staged.code === 0) return { repo: true, committed: false, root: root, reason: 'no_changes' };
  if (staged.code !== 1) return { repo: true, committed: false, root: root, reason: 'git_diff_failed' };

  // 时间用本地时区更符合用户直觉
  const message = 'notes: 自动同步 ' + nowIso();
  let commit = await runGit(['-C', root, 'commit', '-m', message, '--', dataFile]);
  if (commit.code !== 0 && /user\.name|user\.email|auto-detect|empty ident|Author identity unknown|Please tell me who you are/i.test(commit.stdout + '\n' + commit.stderr)) {
    // 用户没配置 git 身份时给一次兜底，避免自动提交彻底失效
    commit = await runGit([
      '-C', root,
      '-c', 'user.name=english-notebook',
      '-c', 'user.email=english-notebook@localhost',
      'commit', '-m', message, '--', dataFile,
    ]);
  }
  if (commit.code !== 0) return { repo: true, committed: false, root: root, reason: 'git_commit_failed' };
  return { repo: true, committed: true, root: root };
}

/* ------------------------------------------------------------------ */
/* 服务器工厂                                                          */
/* ------------------------------------------------------------------ */

/**
 * 创建同步服务（不自动 listen）。
 * @param {object} [opts]
 * @param {string|null} [opts.dataFile] 初始数据文件绝对路径（不写入配置文件，仅本次进程生效）
 * @param {number} [opts.port=17890] 监听端口，测试可传 0 用随机端口
 * @param {boolean} [opts.autoCommit=true] 是否在写文件后自动 git commit
 * @param {number} [opts.debounceMs=4000] 自动提交 debounce
 * @param {string} [opts.configFile] 配置文件路径（默认 sync-server/sync-config.json，测试可覆盖）
 * @param {string} [opts.host='127.0.0.1'] 监听地址（不鼓励修改）
 */
export function createSyncServer(opts) {
  opts = opts || {};
  const configFile = opts.configFile ? path.resolve(opts.configFile) : DEFAULT_CONFIG_FILE;

  const config = {
    dataFile: null,
    autoCommit: typeof opts.autoCommit === 'boolean' ? opts.autoCommit : true,
    debounceMs: Number.isFinite(Number(opts.debounceMs)) && Number(opts.debounceMs) >= 0
      ? Number(opts.debounceMs)
      : DEFAULT_DEBOUNCE_MS,
  };

  // 显式传入的选项（CLI / 测试）优先于持久化配置
  const explicit = {
    dataFile: typeof opts.dataFile === 'string' && opts.dataFile.trim() !== '',
    autoCommit: typeof opts.autoCommit === 'boolean',
    debounceMs: Number.isFinite(Number(opts.debounceMs)) && Number(opts.debounceMs) >= 0,
  };

  /** 显式传入的 dataFile 仅本次进程生效（不落盘，避免测试污染真实配置）。 */
  if (explicit.dataFile) {
    config.dataFile = path.resolve(opts.dataFile.trim());
  }

  let debounceTimer = null;
  let pendingCommit = false;
  let gitChain = Promise.resolve();
  let listening = false;

  /* ---------------- 配置持久化 ---------------- */

  async function loadConfig() {
    try {
      const raw = await fs.readFile(configFile, 'utf8');
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (!explicit.dataFile && typeof saved.dataFile === 'string' && saved.dataFile.trim()) {
          config.dataFile = path.resolve(saved.dataFile.trim());
        }
        if (!explicit.autoCommit && typeof saved.autoCommit === 'boolean') config.autoCommit = saved.autoCommit;
        if (!explicit.debounceMs && Number.isFinite(saved.debounceMs) && saved.debounceMs >= 0) {
          config.debounceMs = saved.debounceMs;
        }
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        // 配置文件损坏 / 不可读：使用默认配置继续启动
      }
    }
  }

  async function saveConfig() {
    const payload = {
      dataFile: config.dataFile,
      autoCommit: config.autoCommit,
      debounceMs: config.debounceMs,
    };
    const body = JSON.stringify(payload, null, 2) + '\n';
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, body, 'utf8');
  }

  /* ---------------- debounce git ---------------- */

  async function flushGit() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingCommit) {
      pendingCommit = false;
      const target = config.dataFile;
      if (target) {
        gitChain = gitChain.then(function () {
          return gitCommit(target).catch(function () { return null; });
        });
      }
    }
    await gitChain;
  }

  function scheduleGitCommit() {
    if (!config.autoCommit || !config.dataFile) return;
    pendingCommit = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      if (!pendingCommit) return;
      pendingCommit = false;
      const target = config.dataFile;
      if (!target) return;
      gitChain = gitChain.then(function () {
        return gitCommit(target).catch(function () { return null; });
      });
    }, config.debounceMs);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  }

  /* ---------------- 业务处理 ---------------- */

  function requireConfigured(res) {
    if (config.dataFile) return false;
    sendJson(res, 409, { ok: false, error: 'not_configured' });
    return true;
  }

  /** 校验 POST /config 的数据文件路径；成功时返回 {dataFile, exists}。 */
  async function validateDataFile(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { error: 'invalid_path', message: 'dataFile 必须是非空字符串' };
    }
    const candidate = raw.trim();
    if (!path.isAbsolute(candidate)) {
      return { error: 'path_not_absolute', message: 'dataFile 必须是绝对路径' };
    }
    const dataFile = path.normalize(candidate);
    const parent = path.dirname(dataFile);
    try {
      const pst = await fs.stat(parent);
      if (!pst.isDirectory()) return { error: 'parent_directory_missing', message: '父目录不存在' };
    } catch (err) {
      return { error: 'parent_directory_missing', message: '父目录不存在: ' + parent };
    }
    let exists = false;
    try {
      const st = await fs.stat(dataFile);
      if (st.isDirectory()) return { error: 'invalid_path', message: 'dataFile 指向一个目录: ' + dataFile };
      exists = true;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        exists = false;
      } else {
        throw err;
      }
    }
    return { dataFile: dataFile, exists: exists };
  }

  async function handleHealth(res) {
    const git = await gitInfo(config.dataFile);
    sendJson(res, 200, {
      ok: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      configured: Boolean(config.dataFile),
      dataFile: config.dataFile || null,
      git: git,
    });
  }

  function handleGetConfig(res) {
    sendJson(res, 200, {
      dataFile: config.dataFile || null,
      autoCommit: config.autoCommit,
      debounceMs: config.debounceMs,
    });
  }

  async function handlePostConfig(req, res) {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'invalid_body', message: '请求体必须是 JSON 对象' });
      return;
    }
    if (body.autoCommit !== undefined && typeof body.autoCommit !== 'boolean') {
      sendJson(res, 400, { ok: false, error: 'invalid_auto_commit', message: 'autoCommit 必须是布尔值' });
      return;
    }
    if (body.debounceMs !== undefined) {
      const n = Number(body.debounceMs);
      if (!Number.isFinite(n) || n < 0) {
        sendJson(res, 400, { ok: false, error: 'invalid_debounce', message: 'debounceMs 必须是非负数字' });
        return;
      }
    }

    const checked = await validateDataFile(body.dataFile);
    if (checked.error) {
      sendJson(res, 400, { ok: false, error: checked.error, message: checked.message });
      return;
    }

    let created = false;
    if (!checked.exists) {
      await writeStateFile(checked.dataFile, core.normalizeState(null));
      created = true;
    }
    if (typeof body.autoCommit === 'boolean') config.autoCommit = body.autoCommit;
    if (body.debounceMs !== undefined) config.debounceMs = Number(body.debounceMs);
    config.dataFile = checked.dataFile;
    await saveConfig();

    const git = await gitInfo(config.dataFile);
    sendJson(res, 200, { ok: true, dataFile: config.dataFile, created: created, git: git });
  }

  async function handleGetState(res) {
    if (requireConfigured(res)) return;
    const loaded = await readStateFile(config.dataFile);
    sendJson(res, 200, { ok: true, revision: loaded.revision, state: loaded.state });
  }

  async function handlePutState(req, res) {
    if (requireConfigured(res)) return;
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
      sendJson(res, 400, { ok: false, error: 'invalid_state', message: '请求体必须形如 { state: object }' });
      return;
    }

    const current = await readStateFile(config.dataFile);
    const merged = core.mergeImport(current.state, body.state, 'merge');
    const content = await writeStateFile(config.dataFile, merged.state);
    const revision = revisionOf(content);
    scheduleGitCommit();
    sendJson(res, 200, { ok: true, revision: revision, state: merged.state, stats: merged.stats });
  }

  async function route(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://' + HOST);
    let pathname = url.pathname || '/';
    while (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (pathname === '/health') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return handleHealth(res);
    }
    if (pathname === '/config') {
      if (method === 'GET') return handleGetConfig(res);
      if (method === 'POST') return handlePostConfig(req, res);
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    if (pathname === '/state') {
      if (method === 'GET') return handleGetState(res);
      if (method === 'PUT') return handlePutState(req, res);
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  const server = http.createServer(function (req, res) {
    route(req, res).catch(function (err) {
      if (res.headersSent) {
        try { res.end(); } catch (e) { /* ignore */ }
        return;
      }
      if (err && err.code === 'invalid_json') {
        sendJson(res, 400, { ok: false, error: 'invalid_json', message: err.message });
        return;
      }
      if (err && err.code === 'payload_too_large') {
        sendJson(res, 413, { ok: false, error: 'payload_too_large', message: err.message });
        return;
      }
      sendJson(res, 500, { ok: false, error: 'internal_error', message: String(err && err.message || err) });
    });
  });

  const requestedPort = Number.isFinite(Number(opts.port)) ? Number(opts.port) : DEFAULT_PORT;
  const bindHost = typeof opts.host === 'string' && opts.host ? opts.host : HOST;

  /** 开始监听（先加载持久化配置）。 @returns {Promise<{host:string, port:number, url:string}>} */
  async function listen() {
    await loadConfig();
    await new Promise(function (resolve, reject) {
      function onError(err) { server.removeListener('listening', onListening); reject(err); }
      function onListening() { server.removeListener('error', onError); resolve(); }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(requestedPort, bindHost);
    });
    listening = true;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : requestedPort;
    return { host: bindHost, port: port, url: 'http://' + bindHost + ':' + port };
  }

  /** 停止服务：先 flush 未执行的 debounce git commit，再关闭 HTTP。 */
  async function close() {
    try { await flushGit(); } catch (err) { /* 静默 */ }
    if (!listening) return;
    listening = false;
    await new Promise(function (resolve) {
      server.close(function () { resolve(); });
    });
  }

  return {
    server: server,
    configFile: configFile,
    listen: listen,
    close: close,
    flushGit: flushGit,
    gitInfo: function () { return gitInfo(config.dataFile); },
    get dataFile() { return config.dataFile; },
    get config() { return { dataFile: config.dataFile, autoCommit: config.autoCommit, debounceMs: config.debounceMs }; },
    get port() {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { port: undefined, file: undefined, debounceMs: undefined, noGit: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') out.file = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--debounce') out.debounceMs = Number(argv[++i]);
    else if (arg === '--no-git') out.noGit = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--file=')) out.file = arg.slice('--file='.length);
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--debounce=')) out.debounceMs = Number(arg.slice('--debounce='.length));
    else out.unknown.push(arg);
  }
  return out;
}

function printUsage() {
  console.log('用法: node sync-server.mjs [选项]');
  console.log('');
  console.log('  --file <绝对路径>   预置数据文件（仅本次进程生效，也可由扩展 POST /config 设置）');
  console.log('  --port <端口>       监听端口，默认 17890');
  console.log('  --debounce <毫秒>   自动 git commit 的 debounce，默认 4000');
  console.log('  --no-git            禁用自动 git commit');
  console.log('  -h, --help          显示本帮助');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.unknown.length) {
    console.error('未知参数: ' + args.unknown.join(' '));
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (args.file && !path.isAbsolute(args.file)) {
    console.error('错误: --file 必须是绝对路径，收到: ' + args.file);
    process.exitCode = 1;
    return;
  }
  if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)) {
    console.error('错误: --port 必须是 0-65535 的整数，收到: ' + args.port);
    process.exitCode = 1;
    return;
  }
  if (args.debounceMs !== undefined && (!Number.isFinite(args.debounceMs) || args.debounceMs < 0)) {
    console.error('错误: --debounce 必须是非负数字，收到: ' + args.debounceMs);
    process.exitCode = 1;
    return;
  }

  const service = createSyncServer({
    dataFile: args.file,
    port: args.port,
    debounceMs: args.debounceMs,
    // 只有显式 --no-git 时才覆盖持久化配置里的 autoCommit
    autoCommit: args.noGit ? false : undefined,
  });

  let info;
  try {
    info = await service.listen();
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('启动失败: 端口 ' + (args.port === undefined ? 17890 : args.port) + ' 已被占用。');
      console.error('可以换端口启动: node sync-server.mjs --port 17891');
    } else {
      console.error('启动失败: ' + String(err && err.message || err));
    }
    process.exitCode = 1;
    return;
  }

  const cfg = service.config;
  const git = await service.gitInfo();

  console.log('');
  console.log('English Notebook 本地同步服务已启动');
  console.log('  服务地址: ' + info.url);
  console.log('  配置文件: ' + service.configFile);
  console.log('  数据文件: ' + (cfg.dataFile || '(未配置，等待扩展 POST /config 设置)'));
  if (!cfg.autoCommit) {
    console.log('  git 状态: 自动提交已禁用（--no-git）');
  } else if (git.repo) {
    console.log('  git 状态: 自动提交已启用，仓库 ' + git.root + '，debounce ' + cfg.debounceMs + 'ms');
  } else {
    console.log('  git 状态: 未检测到 git 仓库（自动提交会静默跳过）');
  }
  console.log('  结束提示: 按 Ctrl+C 停止服务');
  console.log('');

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    console.log('正在停止服务...');
    try {
      await service.close();
    } catch (err) {
      /* 静默 */
    }
    console.log('服务已停止。');
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(function (err) {
    console.error('未捕获错误: ' + String(err && err.stack || err));
    process.exit(1);
  });
}
