import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = createServer(async (request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end('Method not allowed');
    return;
  }
  let requested;
  try {
    requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400);
    response.end('Invalid URL');
    return;
  }
  const base = resolve(root, requested.startsWith('/src/') ? 'src' : 'public');
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/src\//, '').replace(/^\/+/, '');
  const safePath = resolve(base, relative);
  if (!safePath.startsWith(`${base}${sep}`)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  try {
    const body = await readFile(safePath);
    response.writeHead(200, {
      'Content-Type': types[extname(safePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`P4 Trace Explorer running at http://localhost:${server.address().port}`);
});
