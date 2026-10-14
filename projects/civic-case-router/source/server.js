import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const portFlag = process.argv.indexOf('--port');
const hostFlag = process.argv.indexOf('--host');
const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT || 5173);
const host = hostFlag >= 0 ? process.argv[hostFlag + 1] : '127.0.0.1';
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['app', 'data', 'engine'].map((name) => [`/src/${name}.js`, [`src/${name}.js`, 'text/javascript; charset=utf-8']]),
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const entry = publicFiles.get(url.pathname);
  if (!entry || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  try {
    const body = await readFile(fileURLToPath(new URL(entry[0], import.meta.url)));
    response.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Could not load the local app asset.');
  }
});

server.on('error', (error) => {
  console.error(`Could not start CivicFlow: ${error.code || error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`CivicFlow is ready at http://${host}:${server.address().port} — synthetic data only.`));
