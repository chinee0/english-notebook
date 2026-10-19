'use strict';

/* English Notebook · toolbar popup（安装自检 + 快捷入口） */

const $ = function (id) { return document.getElementById(id); };

function send(message) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(message, function (resp) {
      void chrome.runtime.lastError;
      resolve(resp || { ok: false });
    });
  });
}

async function init() {
  try {
    $('enb-ver').textContent = '扩展已运行 · v' + chrome.runtime.getManifest().version;
  } catch (e) { /* ignore */ }

  const summary = await send({ type: 'GET_STATE_SUMMARY' });
  if (!summary || !summary.ok) {
    $('stats').textContent = '后台没有响应';
    $('sync').textContent = '请在 edge://extensions 里点“重新加载”，并检查“错误”按钮。';
    return;
  }

  const state = summary.state || {};
  const items = state.items || [];
  const groups = state.groups || [];
  $('stats').textContent = items.length + ' 条批注 · ' + groups.length + ' 个分组';

  const sync = summary.sync || {};
  if (!sync.serverUp) {
    $('sync').textContent = '同步服务未启动：双击 sync-server\\start-sync.bat';
  } else if (!sync.configured) {
    $('sync').textContent = '服务在线，但还没设置数据文件路径（打开设置填写）';
  } else {
    $('sync').textContent = '已连接：' + (sync.dataFile || '');
  }
}

$('btn-capture').addEventListener('click', async function () {
  const btn = $('btn-capture');
  btn.disabled = true;
  btn.textContent = '处理中…';
  const resp = await send({ type: 'TRANSLATE_SELECTION' });
  btn.disabled = false;
  btn.textContent = '翻译并记录选中的英文';
  if (resp && resp.ok) {
    window.close();
  } else {
    $('sync').textContent = '失败：' + ((resp && resp.error) || '未知错误');
  }
});

$('btn-options').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('btn-reload').addEventListener('click', async function () {
  await send({ type: 'RELOAD_EXTENSION' });
  window.close();
});

init();
