import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/data.js';
import { applyWhatIf, buildSignoffReport } from '../src/model.js';
import { escapeHtml, signoffCsv, signoffHtml } from '../src/report-export.js';

function reportFor(context = {}, snapshot = demoSnapshot) {
  return buildSignoffReport(structuredClone(snapshot), context);
}

function reportWithCandidate(id = 'false-path', context = {}) {
  const snapshot = structuredClone(demoSnapshot);
  const report = buildSignoffReport(snapshot, context);
  const selected = report.context;
  const modeled = applyWhatIf(snapshot, id, selected.analysis, selected.stage, selected.corner, selected.mode);
  report.candidate = {
    id: modeled.candidate.id,
    title: modeled.candidate.title,
    modeledSummary: modeled.summary,
    paths: modeled.paths
  };
  return report;
}

function htmlTable(html, id) {
  const match = html.match(new RegExp(`<table id="${id}">([\\s\\S]*?)</table>`));
  assert.ok(match, `Missing HTML table: ${id}`);
  return match[1];
}

function htmlRow(table, needle) {
  const row = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].find((match) => match[1].includes(escapeHtml(needle)));
  assert.ok(row, `Missing HTML row: ${needle}`);
  return row[1];
}

// Parse quoted CSV, including embedded newlines and doubled quotes, so assertions
// check cell values and row counts instead of depending on a quoting style.
function csvRecords(csv) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(value);
      value = '';
    } else if (!quoted && (character === '\r' || character === '\n')) {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
    } else value += character;
  }
  assert.equal(quoted, false, 'Unterminated CSV quotation');
  if (row.length || value) rows.push([...row, value]);
  const headers = rows.shift();
  assert.ok(headers?.length);
  return rows.map((cells) => {
    assert.equal(cells.length, headers.length, 'CSV row lost or gained a column');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
}

test('escapeHtml handles markup, quotes, and primitive values', () => {
  assert.equal(escapeHtml(`<script>alert("x") & 'y'</script>`), '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('demo export retains all setup paths, summaries, provenance, clocks, hotspots, and hold exceptions', () => {
  const report = reportFor();
  const html = signoffHtml(report);
  const rows = csvRecords(signoffCsv(report));
  assert.deepEqual(rows.map((row) => row.path_id), report.baseline.worstPaths.map((path) => path.id));
  for (const path of report.baseline.worstPaths) assert.match(htmlTable(html, 'selected-paths'), new RegExp(path.id));
  for (const exception of report.exceptions) {
    const row = htmlRow(htmlTable(html, 'exception-inventory'), exception.id);
    assert.ok(row.includes(exception.analysis));
    assert.ok(row.includes(exception.label));
  }
  assert.match(htmlTable(html, 'exception-inventory'), /p-013/);
  assert.match(htmlTable(html, 'setup-summary'), /WNS \(ns\)/);
  assert.ok(htmlTable(html, 'setup-summary').includes(String(report.baseline.setup.tns)));
  assert.ok(htmlTable(html, 'hold-summary').includes(String(report.baseline.hold.wns)));
  assert.match(htmlTable(html, 'manifest-metadata'), /orion_dsp_top/);
  assert.match(htmlTable(html, 'clocks'), /clk_core/);
  assert.match(htmlTable(html, 'clock-pairs'), /asynchronous/);
  assert.match(htmlTable(html, 'hotspots'), /hot-1/);
  assert.match(htmlTable(html, 'hotspots'), /n_102/);
  assert.match(html, /No real silicon sign-off claim/);
  const falsePath = rows.find((row) => row.path_id === 'p-007');
  assert.equal(falsePath.status, 'EXCLUDED');
  assert.equal(falsePath.disposition, 'false_path_excluded');
  assert.equal(falsePath.exception_status, 'applied');
  assert.equal(falsePath.source, 'constraints.sdc');
  assert.equal(falsePath.launch_clock, 'clk_core');
  assert.equal(falsePath.capture_clock, 'clk_dbg');
  assert.equal(falsePath.clock_relation, 'asynchronous');
  assert.equal(falsePath.excluded, 'true');
  assert.deepEqual(JSON.parse(falsePath.exception), report.baseline.worstPaths.find((path) => path.id === 'p-007').exception);
  assert.doesNotMatch(htmlTable(html, 'negative-violations'), /p-007/);
  assert.match(htmlTable(html, 'false-path-exclusions'), /p-007/);
  assert.match(htmlTable(html, 'candidate-exception-inventory'), /p-006/);
});

test('stale timing is separate from numerical violations and uses computed source reasons', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.manifest.sourceReports.find((source) => source.kind === 'paths').snapshotId = 'SNAP-OLD';
  const report = reportFor({}, snapshot);
  const html = signoffHtml(report);
  const sources = htmlTable(html, 'unverified-sources');
  const staleSource = htmlRow(sources, 'report_timing.rpt');
  assert.match(staleSource, /<td>fresh<\/td>/); // Declared status must not conceal computed staleness.
  assert.match(staleSource, /STALE/);
  assert.match(staleSource, /snapshot_mismatch/);
  const path = csvRecords(signoffCsv(report)).find((row) => row.path_id === 'p-001');
  assert.equal(path.slack, '-0.183');
  assert.equal(path.status, 'VIOLATION');
  assert.equal(path.timing_freshness, 'stale');
  assert.equal(path.constraint_freshness, 'fresh');
  assert.equal(path.overall_evidence, 'stale');
  assert.equal(path.signoff_eligible, 'false');
  assert.match(path.freshness_reasons, /snapshot_mismatch/);
  assert.match(htmlTable(html, 'negative-violations'), /p-001/);
  assert.match(htmlTable(html, 'false-path-exclusions'), /p-007/);
});

test('missing and invalid timestamps are exported as unverified evidence with reasons', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.manifest.sourceReports.find((source) => source.kind === 'timing').generatedAt = null;
  snapshot.manifest.sourceReports.find((source) => source.kind === 'constraints').generatedAt = 'not a date';
  const report = reportFor({}, snapshot);
  const html = signoffHtml(report);
  assert.match(htmlTable(html, 'unverified-sources'), /UNKNOWN \/ UNVERIFIED/);
  assert.match(htmlTable(html, 'unverified-sources'), /missing_timestamp/);
  assert.match(htmlTable(html, 'unverified-sources'), /invalid_timestamp/);
  const rows = csvRecords(signoffCsv(report));
  assert.ok(rows.every((row) => row.overall_evidence === 'unknown' && row.signoff_eligible === 'false'));
  assert.ok(rows.every((row) => row.timing_freshness === 'unknown' && row.constraint_freshness === 'unknown'));
  assert.match(rows[0].freshness_reasons, /missing_timestamp/);
  assert.match(rows[0].freshness_reasons, /invalid_timestamp/);
});

test('stale constraints keep applied exceptions unverified instead of excluding negative slack', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.manifest.sourceReports.find((source) => source.kind === 'constraints').status = 'stale';
  snapshot.paths.find((path) => path.id === 'p-007').slack = -0.1;
  const report = reportFor({}, snapshot);
  const html = signoffHtml(report);
  const path = csvRecords(signoffCsv(report)).find((row) => row.path_id === 'p-007');
  assert.equal(path.disposition, 'exception_unverified');
  assert.equal(path.excluded, 'false');
  assert.equal(path.review, 'true');
  assert.equal(path.slack, '-0.1');
  assert.match(path.status, /VIOLATION/);
  assert.match(htmlTable(html, 'negative-violations'), /p-007/);
  assert.doesNotMatch(htmlTable(html, 'false-path-exclusions'), /p-007/);
  assert.match(htmlTable(html, 'unverified-exception-inventory'), /p-007/);
  assert.match(htmlTable(html, 'unverified-exception-inventory'), /p-013/);
});

test('clock-group fixture retains negative excluded paths without treating them as violations', () => {
  const snapshot = structuredClone(demoSnapshot);
  for (const id of ['p-007', 'p-013']) {
    const path = snapshot.paths.find((item) => item.id === id);
    path.exception = { ...path.exception, kind: 'clock_group' };
    path.slack = id === 'p-007' ? -0.75 : -0.02;
  }
  const report = reportFor({}, snapshot);
  const html = signoffHtml(report);
  const groups = htmlTable(html, 'clock-group-exclusions');
  assert.match(groups, /p-007/);
  assert.match(groups, /p-013/);
  assert.match(groups, /CLOCK GROUP · EXCLUDED/);
  assert.match(groups, /asynchronous/);
  assert.doesNotMatch(htmlTable(html, 'false-path-exclusions'), /p-007/);
  assert.doesNotMatch(htmlTable(html, 'negative-violations'), /p-007/);
  assert.match(htmlTable(html, 'selected-paths'), /p-007/);
  const path = csvRecords(signoffCsv(report)).find((row) => row.path_id === 'p-007');
  assert.equal(path.disposition, 'clock_group_excluded');
  assert.equal(path.status, 'EXCLUDED');
  assert.equal(path.excluded, 'true');
  assert.equal(path.slack, '-0.75');
  assert.equal(path.exception_kind, 'clock_group');
});

test('hold export follows the selected analysis and still includes setup exceptions in HTML', () => {
  const report = reportFor({ analysis: 'hold' });
  const html = signoffHtml(report);
  const rows = csvRecords(signoffCsv(report));
  assert.deepEqual(rows.map((row) => row.path_id), report.baseline.worstPaths.map((path) => path.id));
  assert.ok(rows.every((row) => row.analysis === 'hold'));
  assert.match(html, /Selected analysis paths · hold/);
  assert.doesNotMatch(htmlTable(html, 'selected-paths'), /p-001/);
  assert.match(htmlTable(html, 'exception-inventory'), /p-006/);
  assert.match(htmlTable(html, 'exception-inventory'), /p-013/);
  assert.deepEqual(rows.filter((row) => row.slack === '-0.006').map((row) => row.path_id), ['p-010', 'p-011']);
});

test('derived contexts are explicit in HTML and CSV and do not imply reported STA', () => {
  const report = reportFor({ stage: 'placement', corner: 'fast', mode: 'scan', analysis: 'hold' });
  const html = signoffHtml(report);
  assert.match(html, /DERIVED CONTEXT/);
  assert.match(html, /not independently reported STA/);
  assert.match(htmlTable(html, 'analysis-context'), /placement/);
  const rows = csvRecords(signoffCsv(report));
  assert.ok(rows.every((row) => row.origin === 'derived' && row.status.startsWith('DERIVED')));
  assert.deepEqual(JSON.parse(rows[0].context), report.context);
});

test('modeled constraint candidate rows and exceptions are separate from the baseline', () => {
  const report = reportWithCandidate();
  const html = signoffHtml(report);
  const rows = csvRecords(signoffCsv(report));
  const baseline = rows.filter((row) => row.row_type === 'baseline');
  const modeled = rows.filter((row) => row.row_type === 'modeled_candidate');
  assert.equal(baseline.length, report.baseline.worstPaths.length);
  assert.equal(modeled.length, report.candidate.paths.length);
  assert.equal(baseline.find((row) => row.path_id === 'p-006').excluded, 'false');
  assert.equal(modeled.find((row) => row.path_id === 'p-006').excluded, 'true');
  assert.ok(modeled.every((row) => row.origin === 'modeled' && row.status.startsWith('MODELED')));
  assert.ok(modeled.every((row) => row.candidate_id === 'false-path' && row.candidate_title === report.candidate.title));
  assert.match(html, /MODELED ONLY/);
  assert.match(htmlTable(html, 'candidate-modeled-exceptions'), /p-006/);
  assert.match(htmlTable(html, 'candidate-paths'), /MODELED · VIOLATION/);
  assert.match(htmlTable(html, 'candidate-summary'), /Area \(µm²\)/);
  assert.match(htmlTable(html, 'candidate-summary'), /Power \(mW\)/);
  const withoutCandidate = { ...report, candidate: null };
  assert.deepEqual(baseline, csvRecords(signoffCsv(withoutCandidate)));
});

test('hold candidate exports its full modeled summary and labels even unchanged paths as modeled', () => {
  const report = reportWithCandidate('resize-buf', { analysis: 'hold', stage: 'cts' });
  const rows = csvRecords(signoffCsv(report)).filter((row) => row.row_type === 'modeled_candidate');
  assert.ok(rows.every((row) => row.analysis === 'hold' && row.origin === 'modeled'));
  assert.ok(rows.some((row) => row.status === 'MODELED · VIOLATION'));
  const summary = htmlTable(signoffHtml(report), 'candidate-summary');
  assert.ok(summary.includes(String(report.candidate.modeledSummary.wns)));
  assert.match(summary, /hold/);
  assert.doesNotMatch(summary, /Setup WNS/);
});

test('supplied path and source metadata takes precedence over legacy fallback inference', () => {
  const report = reportFor();
  const path = report.baseline.worstPaths[0];
  path.exception = { kind: 'false_path', status: 'applied', sourceReport: 'old.sdc' };
  path.classification = {
    disposition: 'exception_review', excluded: false, review: true, label: 'METADATA REVIEW',
    kind: 'multicycle', status: 'candidate', source: 'review.sdc'
  };
  path.timingFreshness = 'unknown';
  path.constraintFreshness = 'stale';
  path.freshnessReasons = ['metadata_reason'];
  path.origin = 'derived';
  const source = report.evidence.reports[0];
  source.freshness = 'unknown';
  source.unknown = true;
  source.reasons = ['computed_reason'];
  report.evidence.overall = 'unknown';
  const html = signoffHtml(report);
  const row = csvRecords(signoffCsv(report))[0];
  assert.equal(row.classification, 'METADATA REVIEW');
  assert.equal(row.disposition, 'exception_review');
  assert.equal(row.exception_kind, 'multicycle');
  assert.equal(row.exception_status, 'candidate');
  assert.equal(row.excluded, 'false');
  assert.equal(row.source, 'review.sdc');
  assert.equal(row.timing_freshness, 'unknown');
  assert.equal(row.constraint_freshness, 'stale');
  assert.match(row.freshness_reasons, /metadata_reason/);
  assert.equal(row.origin, 'derived');
  assert.match(htmlTable(html, 'selected-paths'), /METADATA REVIEW/);
  assert.match(htmlRow(htmlTable(html, 'source-reports'), source.name), /UNKNOWN \/ UNVERIFIED/);
  assert.match(htmlTable(html, 'unverified-sources'), /computed_reason/);
});

test('HTML escapes hostile values throughout provenance, paths, exceptions, clocks, hotspots, and candidates', () => {
  const report = reportWithCandidate();
  const payload = `<img src="x" onerror='attack()'> & <script>attack()</script>`;
  report.manifest.design = payload;
  report.context.mode = payload;
  report.evidence.reports[0].name = payload;
  report.evidence.reports[0].reasons = [payload];
  report.baseline.worstPaths[0].endpoint = payload;
  report.baseline.clocks[0].name = payload;
  report.baseline.hotspots[0].id = payload;
  report.exceptions[0].source = payload;
  report.exceptions[0].exception.note = payload;
  report.candidate.title = payload;
  report.candidate.modeledSummary.note = payload;
  const html = signoffHtml(report);
  for (const id of ['manifest-metadata', 'analysis-context', 'source-reports', 'selected-paths', 'clocks', 'hotspots', 'exception-inventory', 'candidate-summary']) {
    assert.ok(htmlTable(html, id).includes('&lt;img'), `Payload missing from ${id}`);
  }
  assert.doesNotMatch(html, /<img\b|<script\b/i);
  assert.match(html, /&quot;x&quot;/);
  assert.match(html, /&#39;attack\(\)&#39;/);
});

test('CSV quotes multiline text and neutralizes every formula prefix while preserving negative numeric slack', () => {
  const report = reportWithCandidate();
  const path = report.baseline.worstPaths[0];
  path.startpoint = '=HYPERLINK("url", "label")\r\nsecond line';
  path.endpoint = '+command';
  path.launchClock = '@launch';
  path.captureClock = ' \t=capture';
  path.exception = '-exception text';
  path.classification = { disposition: 'timed', excluded: false, review: false, label: '@label', source: '-source' };
  path.slack = -0.5;
  report.candidate.title = '@candidate';
  const reasons = ['=formula', '+formula', '-text', '@formula', '  =hidden', '\tcontrol', '\ncontrol', 'comma, "quote"\r\nline'];
  report.baseline.worstPaths.forEach((item, index) => { item.reason = reasons[index]; });
  const csv = signoffCsv(report);
  const rows = csvRecords(csv);
  const first = rows[0];
  assert.equal(first.startpoint, `'${path.startpoint}`);
  assert.equal(first.endpoint, "'+command");
  assert.equal(first.launch_clock, "'@launch");
  assert.equal(first.capture_clock, "' \t=capture");
  assert.equal(first.exception, "'-exception text");
  assert.equal(first.source, "'-source");
  assert.equal(first.classification, "'@label");
  assert.equal(first.slack, '-0.5');
  assert.match(csv, /,-0\.5,/);
  reasons.forEach((reason, index) => assert.equal(rows[index].reason, index < 7 ? `'${reason}` : reason));
  assert.ok(rows.filter((row) => row.row_type === 'modeled_candidate').every((row) => row.candidate_title === "'@candidate"));
});

test('serializers are deterministic, do not mutate frozen reports, and handle empty path inventories', () => {
  const report = reportWithCandidate();
  const before = structuredClone(report);
  const freeze = (value) => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(report);
  assert.equal(signoffHtml(report), signoffHtml(report));
  assert.equal(signoffCsv(report), signoffCsv(report));
  assert.deepEqual(report, before);
  const empty = reportFor();
  empty.baseline.worstPaths = [];
  empty.exceptions = [];
  empty.candidate = null;
  assert.deepEqual(csvRecords(signoffCsv(empty)), []);
  assert.match(htmlTable(signoffHtml(empty), 'selected-paths'), /None reported/);
  assert.match(signoffHtml({}), /UNKNOWN \/ UNVERIFIED/);
});

test('fresh evidence cannot turn open timing violations into sign-off eligibility', () => {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.paths.find((path) => path.id === 'p-006').exception = null;
  const report = reportFor({}, snapshot);
  assert.equal(report.evidenceEligible, true);
  assert.equal(report.signoffEligible, false);
  assert.ok(report.baseline.setup.violations > 0);
  const html = signoffHtml(report);
  assert.match(html, /Report signoffEligible: false/);
  assert.match(html, /Closure status: OPEN/);
  assert.match(html, /No real silicon sign-off claim/);
  assert.ok(csvRecords(signoffCsv(report)).every((row) => row.signoff_eligible === 'false'));
});
