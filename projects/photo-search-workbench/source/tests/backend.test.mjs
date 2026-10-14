import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createBackend } from '../server/index.mjs';
import { parseSearchText } from '../server/parser.mjs';
import { compileQuery, emptyQuery, QueryValidationError } from '../server/query.mjs';
import { catalogPhotos, openCatalog, listPhotos, listSavedSearches, replaceCatalog, validateCatalogPhotos, createSearchHistory } from '../server/catalog.mjs';
import { explainPhotoMatch } from '../server/explain.mjs';

const root = mkdtempSync(join(tmpdir(), 'photo-search-backend-'));
const backend = createBackend({ dbPath: join(root, 'catalog.sqlite'), photoDir: join(process.cwd(), 'public', 'photos') });
const baseUrl = 'http://backend.test';

// Exercise the real HTTP handler without opening a listening server or touching the default DB.
async function requestApi(target, url, options = {}) {
  const request = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
  request.url = new URL(url, baseUrl).pathname;
  request.method = options.method ?? 'GET';
  const chunks = [];
  const response = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  let status;
  let headers;
  response.writeHead = (code, values) => { status = code; headers = values; };
  const done = finished(response);
  await target.requestHandler(request, response);
  await done;
  return new Response(Buffer.concat(chunks), { status, headers });
}

const fetch = (url, options) => requestApi(backend, url, options);
const post = (path, body, target = backend) => requestApi(target, path, { method: 'POST', body: JSON.stringify(body) });
const rule = (id, field, operator, value) => ({ id, type: 'rule', field, operator, value });
const group = (id, operator, children) => ({ id, type: 'group', operator, children });

after(() => {
  backend.close();
  rmSync(root, { recursive: true, force: true });
});

test('seed contains 24 catalog records and required mountain coverage', () => {
  assert.equal(catalogPhotos.length, 24);
  const mountainsIn2024 = catalogPhotos.filter((photo) => photo[5].includes('mountain') && photo[4].startsWith('2024'));
  assert.ok(mountainsIn2024.length >= 8);
  assert.ok(catalogPhotos.every((photo) => photo[9] === 1200 && photo[10] === 800));
  assert.ok(catalogPhotos.every((photo) => existsSync(join(process.cwd(), 'public', 'photos', photo[2]))));
});

test('parser creates editable criteria and explicit clarifications', () => {
  const result = parseSearchText('mountains in 2024 OR favorites near me');
  assert.equal(result.query.type, 'group');
  assert.equal(result.query.operator, 'OR');
  assert.equal(result.query.children[0].operator, 'AND');
  assert.ok(result.query.children[0].children.some((child) => child.field === 'tag' && child.value === 'mountain'));
  assert.ok(result.query.children[0].children.some((child) => child.field === 'date' && child.value === '2024'));
  assert.ok(result.query.children[1].children.some((child) => child.field === 'favorite'));
  assert.equal(result.clarifications[0].phrase, 'near me');
  assert.ok(result.clarifications[0].options.length >= 2);
});

test('parser keeps clarification choices attached to their OR branch', () => {
  const result = parseSearchText('mountain OR near me');
  assert.equal(result.query.operator, 'OR');
  assert.equal(result.clarifications[0].branch, 1);
  assert.equal(result.query.children[0].children[0].value, 'mountain');
});

test('parser does not fabricate unsupported criteria', () => {
  const result = parseSearchText('dragonfly expedition');
  assert.deepEqual(result.query.children, []);
  assert.deepEqual(result.unsupported, ['dragonfly', 'expedition']);
});

test('singular beach and city work and repeated whitespace preserves unsupported terms', () => {
  assert.equal(parseSearchText('beach').query.children[0].value, 'beach');
  assert.equal(parseSearchText('city').query.children[0].value, 'city');
  assert.deepEqual(parseSearchText('show   mountains   dragonfly').unsupported, ['dragonfly']);
});

test('recent clarification alternatives remain executable query trees', () => {
  const result = parseSearchText('recent');
  assert.equal(result.clarifications[0].phrase, 'recent');
  assert.equal(result.clarifications[0].options[0].query.children[0].field, 'date');
  assert.match(result.clarifications[0].options[0].query.children[0].value, /^\d{4}-\d{2}-\d{2}$/);
});

test('query compiler binds values and handles empty groups', () => {
  const compiled = compileQuery({
    id: 'root', type: 'group', operator: 'AND', children: [
      { id: 'tag', type: 'rule', field: 'tag', operator: 'is', value: 'mountain' },
      { id: 'date', type: 'rule', field: 'date', operator: 'after', value: '2023-12-31' },
    ],
  }, 'oldest');
  assert.match(compiled.where, /json_each/);
  assert.deepEqual(compiled.params, ['mountain', '2023-12-31']);
  assert.equal(compileQuery(emptyQuery()).where, '1 = 1');
  assert.throws(() => compileQuery({ id: 'bad', type: 'rule', field: 'favorite', operator: 'contains', value: 'yes' }), QueryValidationError);
  assert.throws(() => compileQuery({ id: 'bad', type: 'group', operator: 'AND', children: [{ id: 'bad', type: 'rule', field: 'favorite', operator: 'is', value: 'maybe' }] }), /true.*false/);
});

test('HTTP catalog, search, parse, favorite patch, and errors follow contract', async () => {
  const catalogResponse = await fetch(`${baseUrl}/api/catalog`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.photos.length, 24);
  assert.deepEqual(catalog.stats, { total: 24, favorites: 7, locations: 6 });
  assert.ok(catalog.facets.tags.includes('mountain'));

  const photoResponse = await fetch(`${baseUrl}/photos/${catalog.photos[0].filename}`);
  assert.equal(photoResponse.status, 200);
  assert.match(photoResponse.headers.get('content-type'), /image\/svg/);

  const searchResponse = await fetch(`${baseUrl}/api/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: { id: 'mountains', type: 'group', operator: 'AND', children: [{ id: 'm', type: 'rule', field: 'tag', operator: 'is', value: 'mountain' }] }, sort: 'title' }),
  });
  const search = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.ok(search.total >= 8);
  assert.ok(search.photos.every((photo) => photo.tags.includes('mountain')));
  assert.ok(search.photos[0].title.localeCompare(search.photos[1].title) <= 0);

  const parseResponse = await fetch(`${baseUrl}/api/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'last summer coast' }) });
  const parsed = await parseResponse.json();
  assert.equal(parseResponse.status, 200);
  assert.equal(parsed.clarifications[0].phrase, 'last summer');
  assert.ok(parsed.query.children.some((child) => child.value === 'coast'));

  const patchResponse = await fetch(`${baseUrl}/api/photos/dolomites-dawn`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: true }) });
  const patched = await patchResponse.json();
  assert.equal(patchResponse.status, 200);
  assert.equal(patched.favorite, true);
  const reread = await (await fetch(`${baseUrl}/api/catalog`)).json();
  assert.equal(reread.stats.favorites, 8);

  const badResponse = await fetch(`${baseUrl}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: { id: 'bad', type: 'rule', field: 'title', operator: 'before', value: 'x' } }) });
  assert.equal(badResponse.status, 400);
  assert.equal((await badResponse.json()).error.code, 'BAD_REQUEST');
});

test('parser is deterministic with its default and supplied reference dates', async () => {
  const text = 'recent last summer yesterday last week this month';
  const RealDate = globalThis.Date;
  const atClock = (clock) => {
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return new RealDate(clock).getTime(); }
    };
    try { return parseSearchText(text); } finally { globalThis.Date = RealDate; }
  };
  const parsed = atClock('2040-01-01T00:00:00Z');
  assert.deepEqual(parsed, atClock('2000-06-01T00:00:00Z'));
  assert.equal(parsed.referenceDate, '2025-11-15');
  assert.deepEqual(parsed.criteria, parsed.query.children);
  assert.deepEqual(parsed.unsupported, []);
  const choice = (result, phrase, index = 0) => result.clarifications.find((item) => item.phrase === phrase).options[index].query;
  assert.equal(choice(parsed, 'recent').children[0].value, '2025-10-16');
  assert.deepEqual(choice(parsed, 'yesterday'), { id: 'yesterday', type: 'date-interval', from: '2025-11-14', to: '2025-11-14' });
  assert.equal(choice(parsed, 'last week').from, '2025-11-03');
  assert.equal(choice(parsed, 'last week').to, '2025-11-09');
  assert.equal(choice(parsed, 'last week', 1).from, '2025-11-08');
  assert.equal(choice(parsed, 'this month').to, '2025-11-15');
  assert.equal(choice(parsed, 'this month', 1).to, '2025-11-30');
  assert.equal(choice(parsed, 'last summer').children[0].value, '2025-05-31');

  const leap = parseSearchText(text, '2024-03-01');
  assert.equal(leap.referenceDate, '2024-03-01');
  assert.equal(choice(leap, 'recent').children[0].value, '2024-01-31');
  assert.equal(choice(leap, 'yesterday').from, '2024-02-29');
  assert.equal(choice(leap, 'last summer').children[0].value, '2023-05-31');
  assert.equal(choice(parseSearchText('this month', '2024-02-15'), 'this month', 1).to, '2024-02-29');
  const january = parseSearchText('yesterday last week', '2025-01-01');
  assert.equal(choice(january, 'yesterday').from, '2024-12-31');
  assert.equal(choice(january, 'last week').from, '2024-12-23');
  for (const result of [parsed, leap, january, parseSearchText(text, '0001-01-01'), parseSearchText(text, '9999-12-31')]) {
    for (const clarification of result.clarifications) {
      assert.ok(clarification.options.length);
      for (const option of clarification.options) {
        assert.ok(option.label);
        assert.doesNotThrow(() => compileQuery(option.query));
        assert.deepEqual(JSON.parse(JSON.stringify(option.query)), option.query);
      }
    }
  }
  const response = await post('/api/parse', { text, referenceDate: '2024-03-01' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), leap);
  const executed = await post('/api/search', { query: choice(parsed, 'recent') });
  assert.deepEqual((await executed.json()).photos.map((photo) => photo.id), ['kyoto-hills']);
});

test('ambiguous places have labeled editable choices, while catalog-known places resolve', async () => {
  const parsed = parseSearchText('coast near me and around Atlantis yesterday');
  assert.deepEqual(parsed.unsupported, []);
  assert.equal(parsed.query.children.length, 1);
  assert.equal(parsed.query.children[0].value, 'coast');
  for (const phrase of ['near me', 'around atlantis']) {
    const clarification = parsed.clarifications.find((item) => item.phrase === phrase);
    assert.ok(clarification.options.length >= 2);
    for (const option of clarification.options) {
      assert.ok(option.label);
      assert.doesNotThrow(() => compileQuery(option.query));
      assert.ok(listPhotos(backend.db, compileQuery(option.query).where, compileQuery(option.query).params).length > 0);
      option.query.value = 'Italy';
      assert.deepEqual(compileQuery(option.query).params, ['%Italy%']);
    }
  }
  const known = parseSearchText('around Kyoto AND mountains');
  assert.deepEqual(known.clarifications, []);
  assert.deepEqual(known.unsupported, []);
  assert.ok(known.query.children.some((node) => node.field === 'location' && node.value === 'Kyoto'));
  assert.equal(parseSearchText('around New Kyoto').query.children.length, 0);
  const branched = parseSearchText('mountain OR around Atlantis last week', '2024-03-01');
  assert.ok(branched.clarifications.every((item) => item.branch === 1));
  assert.ok(branched.clarifications.every((item) => item.options.every((option) => option.query.id.startsWith('branch-1-'))));

  const isolated = createBackend({ dbPath: join(root, 'places.sqlite') });
  try {
    isolated.db.prepare('UPDATE photos SET location = ? WHERE id = ?').run('Bergen, Norway', 'lofoten-ridge');
    const response = await post('/api/parse', { text: 'around Bergen' }, isolated);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.clarifications, []);
    assert.equal(result.query.children[0].value, 'Bergen');
  } finally { isolated.close(); }
});

test('parse API rejects invalid reference dates and malformed bodies', async () => {
  for (const referenceDate of [null, '', 2025, {}, '2025', '2025-2-01', '2025-02-29', '1900-02-29', '2024-04-31', '0000-01-01', '2025-11-15T12:00:00Z', "2025-11-15' OR 1=1 --"]) {
    const response = await post('/api/parse', { text: 'yesterday', referenceDate });
    assert.equal(response.status, 400, JSON.stringify(referenceDate));
    assert.match((await response.json()).error.message, /reference date/i);
  }
  for (const body of [null, [], {}, { text: 42 }]) assert.equal((await post('/api/parse', body)).status, 400);
});

test('saved searches persist across idempotent catalog startup and can be deleted', async () => {
  const dbPath = join(root, 'saved.sqlite');
  let isolated = createBackend({ dbPath });
  try {
    assert.deepEqual(await (await requestApi(isolated, '/api/saved-searches')).json(), []);
    const query = group('saved', 'AND', [rule('tag', 'tag', 'is', 'mountain'), { id: 'range', type: 'date-interval', from: '2024-01-01', to: '2024-12-31' }]);
    const response = await post('/api/saved-searches', { name: '  Mountain memories  ', query, referenceDate: '2024-02-29' }, isolated);
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.equal(saved.name, 'Mountain memories');
    assert.deepEqual(saved.query, query);
    assert.equal(saved.referenceDate, '2024-02-29');
    assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
    assert.equal(new Date(saved.createdAt).toISOString(), saved.createdAt);
    assert.deepEqual(JSON.parse(isolated.db.prepare('SELECT query FROM saved_searches WHERE id = ?').get(saved.id).query), query);
    await requestApi(isolated, '/api/photos/dolomites-dawn', { method: 'PATCH', body: JSON.stringify({ favorite: true }) });
    isolated.close();
    isolated = createBackend({ dbPath });
    assert.deepEqual(await (await requestApi(isolated, '/api/saved-searches')).json(), [saved]);
    assert.equal(listPhotos(isolated.db).length, 24);
    assert.equal(listPhotos(isolated.db).find((photo) => photo.id === 'dolomites-dawn').favorite, true);
    const reopened = openCatalog(dbPath);
    try {
      assert.equal(listPhotos(reopened).length, 24);
      assert.deepEqual(listSavedSearches(reopened), [saved]);
    } finally { reopened.close(); }
    const search = await post('/api/search', { query: saved.query }, isolated);
    const results = await search.json();
    assert.ok(results.total >= 8);
    assert.ok(results.photos.every((photo) => photo.tags.includes('mountain') && photo.date.startsWith('2024')));
    assert.deepEqual(listSavedSearches(backend.db), []);
    const deletion = await requestApi(isolated, `/api/saved-searches/${saved.id}`, { method: 'DELETE' });
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { id: saved.id, deleted: true });
    assert.equal((await requestApi(isolated, `/api/saved-searches/${saved.id}`, { method: 'DELETE' })).status, 404);
    isolated.close();
    isolated = createBackend({ dbPath });
    assert.deepEqual(listSavedSearches(isolated.db), []);
  } finally { isolated.close(); }
});

test('saved-search validation rejects malformed values and treats injection-like inputs literally', async () => {
  const isolated = createBackend({ dbPath: join(root, 'saved-validation.sqlite') });
  try {
    const valid = { name: 'Valid', query: emptyQuery() };
    const invalid = [null, [], {}, { ...valid, name: '' }, { ...valid, name: '  ' }, { ...valid, name: 123 }, { ...valid, name: 'x'.repeat(81) },
      { name: 'Missing query' }, { ...valid, query: null }, { ...valid, query: rule('bad', 'author', 'is', 'x') },
      ...[null, 2025, '2025', '2025-02-29', '2024-13-01', '2025-01-01 '].map((referenceDate) => ({ ...valid, referenceDate }))];
    for (const body of invalid) assert.equal((await post('/api/saved-searches', body, isolated)).status, 400, JSON.stringify(body));
    assert.deepEqual(listSavedSearches(isolated.db), []);
    const injection = "'; DROP TABLE photos; --";
    const query = group('literal', 'AND', [
      { id: 'tags', type: 'tags', mode: 'any', values: ["' OR 1=1 --"] },
      { id: 'location', type: 'location', operator: 'contains', value: '100%_C:\\photos\\' },
    ]);
    const response = await post('/api/saved-searches', { name: injection, query }, isolated);
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.equal(saved.name, injection);
    assert.equal(saved.referenceDate, '2025-11-15');
    assert.deepEqual(saved.query, query);
    assert.deepEqual(listSavedSearches(isolated.db), [saved]);
    assert.equal((await (await post('/api/search', { query: saved.query }, isolated)).json()).total, 0);
    assert.equal((await post('/api/saved-searches', { ...valid, name: 'x'.repeat(80) }, isolated)).status, 201);
    assert.equal((await post('/api/saved-searches', { ...valid, name: 'x' }, isolated)).status, 201);
    for (const id of ['0', '-1', '9007199254740992', "1' OR 1=1 --"]) {
      assert.equal((await requestApi(isolated, `/api/saved-searches/${encodeURIComponent(id)}`, { method: 'DELETE' })).status, 400);
    }
    assert.equal(listSavedSearches(isolated.db).length, 3);
    assert.equal(listPhotos(isolated.db).length, 24);
  } finally { isolated.close(); }
});

test('search explanations only include contributing branches of nested AND/OR groups', async () => {
  const query = group('root', 'OR', [
    group('italian-mountain', 'AND', [rule('mountain', 'tag', 'is', 'mountain'), rule('italy', 'location', 'contains', 'Italy')]),
    group('japanese-forest', 'AND', [rule('forest', 'tag', 'is', 'forest'), rule('japan', 'location', 'contains', 'Japan')]),
  ]);
  const response = await post('/api/search', { query });
  assert.equal(response.status, 200);
  const { photos, total } = await response.json();
  assert.equal(total, 7);
  const kyoto = photos.find((photo) => photo.id === 'kyoto-hills');
  // This photo also has mountain, but the Italian AND branch failed.
  assert.deepEqual(kyoto.matches.map((match) => match.nodeId), ['forest', 'japan']);
  assert.deepEqual(kyoto.matchReasons, ['Tag is forest', 'Location contains Japan']);
  assert.deepEqual(kyoto.matches[0].path, ['root', 'japanese-forest', 'forest']);
  assert.ok(photos.every((photo) => photo.matches.every((match) => match.state === 'matched')));
  const conjunction = group('required', 'AND', [
    group('either-tag', 'OR', [rule('mountain', 'tag', 'is', 'mountain'), rule('forest', 'tag', 'is', 'forest')]),
    rule('year', 'date', 'is', '2025'),
  ]);
  assert.deepEqual(explainPhotoMatch(kyoto, conjunction).matches.map((match) => match.nodeId), ['mountain', 'forest', 'year']);
  assert.deepEqual(explainPhotoMatch(kyoto, group('failed', 'AND', [rule('forest', 'tag', 'is', 'forest'), rule('wrong', 'date', 'is', '2020')])).matches, []);
});

test('canonical and legacy explanations agree with SQL for all catalog metadata', async () => {
  const photos = listPhotos(backend.db);
  const filters = [
    ...['any', 'all', 'none'].flatMap((mode) => [{ id: `tags-${mode}`, type: 'tags', mode, values: ['MOUNTAIN', 'snow'] }, { id: `empty-${mode}`, type: 'tags', mode, values: [] }]),
    { id: 'label', type: 'label', value: ' nAtUrE ' },
    ...[{ from: '2024-01-18', to: '2024-01-30' }, { from: '2025-11-02' }, { to: '2023-04-09' }, { from: '2024-01-18', to: '2024-01-18' }].map((bounds) => ({ id: 'interval', type: 'date-interval', ...bounds })),
    ...['is', 'contains', 'is_not'].map((operator) => ({ id: 'location', type: 'location', operator, value: 'jApAn' })),
    { id: 'exact-location', type: 'location', operator: 'is', value: 'kYoto, jApAn' },
    ...['tag', 'label', 'location', 'title'].flatMap((field) => ['is', 'is_not', 'contains'].map((operator) => rule(`${field}-${operator}`, field, operator, { tag: 'snow', label: 'Nature', location: 'Japan', title: 'Dawn' }[field]))),
    ...['is', 'is_not'].flatMap((operator) => [rule('year', 'date', operator, '2024'), rule('date', 'date', operator, '2024-01-18'), rule('favorite', 'favorite', operator, 'true'), rule('not-favorite', 'favorite', operator, 'false')]),
    rule('before', 'date', 'before', '2024-01-18'), rule('after', 'date', 'after', '2024-01-18'), emptyQuery(), group('empty-or', 'OR', []),
  ];
  for (const query of filters) {
    const compiled = compileQuery(query);
    const matching = new Set(listPhotos(backend.db, compiled.where, compiled.params).map((photo) => photo.id));
    for (const photo of photos) {
      const explanation = explainPhotoMatch(photo, query);
      assert.equal(explanation.matched, matching.has(photo.id), JSON.stringify({ photo: photo.id, query }));
      assert.ok(explanation.matched ? explanation.matchReasons.length > 0 : explanation.matchReasons.length === 0);
      assert.deepEqual(explanation, explainPhotoMatch(structuredClone(photo), structuredClone(query)));
    }
  }
  const query = group('canonical', 'AND', [
    { id: 'tags', type: 'tags', mode: 'all', values: ['mountain', 'snow'] },
    { id: 'label', type: 'label', value: 'Landscape' },
    { id: 'interval', type: 'date-interval', from: '2024-01-18', to: '2024-01-30' },
    { id: 'location', type: 'location', operator: 'is_not', value: 'Italy' },
    rule('state', 'favorite', 'is', 'false'),
  ]);
  const result = await (await post('/api/search', { query })).json();
  assert.deepEqual(result.photos.map((photo) => photo.id), ['alps-glacier']);
  assert.deepEqual(result.photos[0].matchReasons, ['Tags all: mountain, snow', 'Label is Landscape', 'Date 2024-01-18–2024-01-30 (inclusive)', 'Location does not contain Italy', 'Not favorite']);
  assert.deepEqual(result.photos[0].matches[0].actual, ['mountain', 'snow']);
});

test('match explanations and search treat injection-like and wildcard metadata as literals', async () => {
  const isolated = createBackend({ dbPath: join(root, 'explain-literals.sqlite') });
  try {
    const injection = "' OR 1=1 --";
    const wildcard = '100%_C:\\photos\\';
    isolated.db.prepare('UPDATE photos SET title=?,location=?,label=?,tags=? WHERE id=?').run(injection, wildcard, injection, JSON.stringify([injection, wildcard]), 'dolomites-dawn');
    const query = group('literal', 'AND', [
      rule('title', 'title', 'contains', injection),
      { id: 'label', type: 'label', value: injection },
      { id: 'tags', type: 'tags', mode: 'all', values: [injection, wildcard] },
      { id: 'location', type: 'location', operator: 'contains', value: wildcard },
      rule('percent', 'tag', 'contains', '%'),
    ]);
    const result = await (await post('/api/search', { query }, isolated)).json();
    assert.equal(result.total, 1);
    assert.equal(result.photos[0].id, 'dolomites-dawn');
    assert.equal(result.photos[0].matches.length, 5);
    assert.ok(result.photos[0].matchReasons.some((reason) => reason.includes(injection)));
    assert.ok(result.photos[0].matchReasons.some((reason) => reason.includes(wildcard)));
    assert.ok(listPhotos(isolated.db).every((photo) => explainPhotoMatch(photo, query).matched === (photo.id === 'dolomites-dawn')));
    assert.equal(listPhotos(isolated.db).length, 24);
  } finally { isolated.close(); }
});

test('catalog export and import round trip preserves complete photo metadata', async () => {
  const isolated = createBackend({ dbPath: join(root, 'catalog-transfer.sqlite'), photoDir: join(process.cwd(), 'public', 'photos') });
  try {
    await requestApi(isolated, '/api/photos/dolomites-dawn', { method: 'PATCH', body: JSON.stringify({ favorite: true }) });
    const exportedResponse = await requestApi(isolated, '/api/catalog/export');
    assert.equal(exportedResponse.status, 200);
    assert.match(exportedResponse.headers.get('content-disposition'), /attachment/);
    const exported = await exportedResponse.json();
    assert.equal(exported.version, 1);
    assert.ok(new Date(exported.exportedAt).toISOString() === exported.exportedAt);
    assert.equal(exported.photos.length, 24);
    assert.equal(exported.photos.find((photo) => photo.id === 'dolomites-dawn').favorite, true);

    const replacement = structuredClone(exported.photos).slice(0, 2);
    replacement[0].title = 'Imported title';
    replacement[1].favorite = false;
    const importedResponse = await post('/api/catalog/import', replacement, isolated);
    assert.equal(importedResponse.status, 200);
    assert.deepEqual(await importedResponse.json(), { imported: 2, savedSearches: 'preserved', searchHistory: 'preserved' });
    const reread = await (await requestApi(isolated, '/api/catalog')).json();
    assert.deepEqual(reread.photos, replacement);
    const restored = await post('/api/catalog/import', { photos: exported.photos }, isolated);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).imported, 24);
    assert.deepEqual((await (await requestApi(isolated, '/api/catalog/export')).json()).photos, exported.photos);
  } finally { isolated.close(); }
});

test('malformed catalog imports preserve every existing row, including mid-list failures', async () => {
  const dbPath = join(root, 'catalog-invalid-import.sqlite');
  const isolated = createBackend({ dbPath });
  try {
    const before = listPhotos(isolated.db);
    const rawRows = isolated.db.prepare('SELECT rowid,* FROM photos ORDER BY rowid').all();
    const files = [dbPath, `${dbPath}-wal`];
    const bytes = files.map((file) => readFileSync(file));
    const malformed = structuredClone(before);
    malformed[12].filename = '../outside.svg';
    malformed[12].url = '/photos/../outside.svg';
    const response = await post('/api/catalog/import', { photos: malformed }, isolated);
    assert.equal(response.status, 400);
    assert.deepEqual(listPhotos(isolated.db), before);
    assert.equal(isolated.db.prepare('SELECT COUNT(*) AS count FROM photos').get().count, before.length);
    const photo = before[0];
    const invalidRecords = [
      null, [], {}, { ...photo, unknown: true },
      ...Object.keys(photo).map((field) => Object.fromEntries(Object.entries(photo).filter(([key]) => key !== field))),
      ...['', ' ', 42, null, 'x'.repeat(101)].map((id) => ({ ...photo, id })),
      ...['title', 'location', 'label'].flatMap((field) => ['', ' ', 1, null, 'x'.repeat(301)].map((value) => ({ ...photo, [field]: value }))),
      ...['../a.svg', '/a.svg', 'a/b.svg', 'a\\b.svg', '%2e%2e.svg', '..svg', 'a..b.svg', 'a.svg?x=1', 'a.svg#x', 'a.png', 'a\0.svg', `${'a'.repeat(252)}.svg`]
        .map((filename) => ({ ...photo, filename, url: `/photos/${filename}` })),
      ...['https://example.test/a.svg', '//example.test/a.svg', '/photos/../a.svg', '/photos/%2e%2e/a.svg', '/photos/a.svg?x=1', '/photos/a.svg#x', `/photos/${photo.filename}/extra`, '/photos/other.svg']
        .map((url) => ({ ...photo, url })),
      ...[null, 2024, '', '2024', '2024-2-01', '2023-02-29', '1900-02-29', '2024-04-31', '2024-13-01', '2024-01-00', '0000-01-01', '2024-01-01T00:00:00Z']
        .map((date) => ({ ...photo, date })),
      ...[null, 'tag', [null], [12], [''], [' '], ['t'.repeat(301)], Array(101).fill('tag')].map((tags) => ({ ...photo, tags })),
      ...[0, 1, 'false', null].map((favorite) => ({ ...photo, favorite })),
      ...[null, 42, '', ' ', 'c'.repeat(21)].map((color) => ({ ...photo, color })),
      ...['width', 'height'].flatMap((field) => [0, -1, 1.5, '1200', null, 100001, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ ...photo, [field]: value }))),
    ];
    for (const record of invalidRecords) {
      assert.equal((await post('/api/catalog/import', { photos: [record] }, isolated)).status, 400, JSON.stringify(record));
    }
    for (const body of [null, 42, 'photos', {}, { photos: {} }, { photos: null }, { photos: [photo, photo] }, Array(10001).fill(null)]) {
      assert.equal((await post('/api/catalog/import', body, isolated)).status, 400, JSON.stringify(body));
    }
    const invalidJson = await requestApi(isolated, '/api/catalog/import', { method: 'POST', body: '{"photos":[' });
    assert.equal(invalidJson.status, 400);
    const oversized = await requestApi(isolated, '/api/catalog/import', { method: 'POST', body: ' '.repeat(1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(isolated.db.prepare('SELECT rowid,* FROM photos ORDER BY rowid').all(), rawRows);
    files.forEach((file, index) => assert.deepEqual(readFileSync(file), bytes[index], file));
    const boundary = { ...photo, id: 'x'.repeat(100), title: 't'.repeat(300), location: 'l'.repeat(300), label: 'L'.repeat(300),
      filename: `${'a'.repeat(251)}.svg`, url: `/photos/${'a'.repeat(251)}.svg`, tags: Array(100).fill('t'.repeat(300)), width: 1, height: 100000 };
    for (const date of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) {
      assert.doesNotThrow(() => validateCatalogPhotos([{ ...boundary, date }]));
    }
    assert.doesNotThrow(() => validateCatalogPhotos(Array.from({ length: 10000 }, (_, index) => ({ ...photo, id: String(index) }))));
  } finally { isolated.close(); }
});

test('valid catalog import atomically replaces photos while preserving saved searches and history', async () => {
  const dbPath = join(root, 'catalog-replace.sqlite');
  let isolated = createBackend({ dbPath });
  try {
    const query = group('history-query', 'AND', [rule('tag', 'tag', 'is', 'mountain')]);
    const savedResponse = await post('/api/saved-searches', { name: 'Keep me', query }, isolated);
    assert.equal(savedResponse.status, 201);
    const searchResponse = await post('/api/search', { query, sort: 'oldest' }, isolated);
    assert.equal(searchResponse.status, 200);
    const original = listPhotos(isolated.db);
    const saved = await (await requestApi(isolated, '/api/saved-searches')).json();
    const history = await (await requestApi(isolated, '/api/search-history')).json();
    const imported = original.slice(0, 1).map((photo) => ({ ...photo, id: 'replacement', title: 'Replacement' }));
    const response = await post('/api/catalog/import', { photos: imported }, isolated);
    assert.equal(response.status, 200);
    assert.deepEqual(listPhotos(isolated.db), imported);
    assert.deepEqual(listSavedSearches(isolated.db), saved);
    assert.deepEqual(await (await requestApi(isolated, '/api/search-history')).json(), history);
    isolated.close();
    isolated = createBackend({ dbPath });
    assert.deepEqual(listPhotos(isolated.db), imported);
    assert.deepEqual(listSavedSearches(isolated.db), saved);
    assert.deepEqual(await (await requestApi(isolated, '/api/search-history')).json(), history);
    assert.equal((await post('/api/catalog/import', [], isolated)).status, 200);
    isolated.close();
    isolated = createBackend({ dbPath });
    assert.deepEqual(listPhotos(isolated.db), []);
    assert.deepEqual(listSavedSearches(isolated.db), saved);
    assert.deepEqual(await (await requestApi(isolated, '/api/search-history')).json(), history);
  } finally { isolated.close(); }
});

test('catalog transaction rolls back deletion and earlier inserts on a SQLite write failure', () => {
  const isolated = createBackend({ dbPath: join(root, 'catalog-rollback.sqlite') });
  try {
    const before = isolated.db.prepare('SELECT rowid,* FROM photos ORDER BY rowid').all();
    const photo = listPhotos(isolated.db)[0];
    isolated.db.exec(`CREATE TRIGGER reject_photo BEFORE INSERT ON photos
      WHEN NEW.id = 'reject-me' BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END;`);
    assert.throws(() => replaceCatalog(isolated.db, [{ ...photo, id: 'first-insert' }, { ...photo, id: 'reject-me' }]), /forced insert failure/);
    assert.deepEqual(isolated.db.prepare('SELECT rowid,* FROM photos ORDER BY rowid').all(), before);
    isolated.db.exec('DROP TRIGGER reject_photo');
    assert.equal(replaceCatalog(isolated.db, [{ ...photo, id: 'replacement' }]), 1);
    assert.deepEqual(listPhotos(isolated.db), [{ ...photo, id: 'replacement' }]);
  } finally { isolated.close(); }
});

test('search history records valid searches, rejects invalid queries, and clears safely', async () => {
  const isolated = createBackend({ dbPath: join(root, 'search-history.sqlite'), photoDir: join(process.cwd(), 'public', 'photos') });
  try {
    assert.deepEqual(await (await requestApi(isolated, '/api/search-history')).json(), []);
    const injection = "' OR 1=1 --";
    const query = group('history-literal', 'AND', [rule('title', 'title', 'contains', injection)]);
    const search = await post('/api/search', { query, sort: 'title' }, isolated);
    assert.equal(search.status, 200);
    const history = await requestApi(isolated, '/api/search-history');
    assert.equal(history.status, 200);
    const entries = await history.json();
    assert.equal(entries.length, 1);
    assert.ok(Number.isSafeInteger(entries[0].id));
    assert.deepEqual(entries[0].query, query);
    assert.equal(entries[0].sort, 'title');
    assert.equal(entries[0].resultCount, 0);
    assert.ok(new Date(entries[0].createdAt).toISOString() === entries[0].createdAt);
    const row = isolated.db.prepare('SELECT * FROM search_history WHERE id = ?').get(entries[0].id);
    assert.deepEqual(JSON.parse(row.query), query);
    assert.equal(row.sort, 'title');
    assert.equal(row.result_count, 0);
    assert.equal(row.created_at, entries[0].createdAt);

    for (const body of [null, [], { query: null }, { query: {} }, { query: rule('bad', 'title', 'before', injection) }, { query, sort: injection }, { query, sort: null }]) {
      assert.equal((await post('/api/search', body, isolated)).status, 400);
    }
    assert.throws(() => createSearchHistory(isolated.db, { query: { type: 'invalid' }, sort: 'newest', resultCount: 0 }), QueryValidationError);
    assert.deepEqual(await (await requestApi(isolated, '/api/search-history')).json(), entries);
    const allResponse = await post('/api/search', {}, isolated);
    assert.equal(allResponse.status, 200);
    assert.equal((await allResponse.json()).total, 24);
    const newest = await (await requestApi(isolated, '/api/search-history')).json();
    assert.equal(newest.length, 2);
    assert.ok(newest[0].id > entries[0].id);
    assert.deepEqual(newest[0].query, emptyQuery());
    assert.equal(newest[0].sort, 'newest');
    assert.equal(newest[0].resultCount, 24);

    const deletion = await requestApi(isolated, '/api/search-history', { method: 'DELETE' });
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { deleted: 2 });
    assert.deepEqual(await (await requestApi(isolated, '/api/search-history')).json(), []);
    assert.deepEqual(await (await requestApi(isolated, '/api/search-history', { method: 'DELETE' })).json(), { deleted: 0 });
    assert.equal(listPhotos(isolated.db).length, 24);
  } finally { isolated.close(); }
});

test('imported injection-like metadata stays literal in the catalog and search history', async () => {
  const isolated = createBackend({ dbPath: join(root, 'catalog-literals.sqlite') });
  try {
    const injection = "'; DROP TABLE photos; --";
    const wildcard = '100%_C:\\photos\\';
    const photo = { ...listPhotos(isolated.db)[0], id: injection, title: injection, label: injection, location: wildcard, tags: [injection, wildcard] };
    assert.equal((await post('/api/catalog/import', { photos: [photo] }, isolated)).status, 200);
    assert.deepEqual((await (await requestApi(isolated, '/api/catalog/export')).json()).photos, [photo]);
    const query = group('literal', 'AND', [rule('title', 'title', 'is', injection), { id: 'location', type: 'location', operator: 'contains', value: wildcard }]);
    const response = await post('/api/search', { query, sort: 'oldest' }, isolated);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 1);
    const history = await (await requestApi(isolated, '/api/search-history')).json();
    assert.deepEqual(history[0].query, query);
    assert.equal(history[0].resultCount, 1);
    assert.equal(history[0].sort, 'oldest');
    assert.equal(listPhotos(isolated.db).length, 1);
  } finally { isolated.close(); }
});
