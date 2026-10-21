/*
 * English Notebook · 内置 PDF 阅读器
 * 用 pdf.js 把 PDF 渲染成 canvas + 可选中的文字层，复用 content.js 的批注 UI。
 * URL: pdfviewer.html?file=<encodeURIComponent(pdfUrl)>
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const file = params.get('file') || '';
  const testReport = params.get('testReport') || '';
  const statusEl = document.getElementById('pdf-status');
  const container = document.getElementById('pdf-container');
  const originalLink = document.getElementById('pdf-original');
  const errorEl = document.getElementById('pdf-error');

  function fail(message) {
    if (statusEl) statusEl.textContent = '加载失败';
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = message;
    }
    console.error('[ENB PDF]', message);
    reportTest({ ok: false, error: message });
  }

  function reportTest(result) {
    if (!testReport) return;
    try {
      const payload = Object.assign({ at: Date.now() }, result);
      const img = new Image();
      img.src = testReport + (testReport.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(JSON.stringify(payload));
    } catch (e) { /* ignore */ }
  }

  if (!file) { fail('缺少 file 参数，无法打开 PDF。'); return; }
  try {
    originalLink.href = file;
  } catch (e) { /* ignore */ }

  const recordButton = document.getElementById('pdf-record');
  if (recordButton) {
    recordButton.addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'TRANSLATE_SELECTION' }, function () {
        void chrome.runtime.lastError;
      });
    });
  }

  const fileName = (function () {
    try {
      const clean = file.split('#')[0].split('?')[0];
      return decodeURIComponent(clean.split('/').pop() || 'document.pdf');
    } catch (e) { return 'document.pdf'; }
  })();
  document.title = fileName + ' · English Notebook PDF';
  /* content.js 用它作为批注的 pageUrl，把批注绑定到 PDF 本身而不是 viewer URL */
  window.__ENB_PAGE_URL = file;
  window.__ENB_PAGE_TITLE = fileName;

  if (!window.pdfjsLib) { fail('pdf.js 没有加载成功，请重新加载扩展。'); return; }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  async function renderTextLayer(page, textLayerDiv, viewport) {
    const textContent = await page.getTextContent();
    if (typeof window.pdfjsLib.renderTextLayer === 'function') {
      await window.pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: viewport,
        textDivs: [],
      }).promise;
      return;
    }
    if (typeof window.pdfjsLib.TextLayer === 'function') {
      const layer = new window.pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: viewport,
      });
      await layer.render();
      return;
    }
    throw new Error('当前 pdf.js 版本不支持文字层渲染');
  }

  async function renderPdf(url) {
    setStatus('下载并解析 PDF…');
    const doc = await window.pdfjsLib.getDocument({ url: url, isEvalSupported: false }).promise;
    const firstPage = await doc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const available = Math.max(520, window.innerWidth - 400);
    const scale = Math.min(1.55, Math.max(0.8, available / baseViewport.width));
    setStatus('共 ' + doc.numPages + ' 页，渲染中…');

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: scale });

      const pageDiv = document.createElement('div');
      pageDiv.className = 'pdf-page';
      pageDiv.style.width = viewport.width + 'px';
      pageDiv.style.height = viewport.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      pageDiv.appendChild(canvas);

      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      textLayerDiv.style.width = viewport.width + 'px';
      textLayerDiv.style.height = viewport.height + 'px';
      textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));
      pageDiv.appendChild(textLayerDiv);

      container.appendChild(pageDiv);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: viewport }).promise;
      await renderTextLayer(page, textLayerDiv, viewport);

      if (pageNumber % 3 === 0 || pageNumber === doc.numPages) {
        setStatus('已渲染 ' + pageNumber + ' / ' + doc.numPages + ' 页');
      }
    }

    setStatus('共 ' + doc.numPages + ' 页 · 可直接选中文字批注');
    /* 等文字层就绪后再让 content.js 重新定位批注 */
    window.dispatchEvent(new CustomEvent('enb-rerender'));
    setTimeout(function () {
      reportTest({
        ok: true,
        pages: doc.numPages,
        spans: document.querySelectorAll('.textLayer span').length,
        status: statusEl ? statusEl.textContent : '',
        enbReady: document.documentElement.getAttribute('data-enb'),
        host: !!document.getElementById('enb-ui-host'),
      });
    }, 800);
  }

  renderPdf(file).catch(function (err) {
    fail('无法加载 PDF：' + ((err && err.message) || err));
  });
})();
