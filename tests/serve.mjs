import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

let lastReport = null;

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);

  if (req.method === 'POST' && urlPath === '/report') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        lastReport = JSON.parse(body);
      } catch (e) {
        lastReport = { error: 'bad json' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (urlPath === '/report') {
    const q = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('q');
    if (q) {
      try { lastReport = JSON.parse(q); } catch (e) { lastReport = { error: 'bad json' }; }
    }
    if (lastReport) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lastReport));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"no report yet"}');
    }
    return;
  }

  const rel = urlPath === '/' ? 'tests/render-smoke.html' : urlPath.replace(/^\/+/, '');
  const file = join(root, rel);
  if (!file.startsWith(root + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log('PORT ' + server.address().port);
});
