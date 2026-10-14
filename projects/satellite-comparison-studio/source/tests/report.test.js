import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/engine.js';
import { buildReadableReport } from '../src/report.js';
import { FIXTURES, bandTile } from '../src/fixtures.js';

const NOW = '2025-06-18T12:00:00Z';
const NOW_ISO = '2025-06-18T12:00:00.000Z';
const STALE_DATE = '2025-06-01T09:00:00Z';
const SUMMARY_FIELDS = [
  'headline', 'changedWording', 'coverageWording', 'staleWording',
  'interpretation', 'appendixWording', 'outcome',
];

function tile(overrides = {}) {
  return {
    id: 'tiny-tile',
    width: 2,
    height: 2,
    crs: 'LOCAL-SYNTHETIC',
    origin: [100, 200],
    resolution: [10, -10],
    date: '2025-06-18T09:00:00Z',
    values: [0, 0.25, 0.5, 0.75],
    cloud: [false, false, false, false],
    nodata: [false, false, false, false],
    confidence: [0.9, 0.9, 0.9, 0.9],
    ...overrides,
  };
}

function reportFor(before = tile(), after = tile(), threshold = 0.2, options = {}) {
  return buildReport(before, after, threshold, {
    now: NOW, fixtureName: 'Tiny deterministic comparison', band: 'infrared', ...options,
  });
}

function decodeHtml(text) {
  return text.replace(/&#(x[\da-f]+|\d+);/gi, (_, code) =>
    String.fromCodePoint(code[0].toLowerCase() === 'x'
      ? Number.parseInt(code.slice(1), 16) : Number(code)))
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

// Read the actual downloadable payload, rather than finding JSON strings in HTML.
function embeddedReport(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => /\bid=["']reportData["']/i.test(attributes));
  assert.equal(scripts.length, 1, 'exactly one reportData script must be embedded');
  assert.match(scripts[0][1], /\btype=["']application\/json["']/i);
  return JSON.parse(scripts[0][2]);
}

function visibleText(html) {
  return decodeHtml(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function assertRoundTrip(report) {
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  const html = buildReadableReport(report);
  assert.deepEqual(embeddedReport(html), report, 'HTML download must contain the same report');
  return html;
}

function assertRenderedSummary(report) {
  const html = assertRoundTrip(report);
  const parsed = embeddedReport(html);
  const text = visibleText(html);
  for (const field of SUMMARY_FIELDS) {
    assert.equal(typeof parsed.summary[field], 'string', `summary.${field} must be a string`);
  }
  // Outcome is a machine-readable code; all prose must actually be visible,
  // including interpretation and the empty-index explanation when applicable.
  for (const field of SUMMARY_FIELDS.filter(field => field !== 'outcome')) {
    if (field === 'appendixWording' && report.pixels.changedRows.length > 0) continue;
    assert.ok(text.includes(parsed.summary[field].replace(/\s+/g, ' ').trim()),
      `visible HTML must render summary.${field} from the embedded JSON`);
  }
  return { html, text, parsed };
}

for (const band of ['infrared', 'visible']) {
  test(`bundled archive no-change control retains its outcome and both-stale warning (${band})`, () => {
    const fixture = FIXTURES['archive-haze'];
    const report = reportFor(bandTile(fixture.before, band), bandTile(fixture.after, band), 0.2, {
      fixtureName: fixture.name, band,
    });
    assert.ok(report.stats.validCount > 0);
    assert.equal(report.stats.changedCount, 0);
    assert.deepEqual(report.stale, { before: true, after: true });
    assert.match(report.summary.headline, /No change detected at threshold/i);
    assert.equal(report.summary.outcome, 'no-change-detected');
    assert.match(report.summary.staleWording, /both images are stale/i);
    assert.match(report.summary.appendixWording, /No change detected at threshold/i);
    assertRenderedSummary(report);
  });
}

test('fresh high-threshold no-change is distinct from identical or excluded pixels', () => {
  const report = reportFor(
    tile({ cloud: [true, false, false, false] }),
    tile({ values: [0.1, 0.35, 0.6, 0.85] }), 1,
  );
  assert.equal(report.stats.validCount, 3);
  assert.equal(report.stats.changedCount, 0);
  assert.deepEqual(report.stale, { before: false, after: false });
  assert.match(report.summary.headline, /No change detected at threshold/i);
  assert.equal(report.summary.outcome, 'no-change-detected');
  assert.match(report.summary.changedWording, /\b0\b.*\bmeet(?:s)?\b.*threshold/i);
  assert.doesNotMatch(report.summary.changedWording, /\bpixels? changed\b/i);
  assert.match(report.summary.interpretation, /(?:not|doesn't|≠|!=).*identical/i);
  assert.match(report.summary.interpretation, /excluded pixels.*(?:not assessed|not evaluated|not compared|unassessed)/i);
  assert.match(report.summary.appendixWording, /No change detected at threshold/i);
  assertRenderedSummary(report);
});

for (const [name, before, after, expected] of [
  ['all nodata', tile({ nodata: [true, true, true, true] }), tile(), {
    nodataCount: 4, nonFiniteCount: 0, differences: [0, 0, 0, 0],
  }],
  ['all non-finite', tile({ values: [NaN, Infinity, 0, 0] }),
    tile({ values: [0, 0, -Infinity, NaN] }), {
      nodataCount: 0, nonFiniteCount: 4, differences: [null, null, null, null],
    }],
]) {
  test(`${name} is not-comparable, not a measured zero-change fraction`, () => {
    const report = reportFor(before, after);
    assert.equal(report.stats.validCount, 0);
    assert.equal(report.stats.changedCount, 0);
    assert.equal(report.stats.coverage, 0);
    assert.equal(report.stats.changedFraction, 0, 'keep the legacy numeric compatibility value');
    assert.equal(report.stats.meanConfidence, null);
    assert.equal(report.excluded.nodataCount, expected.nodataCount);
    assert.equal(report.excluded.nonFiniteCount, expected.nonFiniteCount);
    assert.equal(report.excluded.count, 4);
    assert.deepEqual(report.pixels.differences, expected.differences);
    assert.deepEqual(report.pixels.valid, [false, false, false, false]);
    assert.deepEqual(report.pixels.changed, [false, false, false, false]);
    assert.deepEqual(report.pixels.changedIndices, []);
    assert.deepEqual(report.pixels.changedRows, []);
    assertRoundTrip(report);
    assert.match(report.summary.headline, /Not comparable/i);
    assert.equal(report.summary.outcome, 'not-comparable');
    assert.match(report.summary.changedWording, /not available|N\/A/i);
    assert.doesNotMatch(report.summary.changedWording,
      /valid[- ]pixel[^.]*\b(?:is|of|:)\s*0(?:\.0+)?\s*%|\b0(?:\.0+)?\s*%[^.]*valid[- ]pixel/i);
    assert.match(report.summary.appendixWording, /No valid pixels were available/i);
    assert.doesNotMatch(report.summary.appendixWording, /No change detected/i);
    assertRenderedSummary(report);
  });
}

test('all-invalid HTML does not present a successful green comparison or no-change finding', () => {
  const report = reportFor(tile({ nodata: [true, true, true, true] }), tile());
  const html = assertRoundTrip(report);
  const text = visibleText(html);
  assert.match(text, /Not comparable/i);
  assert.match(text, /No valid pixels were available/i);
  assert.match(text, /not available|N\/A/i);
  assert.doesNotMatch(text, /No change detected at threshold|No valid pixels meet the current threshold/i);
  const statuses = [...html.matchAll(/<[^>]+class=["']([^"']*\bstatus\b[^"']*)["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)];
  for (const [, classes] of statuses) {
    assert.doesNotMatch(classes, /\bgood\b/i, 'not-comparable must not use a positive-green status');
  }
});

test('zero threshold explicitly explains that unchanged valid pixels meet the threshold', () => {
  const report = reportFor(tile(), tile(), 0);
  assert.equal(report.stats.changedCount, 4);
  assert.deepEqual(report.pixels.differences, [0, 0, 0, 0]);
  assert.deepEqual(report.pixels.changedIndices, [0, 1, 2, 3]);
  assert.equal(report.summary.outcome, 'change-detected');
  assert.match(report.summary.changedWording, /\b4\b.*\bmeet\b.*threshold/i);
  assert.doesNotMatch(report.summary.changedWording, /\bpixels? changed\b/i);
  assert.match(report.summary.interpretation, /(?:zero|\b0\b).*threshold|threshold.*(?:zero|\b0\b)/i);
  assert.match(report.summary.interpretation, /unchanged (?:valid )?pixels.*meet.*threshold/i);
  assertRenderedSummary(report);
});

test('one qualifying pixel uses singular meets in the headline', () => {
  const report = reportFor(tile(), tile({ values: [0.5, 0.25, 0.5, 0.75] }), 0.5);
  assert.equal(report.stats.changedCount, 1);
  assert.match(report.summary.headline, /\b1 valid pixel meets\b/i);
  assert.doesNotMatch(report.summary.headline, /\b1 valid pixels? meet\b/i);
  assert.equal(report.summary.outcome, 'change-detected');
  assert.match(report.summary.changedWording, /\b1\b.*\bmeet(?:s)?\b.*threshold/i);
  assertRenderedSummary(report);
});

for (const [name, dates, stale, warning] of [
  ['before only', [STALE_DATE, '2025-06-18T09:00:00Z'], { before: true, after: false }, /before image is stale/i],
  ['after only', ['2025-06-18T09:00:00Z', STALE_DATE], { before: false, after: true }, /after image is stale/i],
  ['both images', [STALE_DATE, STALE_DATE], { before: true, after: true }, /both images are stale/i],
]) {
  test(`freshness warning identifies ${name} without replacing a detected-change outcome`, () => {
    const report = reportFor(tile({ date: dates[0] }),
      tile({ date: dates[1], values: [0.5, 0.75, 1, 0.25] }), 0.5);
    assert.equal(report.stats.changedCount, 4);
    assert.deepEqual(report.stale, stale);
    assert.match(report.summary.headline, /4 valid pixels meet/i);
    assert.equal(report.summary.outcome, 'change-detected');
    assert.match(report.summary.staleWording, warning);
    if (/stale/i.test(report.summary.headline)) assert.match(report.summary.headline, warning);
    assertRenderedSummary(report);
  });
}

test('analysisAt and generatedAt use the supplied analysis clock and HTML labels it UTC', () => {
  const report = reportFor();
  assert.equal(report.generatedAt, NOW_ISO);
  assert.equal(report.analysisAt, NOW_ISO);
  assert.equal(report.analysisAt, report.generatedAt);
  const { text, parsed } = assertRenderedSummary(report);
  assert.equal(parsed.analysisAt, NOW_ISO);
  assert.match(Object.values(parsed.summary).join(' '), /analysis clock/i);
  assert.match(text, /analysis clock/i);
  assert.match(text, /UTC/);
  assert.match(text, /18.*(?:JUN|06).*2025/i);
});

test('0.005 threshold stays precise in visible HTML and embedded JSON', () => {
  const report = reportFor(tile({ values: [0, 0, 0, 0] }),
    tile({ values: [0.0049, 0.005, 0.0051, 0] }), 0.005);
  assert.equal(report.threshold.value, 0.005);
  assert.deepEqual(report.pixels.changedIndices, [1, 2]);
  const html = assertRoundTrip(report);
  const parsed = embeddedReport(html);
  const text = visibleText(html);
  assert.equal(parsed.threshold.value, 0.005);
  assert.match(text, /Threshold\s*:?\s*(?:0)?\.005\b/i);
  assert.doesNotMatch(text, /Threshold\s*:?\s*0?\.01\b/i,
    'visible threshold must not be rounded to a different decision boundary');
  assertRenderedSummary(report);
});

test('continuous low-confidence legend includes values between 0.64 and 0.65', () => {
  const report = reportFor(tile({ confidence: [0, 0.649, 0.65, 1] }), tile());
  assert.deepEqual(report.pixels.lowConfidenceIndices, [0, 1]);
  assert.match(report.legends.confidence.low, /0\s*≤\s*confidence\s*<\s*0\.65/);
  assert.doesNotMatch(report.legends.confidence.low, /0\.64/);
  const html = assertRoundTrip(report);
  assert.match(visibleText(html), /0\s*≤\s*confidence\s*<\s*0\.65/);
});

test('overlapping masks and non-finite exclusions agree with counts and changed-row arrays', () => {
  const report = reportFor(
    tile({ values: [0, NaN, 0, 0], cloud: [true, false, false, false], confidence: [0.1, 0.2, 0.64, 0.9] }),
    tile({ values: [1, 1, 0.5, 0], nodata: [true, false, false, false] }), 0.5,
  );
  assert.deepEqual(report.excluded.indices, [0, 1]);
  assert.deepEqual(report.excluded.cloudIndices, [0]);
  assert.deepEqual(report.excluded.nodataIndices, [0]);
  assert.deepEqual(report.excluded.nonFiniteIndices, [1]);
  assert.equal(report.excluded.count, 2, 'overlapping mask categories exclude a pixel only once');
  for (const category of ['cloud', 'nodata', 'nonFinite']) {
    assert.equal(report.excluded[`${category}Count`], report.excluded[`${category}Indices`].length);
    assert.equal(report.stats[`${category}Count`], report.excluded[`${category}Count`]);
  }
  assert.equal(report.stats.excludedCount, report.excluded.indices.length);
  assert.equal(report.stats.validCount, 2);
  assert.equal(report.stats.coverage, 0.5);
  assert.equal(report.stats.changedCount, 1);
  assert.equal(report.stats.changedFraction, 0.5);
  assert.deepEqual(report.pixels.valid, [false, false, true, true]);
  assert.deepEqual(report.pixels.changed, [false, false, true, false]);
  assert.deepEqual(report.pixels.changedIndices, [2]);
  assert.deepEqual(report.pixels.lowConfidenceIndices, [2]);
  assert.deepEqual(report.pixels.changedRows, [{ index: 2, row: 1, column: 0, difference: 0.5, confidence: 0.64 }]);
  assert.equal(report.pixels.changedRows.length, report.stats.changedCount);
  for (const row of report.pixels.changedRows) {
    assert.equal(report.pixels.valid[row.index], true);
    assert.equal(report.excluded.indices.includes(row.index), false);
    assert.equal(row.difference, report.pixels.differences[row.index]);
    assert.equal(row.confidence, report.pixels.confidence[row.index]);
  }
  const html = assertRoundTrip(report);
  assert.match(visibleText(html), /2 total pixels excluded/i);
});

test('malicious fixture name is escaped in HTML while embedded JSON preserves the original', () => {
  const fixtureName = '</script><script>alert("fixture")</script> & <b>archive</b>';
  const report = reportFor(tile(), tile(), 0.2, { fixtureName, band: 'visible' });
  const html = assertRoundTrip(report);
  const parsed = embeddedReport(html);
  assert.equal(parsed.fixtureName, fixtureName);
  assert.equal(parsed.band, 'visible');
  assert.doesNotMatch(html, /<script>\s*alert\(/i);
  assert.doesNotMatch(html, /<b>archive<\/b>/i);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;/);
  assert.ok(visibleText(html).includes(fixtureName), 'escaped fixture name remains readable');
});
