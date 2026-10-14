import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.resolve(root, `.${requested}`);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

async function readAsset(urlPath) {
  const requested = safePath(urlPath);
  if (!requested) return null;
  try {
    return { filePath: requested, content: await readFile(requested) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!path.extname(requested)) {
      const fallback = path.join(root, 'index.html');
      return { filePath: fallback, content: await readFile(fallback) };
    }
    return null;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const asset = await readAsset(request.url || '/');
    if (!asset) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const contentType = mimeTypes[path.extname(asset.filePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    if (request.method !== 'HEAD') response.end(asset.content);
    else response.end();
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Internal server error');
    console.error(error);
  }
});

server.listen(port, host, () => {
  console.log(`Budget Commitment Monitor running at http://${host}:${server.address().port}`);
});
