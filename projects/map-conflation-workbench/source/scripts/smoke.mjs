import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const screenshot = resolve(root, 'reports/final-ui.png');
const timeout = 12_000;
const storageKey = 'conflation-workbench:SF-2025-01:v1';
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

async function waitFor(label, predicate) {
  const deadline = Date.now() + timeout;
  do {
    const result = await predicate();
    if (result) return result;
    await delay(60);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

// One browser WebSocket, with flattened page sessions and bounded commands.
class CDP extends EventEmitter {
  nextId = 0;
  pending = new Map();

  static async connect(url) {
    const client = new CDP();
    client.socket = new WebSocket(url);
    client.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = client.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        client.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else client.emit(message.method, message.params, message.sessionId);
    });
    client.socket.addEventListener('close', () => client.rejectPending('CDP connection closed'));
    client.socket.addEventListener('error', () => client.rejectPending('CDP WebSocket error'));
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), timeout);
      client.socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      client.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    }).catch((error) => { client.socket.close(); throw error; });
    return client;
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolveCommand, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve: resolveCommand, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, sessionId })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  close() { this.rejectPending('CDP closed'); this.socket.close(); }
}

function browserEndpoint(browser) {
  return new Promise((resolveEndpoint, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Chromium startup timed out: ${output}`)), timeout);
    const onData = (chunk) => {
      output = (output + chunk).slice(-8000);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(null, match[1]);
    };
    const onExit = (code) => finish(new Error(`Chromium exited (${code}): ${output}`));
    const onError = (error) => finish(error);
    function finish(error, endpoint) {
      clearTimeout(timer);
      browser.stderr.off('data', onData);
      browser.off('exit', onExit);
      browser.off('error', onError);
      if (error) reject(error); else resolveEndpoint(endpoint);
    }
    browser.stderr.on('data', onData);
    browser.once('exit', onExit);
    browser.once('error', onError);
  });
}

async function serve(request, response) {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${dist}${sep}`)) { response.writeHead(403); response.end(); return; }
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end('Unable to serve built asset');
  }
}

const sourceDates = [
  ['2024-06-18', '2025-02-03'], ['2024-06-18', '2025-02-03'],
  ['2024-05-22', '2025-01-12'], ['2024-03-09', '2025-02-03'],
  ['2024-01-14', '2025-01-27'], ['2024-04-01', '2025-01-27'],
  ['2024-02-12', '2025-01-10'], ['2024-02-18', '2025-02-03'],
  ['2024-02-18', '2025-02-03'],
];

function verifyComputation(computation, dates) {
  assert.ok(computation, 'Audit event must include its computation snapshot');
  const evidence = computation.confidenceEvidence;
  const rules = evidence?.rules;
  assert.equal(rules?.version, 'weighted-v1');
  assert.match(rules.formula, /round.*clamp/);
  assert.ok(rules.rounding, 'Explicit rounding rule');
  for (const key of ['geometryWeight', 'nameWeight', 'typeWeight', 'distanceCutoff',
    'nameMismatchScore', 'typeMismatchScore', 'conflictPenaltyEach', 'conflictPenaltyCap',
    'highInclusive', 'mediumInclusive']) assert.ok(Number.isFinite(rules[key]), `Numeric rule ${key}`);
  const near = (actual, expected, label) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, label);
  near(evidence.contributions?.geometry, evidence.distanceScore * rules.geometryWeight, 'Geometry contribution');
  near(evidence.contributions?.name, evidence.nameScore * rules.nameWeight, 'Name contribution');
  near(evidence.contributions?.type, evidence.typeScore * rules.typeWeight, 'Type contribution');
  near(evidence.conflictPenalty, Math.min(evidence.conflictCount * rules.conflictPenaltyEach, rules.conflictPenaltyCap), 'Tag penalty');
  const raw = evidence.contributions.geometry + evidence.contributions.name + evidence.contributions.type - evidence.conflictPenalty;
  near(evidence.rawScore, raw, 'Raw confidence');
  near(evidence.clampedScore, Math.max(0, Math.min(1, raw)), 'Clamped confidence');
  assert.equal(computation.confidence, Math.round(100 * evidence.clampedScore));
  assert.equal(evidence.roundedPercent, computation.confidence);
  assert.equal(evidence.band, computation.confidence >= rules.highInclusive ? 'high' : computation.confidence >= rules.mediumInclusive ? 'medium' : 'low');
  const freshness = computation.freshness;
  assert.deepEqual([freshness.primaryUpdated, freshness.secondaryUpdated], dates, 'Source update dates');
  assert.equal(freshness.metadataValid, true);
  assert.equal(freshness.version, 'source-gap-v1');
  assert.ok(freshness.formula && freshness.basis, 'Explicit freshness computation');
  assert.deepEqual(freshness.thresholds, { recentExclusive: 180, staleInclusive: 365 });
  assert.equal(freshness.days, Math.round(Math.abs(Date.parse(dates[1]) - Date.parse(dates[0])) / 86_400_000));
}

function verifyExport(data) {
  assert.equal(data.format, 'conflation-review-package');
  assert.equal(data.version, 2);
  assert.equal(data.decisions.length, 9);
  assert.deepEqual(data.decisions.map((item) => item.candidateId), Array.from({ length: 9 }, (_, i) => `cand-00${i + 1}`));
  let events = 0;
  for (const [index, decision] of data.decisions.entries()) {
    assert.match(decision.primaryId, /^city-way-/);
    assert.match(decision.secondaryId, /^open-way-/);
    verifyComputation(decision, sourceDates[index]);
    const expectedStatus = index === 0 ? 'rejected' : index === 2 ? 'deferred' : 'pending';
    assert.equal(decision.status, expectedStatus);
    const expectedActions = index === 0 ? ['accepted', 'rejected'] : index === 2 ? ['deferred'] : [];
    assert.deepEqual(decision.audit.map((event) => event.action), expectedActions, 'Append-only decision history');
    for (const event of decision.audit) {
      assert.ok(Number.isFinite(Date.parse(event.at)), 'Audit timestamp');
      assert.equal(event.sourceEvidence.primaryId, decision.primaryId, 'Audit primary source evidence');
      assert.equal(event.sourceEvidence.secondaryId, decision.secondaryId, 'Audit secondary source evidence');
      assert.equal(event.sourceEvidence.geometryDistance, decision.geometryDistance, 'Audit geometry evidence');
      assert.equal(event.sourceEvidence.geometryDistanceUnit, 'schematic units', 'Audit geometry unit');
      assert.equal(event.sourceEvidence.tagConflicts.length, event.computation.confidenceEvidence.conflictCount, 'Audit tag conflict evidence count');
      assert.ok(event.sourceEvidence.tagConflicts.every((conflict) => conflict.key && conflict.primary !== conflict.secondary), 'Audit tag conflict values');
      verifyComputation(event.computation, sourceDates[index]);
      assert.deepEqual(event.computation.confidenceEvidence, decision.confidenceEvidence);
      events += 1;
    }
  }
  assert.equal(events, 3, 'All three audit events exported');
}

let temporary, browser, cdp, server;
const failures = [];
const requests = [];
const checks = [];
try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Smoke requires Node 22+ native WebSocket');
  try { await access('/usr/bin/chromium'); }
  catch { throw new Error('Chromium is not ready at /usr/bin/chromium. Install it, then run npm run smoke.'); }
  await access(resolve(dist, 'index.html'));
  temporary = await mkdtemp('/tmp/map-conflation-smoke-');
  const downloads = resolve(temporary, 'downloads');
  await mkdir(downloads);
  server = createServer((request, response) => { void serve(request, response); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isLocal = (url) => {
    const parsed = new URL(url);
    return !['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || parsed.origin === origin;
  };
  browser = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-sync', '--disable-domain-reliability', '--no-first-run', '--no-default-browser-check',
    '--safebrowsing-disable-auto-update', '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--password-store=basic', '--use-mock-keychain', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${resolve(temporary, 'profile')}`, '--window-size=1440,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await browserEndpoint(browser);
  // Keep draining stderr after startup so Chromium cannot block on a full pipe.
  browser.stderr.resume();
  cdp = await CDP.connect(endpoint);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const healthy = () => assert.deepEqual(failures, [], 'Browser errors / forbidden network requests');
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    failures.push(`Page exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'error' || type === 'assert') failures.push(`Console ${type}: ${args.map((arg) => arg.value ?? arg.description).join(' ')}`);
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') failures.push(`Browser log: ${entry.text}`);
  });
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    requests.push(request.url);
    if (!isLocal(request.url)) failures.push(`Non-local network attempted: ${request.url}`);
  });
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (!isLocal(url)) failures.push(`Non-local WebSocket attempted: ${url}`);
  });
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const local = isLocal(request.url);
    if (!local) failures.push(`Blocked non-local request: ${request.url}`);
    void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
      .catch((error) => failures.push(error.message));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

  async function page(fn, ...args) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(async () => { const assert = (ok, message) => { if (!ok) throw new Error(message); }; return (${fn.toString()})(...${JSON.stringify(args)}); })()`,
      awaitPromise: true, returnByValue: true, timeout,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
  async function ready() {
    await waitFor('nine rendered cards', async () => {
      healthy();
      return page(() => document.readyState === 'complete' && document.querySelectorAll('[data-select]').length === 9);
    });
    await page(async () => { await document.fonts.ready; await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); });
    healthy();
  }
  async function click(selector) {
    const point = await page(async (selector) => {
      const element = document.querySelector(selector);
      assert(element, `Missing clickable element: ${selector}`);
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((done) => requestAnimationFrame(done));
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      assert(rect.width > 0 && rect.height > 0 && element.contains(document.elementFromPoint(x, y)), `Obscured element: ${selector}`);
      return { x, y };
    }, selector);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    healthy();
  }
  async function cardIds(expected) {
    assert.deepEqual(await page(() => [...document.querySelectorAll('[data-select]')].map((card) => card.dataset.select)), expected);
  }
  async function search(query) {
    await page((query) => {
      const input = document.querySelector('[data-search]');
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, query);
  }
  async function viewport(width) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  }
  async function load(method, params) {
    let timer, onLoad;
    const loaded = new Promise((resolveLoad, reject) => {
      onLoad = (_, eventSession) => { if (eventSession === sessionId) resolveLoad(); };
      cdp.on('Page.loadEventFired', onLoad);
      timer = setTimeout(() => reject(new Error('Page load timed out')), timeout);
    });
    try { await Promise.all([send(method, params), loaded]); }
    finally { clearTimeout(timer); cdp.off('Page.loadEventFired', onLoad); }
    await ready();
  }
  await viewport(1440);
  await load('Page.navigate', { url: `${origin}/` });

  await page(() => {
    const cards = [...document.querySelectorAll('[data-select]')];
    assert(cards.length === 9, 'Nine candidate cards');
    for (const card of cards) {
      const style = getComputedStyle(card), rect = card.getBoundingClientRect();
      assert(rect.width > 200 && rect.height > 100 && parseFloat(style.borderRadius) > 0 && parseFloat(style.borderTopWidth) > 0, `Styled card ${card.dataset.select}`);
      const preview = card.querySelector('.mini-geometry svg');
      assert(preview && preview.getBoundingClientRect().width > 30 && preview.getBoundingClientRect().height > 30, 'Visible geometry preview');
      const paths = [...preview.querySelectorAll('path')];
      assert(paths.length === 2 && paths.every((path) => path.getAttribute('d')?.includes('L')), 'Two geometry paths');
      const primary = getComputedStyle(paths[0]), secondary = getComputedStyle(paths[1]);
      assert(primary.stroke !== 'none' && primary.stroke !== secondary.stroke && secondary.strokeDasharray !== 'none', 'Distinct solid/dashed source geometry');
      const codes = [...card.querySelectorAll('.source-line code')].map((code) => code.textContent);
      assert(codes.length === 2 && /^city-way-/.test(codes[0]) && /^open-way-/.test(codes[1]), 'Both source IDs');
      assert(/Freshness/.test(card.textContent) && /Confidence/.test(card.textContent), 'Card evidence labels');
    }
    assert(getComputedStyle(document.querySelector('.workspace')).display === 'grid', 'Desktop grid stylesheet loaded');
    assert(document.querySelectorAll('.map-svg .selected-road').length === 2, 'Selected geometry comparison');
    assert(localStorage.length === 0, 'Fresh isolated profile storage');
  });
  await click('.confidence-card details summary');
  await click('.freshness-card details summary');
  await page(() => {
    const confidence = document.querySelector('.confidence-card details');
    const freshness = document.querySelector('.freshness-card details');
    assert(confidence.open && freshness.open, 'Both evidence sections expand');
    assert(/round\(100.*clamp/.test(confidence.textContent), 'Explicit confidence formula');
    for (const label of ['Geometry', 'Name', 'Road type', 'Tag penalty', 'rounded', 'band']) assert(confidence.textContent.includes(label), `Confidence detail ${label}`);
    assert(/0\.48/.test(confidence.textContent) && /0\.32/.test(confidence.textContent) && /0\.2/.test(confidence.textContent), 'Confidence weights');
    assert(/86400000/.test(freshness.textContent) && /Recent < 180/.test(freshness.textContent) && /Stale ≥ 365/.test(freshness.textContent), 'Freshness formula and thresholds');
    assert(/not age relative to today/.test(freshness.textContent), 'Freshness basis is explicit');
  });
  await click('[data-select="cand-005"]');
  await page(() => {
    assert(document.querySelector('[data-select="cand-005"] .freshness-stale')?.textContent === 'Stale source', 'Stale cand-005 card');
    assert(document.querySelector('.freshness-label').textContent === 'Stale source', 'Stale cand-005 detail');
    assert(document.querySelector('.freshness-card').textContent.includes('379 days'), 'Stale source gap');
  });
  for (const id of ['cand-008', 'cand-009']) {
    await click(`[data-select="${id}"]`);
    await page((id) => {
      const card = document.querySelector(`[data-select="${id}"]`);
      assert(card.querySelector('.type-pill').textContent === 'Split way', `Split card ${id}`);
      assert(card.textContent.includes('city-way-2515'), 'Shared primary way');
      assert(card.textContent.includes(id === 'cand-008' ? 'open-way-1208a' : 'open-way-1208b'), 'Separate secondary split IDs');
      assert(document.querySelector('.review-subtitle').textContent.includes('Split way'), 'Split detail');
    }, id);
  }
  checks.push('9 styled cards, geometry/source IDs, expandable computations, stale and split fixtures');

  await search('cand-005');
  await cardIds(['cand-005']);
  await search('rIvEr wAlK');
  await cardIds(['cand-008', 'cand-009']);
  await search('no-such-way');
  await cardIds([]);
  await page(() => assert(document.querySelector('.empty')?.textContent.includes('No candidates'), 'Empty search message'));
  await search('');
  await click('[data-filter="accepted"]');
  await cardIds([]);
  await click('[data-filter="all"]');
  await click('[data-select="cand-001"]');
  await click('[data-decision="accepted"]');
  await page(() => assert(document.querySelector('[data-select="cand-001"] .candidate-status').textContent === 'Accepted', 'Accept visible status'));
  await click('[data-decision="rejected"]');
  await page(() => {
    assert(document.querySelector('[data-select="cand-001"] .candidate-status').textContent === 'Rejected', 'Latest rejected status');
    assert(document.querySelectorAll('.audit-event').length === 2, 'Reject preserves accept history');
  });
  await click('[data-select="cand-003"]');
  await click('[data-decision="deferred"]');
  for (const [filter, ids] of [
    ['accepted', []], ['rejected', ['cand-001']], ['deferred', ['cand-003']],
    ['pending', ['cand-002', 'cand-004', 'cand-005', 'cand-006', 'cand-007', 'cand-008', 'cand-009']],
  ]) {
    await click(`[data-filter="${filter}"]`);
    await cardIds(ids);
  }
  await click('[data-filter="all"]');
  await search('cand-001');
  await click('[data-filter="deferred"]');
  await cardIds([]);
  await search('');
  await cardIds(['cand-003']);
  await load('Page.reload', { ignoreCache: true });
  await page(() => {
    assert(document.querySelector('[data-select="cand-001"] .candidate-status').textContent === 'Rejected', 'Rejected status survives reload');
    assert(document.querySelector('[data-select="cand-003"] .candidate-status').textContent === 'Deferred', 'Deferred status survives reload');
    assert(document.querySelector('[data-tab="audit"] b').textContent === '3', 'Three audit events survive reload');
    assert(document.querySelectorAll('.audit-event').length === 2, 'Accept/reject history survives reload');
  });
  const saved = await page((key) => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(saved.length, 9);
  assert.equal(saved[0].status, 'rejected');
  assert.equal(saved[2].status, 'deferred');
  assert.deepEqual(saved[0].audit.map((event) => event.action), ['accepted', 'rejected']);
  assert.deepEqual(saved[2].audit.map((event) => event.action), ['deferred']);
  assert.equal(saved.reduce((total, item) => total + item.audit.length, 0), 3);
  checks.push('search, all status filters, repeated decisions and three persisted audit events');

  let download;
  const completedDownloads = new Set();
  cdp.on('Browser.downloadWillBegin', (event) => { download = event; });
  cdp.on('Browser.downloadProgress', (event) => {
    if (event.state === 'completed') completedDownloads.add(event.guid);
    if (event.state === 'canceled') failures.push('Browser canceled export download');
  });
  await click('[data-action="export"]');
  await waitFor('real JSON export download', () => {
    healthy();
    return download && completedDownloads.has(download.guid);
  });
  assert.equal(download.suggestedFilename, 'conflation-review-package.json');
  const exported = JSON.parse(await readFile(resolve(downloads, 'conflation-review-package.json'), 'utf8'));
  verifyExport(exported);
  checks.push('actual downloaded version-2 JSON: 9 decisions, source dates and complete audit computations');

  await click('[data-tab="audit"]');
  const rows = await page(() => [...document.querySelectorAll('.audit-list-row')].map((row) => ({
    title: row.querySelector('strong').textContent.replace(/\s+/g, ' ').trim(),
    detail: row.querySelector('.audit-list-main small').textContent,
    at: row.querySelector('time').getAttribute('datetime'),
  })));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.title).sort(), ['Accepted · cand-001', 'Deferred · cand-003', 'Rejected · cand-001']);
  assert.ok(rows.every((row) => row.at && row.detail.includes('city-way-') && row.detail.includes('open-way-') && row.detail.includes('confidence')), 'Audit UI includes source evidence');
  assert.deepEqual(rows.map((row) => row.at).sort(), saved.flatMap((item) => item.audit.map((event) => event.at)).sort(), 'Audit UI preserves exact timestamps');
  await click('[data-action="reset"]');
  await page(() => {
    assert(localStorage.length === 0, 'Reset removes stored session');
    assert(document.querySelector('[data-tab="audit"] b').textContent === '0', 'Reset clears event counter');
    assert([...document.querySelectorAll('.candidate-status')].every((status) => status.textContent === 'Needs review'), 'Reset restores pending candidates');
  });
  await load('Page.reload', { ignoreCache: true });
  await page(() => {
    assert(localStorage.length === 0, 'Storage stays empty after reset/reload');
    assert(document.querySelector('[data-tab="audit"] b').textContent === '0', 'No restored audit events');
    assert([...document.querySelectorAll('.candidate-status')].every((status) => status.textContent === 'Needs review'), 'Pending statuses survive reset/reload');
    assert(document.querySelectorAll('.audit-event').length === 0, 'No restored selected-candidate history');
  });
  await click('[data-tab="audit"]');
  await page(() => assert(document.querySelector('.empty-audit h3')?.textContent === 'No decisions yet' && !document.querySelector('.audit-list-row'), 'Empty audit UI after reset/reload'));
  await click('[data-tab="candidates"]');
  checks.push('audit UI and reset clearing storage/status/events across reload');

  await viewport(1440);
  await page(() => window.scrollTo(0, 0));
  await mkdir(dirname(screenshot), { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const png = Buffer.from(data, 'base64');
  assert.equal(png.readUInt32BE(16), 1440, 'Screenshot width');
  assert.equal(png.readUInt32BE(20), 1000, 'Screenshot height');
  await writeFile(screenshot, png);
  console.log(`Screenshot: ${screenshot}`);
  for (const width of [1024, 1440]) {
    await viewport(width);
    await page((width) => {
      assert(window.innerWidth === width, 'Requested desktop viewport');
      assert(document.documentElement.scrollWidth <= width && document.body.scrollWidth <= width, `No horizontal overflow at ${width}px`);
    }, width);
  }
  healthy();
  assert.ok(requests.some((url) => url.endsWith('/src/app.js')), 'Built application JavaScript requested');
  assert.ok(requests.some((url) => url.endsWith('/src/styles.css')), 'Built stylesheet requested');
  checks.push('1024px/1440px overflow checks; fresh 1440×1000 desktop screenshot');
  console.log(`PASS: ${checks.length} browser smoke groups\n${checks.map((check) => `  ✓ ${check}`).join('\n')}`);
  console.log(`PASS: no page exceptions, console errors, or non-local network attempts (${requests.length} tracked requests)`);
} catch (error) {
  if (checks.length) console.error(`Completed smoke groups before failure:\n${checks.map((check) => `  ✓ ${check}`).join('\n')}`);
  console.error(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (cdp) {
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  }
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit').catch(() => {}), delay(2000)]);
    if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGKILL');
      await Promise.race([once(browser, 'exit').catch(() => {}), delay(2000)]);
    }
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
