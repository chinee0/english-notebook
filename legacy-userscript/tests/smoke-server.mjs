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

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'tests/ui-smoke.html' : urlPath.replace(/^\/+/, '');
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
  const { port } = server.address();
  console.log('PORT ' + port);
});
