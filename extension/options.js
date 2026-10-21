'use strict';

/* English Notebook · options page */

const $ = function (id) { return document.getElementById(id); };

let summary = null;

function send(message) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(message, function (resp) {
      void chrome.runtime.lastError;
      resolve(resp || { ok: false });
    });
  });
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

function esc(value) { return String(value === null || value === undefined ? '' : value); }

/* ---------------- 初始化 ---------------- */

async function load() {
  const resp = await send({ type: 'GET_STATE_SUMMARY' });
  if (!resp || !resp.ok) {
    setStatus($('file-status'), '无法连接扩展后台，请在 chrome://extensions 里重新加载扩展。', 'bad');
    return;
  }
  summary = resp;
  fillSettings();
  loadFileStatus();
  renderGroups();
  renderRecords();
  loadStudyStats();
}

function fillSettings() {
  const settings = summary.settings || {};
  const trans = settings.translation || {};
  const llm = settings.llm || {};
  const custom = trans.custom || {};

  $('trans-provider').value = trans.provider || 'mymemory';
  $('trans-lang').value = trans.targetLang || 'zh-CN';
  $('openai-base').value = llm.baseUrl || 'https://api.deepseek.com';
  $('openai-model').value = llm.model || 'deepseek-chat';
  $('openai-key').value = llm.apiKey || '';
  $('custom-url').value = custom.url || '';
  $('custom-method').value = custom.method || 'GET';
  $('custom-result').value = custom.resultPath || 'translation';
  $('custom-headers').value = custom.headers || '';
  $('custom-body').value = custom.bodyTemplate || '';
  updateProviderFields();
}

/* ---------------- 数据文件（直接读写） ---------------- */

async function loadFileStatus() {
  const resp = await send({ type: 'GET_FILE_STATUS' });
  renderFileStatus(resp && resp.file);
}

function renderFileStatus(file) {
  const el = $('file-status');
  if (!el) return;
  if (!file || !file.configured) {
    setStatus(el, '未选择数据文件。点“选择已有 JSON 文件”或“新建数据文件”开始。', 'bad');
    return;
  }
  if (file.permission !== 'granted') {
    setStatus(el, '已选择：' + (file.name || '数据文件') + '，但需要重新授权。点“重新授权”。', 'bad');
    return;
  }
  const modified = file.lastModified ? fmtDate(new Date(file.lastModified).toISOString()) : '';
  setStatus(el, '已连接：' + (file.name || '数据文件') + '\n大小 ' + (file.size || 0) + ' 字节' + (modified ? ' · 最后修改 ' + modified : ''), 'ok');
}

async function pickFile(saveAs) {
  if (typeof window.showOpenFilePicker !== 'function' && typeof window.showSaveFilePicker !== 'function') {
    window.alert('当前浏览器不支持文件选择器（File System Access API），请使用 Edge 或 Chrome。');
    return;
  }
  const options = {
    types: [{ description: 'English Notebook JSON', accept: { 'application/json': ['.json'] } }],
  };
  try {
    let handle;
    if (saveAs) {
      if (typeof window.showSaveFilePicker !== 'function') { window.alert('当前浏览器不支持“新建文件”，请改用“选择已有文件”'); return; }
      handle = await window.showSaveFilePicker(Object.assign({ suggestedName: 'english-notes.json' }, options));
    } else {
      const picks = await window.showOpenFilePicker(Object.assign({ multiple: false }, options));
      handle = picks && picks[0];
    }
    if (!handle) return;
    /* 先请求权限，再保存句柄；即使权限被拒也保留句柄，方便用户点“重新授权” */
    const permission = await window.ENB.FileStore.ensurePermission(handle);
    await window.ENB.FileStore.setHandle(handle);
    const resp = await send({ type: 'FILE_SELECTED' });
    renderFileStatus(resp && resp.file);
    await load();
    if (permission !== 'granted') {
      setStatus($('file-status'), '已选择文件，但浏览器没有给写权限。请再点一次「重新授权」，在弹窗中选“允许编辑”。', 'bad');
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') window.alert('选择文件失败：' + ((e && e.message) || e));
  }
}

async function reauthorizeFile() {
  const handle = await window.ENB.FileStore.getHandle();
  if (!handle) { window.alert('还没有选择数据文件'); return; }
  const permission = await window.ENB.FileStore.ensurePermission(handle);
  if (permission !== 'granted') {
    setStatus($('file-status'), '没有获得写权限：请在授权弹窗里选“允许编辑”，或改用“新建数据文件”。', 'bad');
    return;
  }
  const resp = await send({ type: 'FILE_SELECTED' });
  renderFileStatus(resp && resp.file);
  await load();
}

async function clearFile() {
  if (!window.confirm('断开数据文件？浏览器里的本地数据仍保留，但不会再写入这个文件。')) return;
  try { await window.ENB.FileStore.clearHandle(); } catch (e) { /* ignore */ }
  const resp = await send({ type: 'CLEAR_FILE' });
  renderFileStatus(resp && resp.file);
  await load();
}

function updateProviderFields() {
  const provider = $('trans-provider').value;
  $('custom-fields').style.display = provider === 'custom' ? 'grid' : 'none';
}

/* ---------------- 学习条目 / 共用 LLM ---------------- */

async function loadStudyStats() {
  const resp = await send({ type: 'GET_STUDY_DATA' });
  const items = resp && resp.ok ? (resp.items || []) : [];
  const el = $('study-stats');
  if (el) el.textContent = '本地学习条目：' + items.length + ' 条（仅本机保存，不参与 git 同步）';
}

function currentLlm() {
  return {
    baseUrl: $('openai-base').value.trim() || 'https://api.deepseek.com',
    model: $('openai-model').value.trim() || 'deepseek-chat',
    apiKey: $('openai-key').value.trim(),
  };
}

async function testAi() {
  const el = $('trans-test-result');
  setStatus(el, '正在保存配置并请求 AI 接口…');
  await send({ type: 'SAVE_SETTINGS', settings: { llm: currentLlm() } });
  const resp = await send({ type: 'TEST_AI' });
  if (resp && resp.ok) {
    setStatus(el, 'AI 连接成功，模型回复：' + resp.text, 'ok');
  } else {
    setStatus(el, 'AI 连接失败：' + ((resp && resp.error) || '未知错误'), 'bad');
  }
}

/* ---------------- 翻译 ---------------- */

async function saveTranslation() {
  const provider = $('trans-provider').value;
  const settings = {
    translation: {
      provider: provider,
      targetLang: $('trans-lang').value.trim() || 'zh-CN',
      custom: {
        url: $('custom-url').value.trim(),
        method: $('custom-method').value,
        headers: $('custom-headers').value.trim(),
        bodyTemplate: $('custom-body').value.trim(),
        resultPath: $('custom-result').value.trim(),
      },
    },
    llm: currentLlm(),
  };
  const resp = await send({ type: 'SAVE_SETTINGS', settings: settings });
  if (resp.ok) {
    await load();
    setStatus($('trans-test-result'), '翻译 / AI 共用配置已保存（API Key 仅本机）', 'ok');
  }
}

async function testTranslation() {
  const el = $('trans-test-result');
  setStatus(el, '正在调用翻译接口…');
  const resp = await send({ type: 'TEST_TRANSLATION', text: 'The committee has yet to reach a decision.' });
  if (resp && resp.ok) {
    setStatus(el, '译文（' + resp.provider + '）：' + resp.text, 'ok');
  } else {
    setStatus(el, '翻译失败：' + ((resp && resp.error) || '未知错误'), 'bad');
  }
}

/* ---------------- 分组 ---------------- */

function renderGroups() {
  const list = $('group-list');
  list.textContent = '';
  const groups = (summary.state && summary.state.groups) || [];
  if (!groups.length) {
    list.appendChild(div('div', 'muted', '还没有分组。新建一个并绑定域名后，在该网站记录的批注会自动归入。'));
    return;
  }
  const items = (summary.state && summary.state.items) || [];
  groups.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN'); }).forEach(function (g) {
    const count = items.filter(function (it) { return it.groupId === g.id; }).length;
    const row = div('div', 'group-row');
    row.appendChild(div('div', 'name', g.name));
    row.appendChild(div('div', 'hosts', g.hosts && g.hosts.length ? g.hosts.join(' · ') : '未绑定域名'));
    row.appendChild(div('div', 'muted', count + ' 条'));
    row.appendChild(div('div', 'spacer'));
    row.appendChild(btn('编辑', 'small', function () { editGroup(g); }));
    row.appendChild(btn('删除', 'small danger', function () { deleteGroup(g); }));
    list.appendChild(row);
  });
}

async function addGroup() {
  const name = $('group-name').value.trim();
  const hosts = $('group-hosts').value.split(/[,，\s]+/).filter(Boolean);
  if (!name) { setStatus($('file-status'), '请填写分组名称', 'bad'); return; }
  await send({ type: 'ADD_GROUP', name: name, hosts: hosts });
  $('group-name').value = '';
  $('group-hosts').value = '';
  await load();
}

async function editGroup(group) {
  const name = window.prompt('分组名称', group.name);
  if (name === null) return;
  const hosts = window.prompt('绑定域名（空格或逗号分隔）', (group.hosts || []).join(' '));
  if (hosts === null) return;
  await send({
    type: 'UPDATE_GROUP',
    id: group.id,
    patch: { name: name.trim(), hosts: hosts.split(/[,，\s]+/).filter(Boolean) },
  });
  await load();
}

async function deleteGroup(group) {
  if (!window.confirm('删除分组「' + group.name + '」？组内批注会变成未分组。')) return;
  await send({ type: 'DELETE_GROUP', id: group.id });
  await load();
}

/* ---------------- 记录 ---------------- */

function renderRecords() {
  const list = $('record-list');
  list.textContent = '';
  if (!summary || !summary.state) return;
  const query = ($('record-search').value || '').trim().toLowerCase();
  let items = (summary.state.items || []).slice();
  if (query) {
    items = items.filter(function (it) {
      return (it.text + ' ' + (it.translation || '') + ' ' + (it.pageTitle || '')).toLowerCase().indexOf(query) !== -1;
    });
  }
  items.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
  $('record-count').textContent = '共 ' + items.length + ' 条' + (items.length > 300 ? '（只显示前 300 条）' : '');
  items = items.slice(0, 300);

  if (!items.length) {
    list.appendChild(div('div', 'muted', query ? '没有匹配的批注。' : '还没有批注。安装扩展后到网页上选中英文右键记录。'));
    return;
  }

  const groups = (summary.state.groups || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-CN'); });

  items.forEach(function (it) {
    const row = div('div', 'item-row');
    row.appendChild(div('div', 'quote', it.text));
    row.appendChild(div('div', 'meta', [it.pageTitle || it.pageUrl, it.sourceHost, fmtDate(it.createdAt)].filter(Boolean).join(' · ')));

    const line = div('div', 'line');
    const trans = document.createElement('input');
    trans.type = 'text';
    trans.value = it.translation || '';
    trans.placeholder = '译文';
    trans.addEventListener('change', async function () {
      await send({ type: 'UPDATE_ITEM', id: it.id, patch: { translation: trans.value.trim() } });
      it.translation = trans.value.trim();
    });
    line.appendChild(trans);

    const select = document.createElement('select');
    select.appendChild(opt('', '未分组'));
    groups.forEach(function (g) { select.appendChild(opt(g.id, g.name)); });
    select.value = it.groupId || '';
    select.addEventListener('change', async function () {
      await send({ type: 'UPDATE_ITEM', id: it.id, patch: { groupId: select.value || null } });
    });
    line.appendChild(select);

    line.appendChild(btn('删除', 'small danger', async function () {
      if (!window.confirm('删除这条批注？其嵌套批注也会一起删除。')) return;
      await send({ type: 'DELETE_ITEM', id: it.id });
      await load();
    }));
    row.appendChild(line);
    list.appendChild(row);
  });
}

/* ---------------- 导入 / 导出 ---------------- */

function exportJson() {
  if (!summary || !summary.state) return;
  const data = {
    version: 2,
    exportedAt: new Date().toISOString(),
    groups: summary.state.groups,
    items: summary.state.items,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'english-notes-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
}

async function importJson(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { window.alert('不是合法的 JSON 文件'); return; }
  if (!data || !Array.isArray(data.groups) || !Array.isArray(data.items)) {
    window.alert('JSON 结构不正确：需要 groups 和 items 数组');
    return;
  }
  if (!window.confirm('合并导入？同 id 会保留更新时间较新的版本。')) return;
  const resp = await send({ type: 'IMPORT_STATE', state: data, mode: 'merge' });
  if (resp.ok) {
    await load();
    window.alert('导入完成');
  } else {
    window.alert('导入失败：' + (resp.error || '未知错误'));
  }
}

/* ---------------- 小工具 ---------------- */

function div(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function btn(label, className, handler) {
  const b = document.createElement('button');
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', handler);
  return b;
}

function opt(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

/* ---------------- 事件绑定 ---------------- */

$('btn-choose-file').addEventListener('click', function () { pickFile(false); });
$('btn-new-file').addEventListener('click', function () { pickFile(true); });
$('btn-reauthorize').addEventListener('click', function () { reauthorizeFile(); });
$('btn-clear-file').addEventListener('click', function () { clearFile(); });

$('btn-save-trans').addEventListener('click', function () { saveTranslation(); });
$('btn-test-trans').addEventListener('click', function () { testTranslation(); });
$('btn-test-ai').addEventListener('click', function () { testAi(); });
$('trans-provider').addEventListener('change', updateProviderFields);

$('btn-add-group').addEventListener('click', function () { addGroup(); });

$('record-search').addEventListener('input', function () { renderRecords(); });
$('btn-export').addEventListener('click', exportJson);
$('btn-import').addEventListener('click', function () { $('import-file').click(); });
$('import-file').addEventListener('change', function (e) {
  const file = e.target.files && e.target.files[0];
  if (file) importJson(file);
  e.target.value = '';
});

load();
