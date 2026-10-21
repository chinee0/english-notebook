/*
 * English Notebook · local file store
 * 用 File System Access API 直接读写用户选择的 JSON 文件。
 * 句柄保存在扩展 origin 的 IndexedDB 里；不经过本地 HTTP 服务，也不做 git。
 */
(function (root) {
  'use strict';

  const DB_NAME = 'enb-fs';
  const STORE = 'handles';
  const KEY = 'dataFile';

  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try { result = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  async function getHandle() {
    try {
      return await withStore('readonly', function (store) {
        return store.get(KEY);
      });
    } catch (e) {
      return null;
    }
  }

  async function setHandle(handle) {
    return withStore('readwrite', function (store) { store.put(handle, KEY); });
  }

  async function clearHandle() {
    return withStore('readwrite', function (store) { store.delete(KEY); });
  }

  async function permission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'unsupported';
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'unknown';
    }
  }

  async function ensurePermission(handle) {
    if (!handle || typeof handle.requestPermission !== 'function') return 'unsupported';
    try {
      return await handle.requestPermission({ mode: 'readwrite' });
    } catch (e) {
      return e && e.name === 'AbortError' ? 'denied' : 'denied';
    }
  }

  async function readFile(handle) {
    const file = await handle.getFile();
    return file.text();
  }

  async function writeFile(handle, text) {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async function fileMeta(handle) {
    try {
      const file = await handle.getFile();
      return { name: file.name, size: file.size, lastModified: file.lastModified };
    } catch (e) {
      return null;
    }
  }

  root.ENB = root.ENB || {};
  root.ENB.FileStore = {
    getHandle: getHandle,
    setHandle: setHandle,
    clearHandle: clearHandle,
    permission: permission,
    ensurePermission: ensurePermission,
    readFile: readFile,
    writeFile: writeFile,
    fileMeta: fileMeta,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
