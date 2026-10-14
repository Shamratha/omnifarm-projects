import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openCatalog, listPhotos, catalogSummary, listSavedSearches, createSavedSearch, deleteSavedSearch, exportCatalog, replaceCatalog, listSearchHistory, deleteSearchHistory, createSearchHistory } from './catalog.mjs';
import { parseSearchText, validateReferenceDate } from './parser.mjs';
import { explainPhotoMatch } from './explain.mjs';
import { compileQuery, emptyQuery, QueryValidationError } from './query.mjs';

const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_DIR = resolve(SERVER_DIR, '..');
const DEFAULT_DB = join(SERVER_DIR, 'data', 'catalog.sqlite');
const PHOTO_DIR = join(PROJECT_DIR, 'public', 'photos');
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function sendDownloadJson(response, filename, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function errorResponse(response, status, message, code = 'BAD_REQUEST') {
  sendJson(response, status, { error: { code, message } });
}

async function readJson(request) {
  let size = 0;
  let body = '';
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    body += chunk;
  }
  if (!body.trim()) throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400, code: 'INVALID_JSON' });
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400, code: 'INVALID_JSON' });
  }
}

function validateSearchBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QueryValidationError('Search body must be an object');
  const query = body.query === undefined ? emptyQuery() : body.query;
  const sort = body.sort === undefined ? 'newest' : body.sort;
  if (!['newest', 'oldest', 'title'].includes(sort)) throw new QueryValidationError('Sort must be newest, oldest, or title');
  return { query, sort };
}

function servePhoto(request, response, pathname, photoDirectory) {
  const filename = decodeURIComponent(pathname.slice('/photos/'.length));
  const safePath = normalize(join(photoDirectory, filename));
  if (!safePath.startsWith(`${photoDirectory}/`) || !safePath.endsWith('.svg') || !existsSync(safePath) || !statSync(safePath).isFile()) {
    errorResponse(response, 404, 'Photo not found', 'NOT_FOUND');
    return;
  }
  response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
  createReadStream(safePath).pipe(response);
}

export function createBackend({ dbPath = DEFAULT_DB, photoDir = PHOTO_DIR } = {}) {
  mkdirSync(photoDir, { recursive: true });
  const db = openCatalog(dbPath);
  const requestHandler = async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/catalog') {
        sendJson(response, 200, catalogSummary(db));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/catalog/export') {
        sendDownloadJson(response, 'photo-catalog.json', exportCatalog(db));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/catalog/import') {
        const body = await readJson(request);
        const isExport = body && typeof body === 'object' && !Array.isArray(body)
          && Object.keys(body).length === 3 && Object.hasOwn(body, 'photos') && body.version === 1
          && typeof body.exportedAt === 'string' && !Number.isNaN(Date.parse(body.exportedAt));
        const photos = Array.isArray(body) ? body : body && typeof body === 'object' && !Array.isArray(body)
          && Object.hasOwn(body, 'photos') && (Object.keys(body).length === 1 || isExport) ? body.photos : undefined;
        const imported = replaceCatalog(db, photos);
        sendJson(response, 200, { imported, savedSearches: 'preserved', searchHistory: 'preserved' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/search') {
        const { query, sort } = validateSearchBody(await readJson(request));
        const compiled = compileQuery(query, sort);
        const photos = listPhotos(db, compiled.where, compiled.params, compiled.orderBy).map((photo) => {
          const { matchReasons, matches } = explainPhotoMatch(photo, query);
          return { ...photo, matchReasons, matches };
        });
        createSearchHistory(db, { query, sort, resultCount: photos.length });
        sendJson(response, 200, { photos, total: photos.length });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/search-history') {
        sendJson(response, 200, listSearchHistory(db));
        return;
      }
      if (request.method === 'DELETE' && url.pathname === '/api/search-history') {
        const deleted = deleteSearchHistory(db);
        sendJson(response, 200, { deleted });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/parse') {
        const body = await readJson(request);
        if (!body || Array.isArray(body) || typeof body.text !== 'string') throw new QueryValidationError('Parse body requires a text string');
        sendJson(response, 200, parseSearchText(body.text, body.referenceDate, catalogSummary(db).facets.locations));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/saved-searches') {
        sendJson(response, 200, listSavedSearches(db));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/saved-searches') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QueryValidationError('Saved search body must be an object');
        if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 80) {
          throw new QueryValidationError('Saved search name must be 1 to 80 characters');
        }
        compileQuery(body.query);
        const referenceDate = validateReferenceDate(body.referenceDate);
        sendJson(response, 201, createSavedSearch(db, { name: body.name.trim(), query: body.query, referenceDate }));
        return;
      }
      const savedSearchMatch = url.pathname.match(/^\/api\/saved-searches\/([^/]+)$/);
      if (request.method === 'DELETE' && savedSearchMatch) {
        const id = decodeURIComponent(savedSearchMatch[1]);
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new QueryValidationError('Saved search id must be a positive integer');
        if (!deleteSavedSearch(db, Number(id))) {
          errorResponse(response, 404, 'Saved search not found', 'NOT_FOUND');
          return;
        }
        sendJson(response, 200, { id: Number(id), deleted: true });
        return;
      }
      const photoMatch = url.pathname.match(/^\/api\/photos\/([^/]+)$/);
      if (request.method === 'PATCH' && photoMatch) {
        const id = decodeURIComponent(photoMatch[1]);
        const body = await readJson(request);
        if (!body || typeof body.favorite !== 'boolean') throw new QueryValidationError('Patch body requires favorite as a boolean');
        const result = db.prepare('UPDATE photos SET favorite = ? WHERE id = ?').run(body.favorite ? 1 : 0, id);
        if (result.changes !== 1) {
          errorResponse(response, 404, 'Photo not found', 'NOT_FOUND');
          return;
        }
        const updated = listPhotos(db, 'p.id = ?', [id], 'p.id ASC')[0];
        sendJson(response, 200, updated);
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/photos/')) {
        servePhoto(request, response, url.pathname, photoDir);
        return;
      }
      errorResponse(response, 404, 'Route not found', 'NOT_FOUND');
    } catch (error) {
      const status = error.statusCode ?? (error instanceof QueryValidationError ? 400 : 500);
      if (status >= 500) console.error('[photo-search] request failed', error);
      errorResponse(response, status, error.message || 'Internal server error', error.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'));
    }
  };
  const server = createServer(requestHandler);
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    console.error('[photo-search] client error', error.message);
  });
  return {
    server,
    requestHandler,
    db,
    close() {
      db.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  const backend = createBackend();
  backend.server.listen(Number.isFinite(port) ? port : 3001, '0.0.0.0', () => {
    console.log(`[photo-search] backend listening on http://0.0.0.0:${Number.isFinite(port) ? port : 3001}`);
  });
  const shutdown = () => backend.server.close(() => backend.close());
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
