import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATUS, EQUITY, REPORT, COPY, LEGEND, wording, equityStatus, roadStatus, coverageStatus, renderLegend } from '../src/presentation.js';
import { scenario } from '../src/data.js';
import { allocate } from '../src/planner.js';
import { buildReport, renderReport } from '../src/report.js';
import { contrastRatio, relativeLuminance, parseTokens, renderedColors } from './helpers/contrast.js';

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const namedColors = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
  cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
  darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
  lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
  lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
  peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver
  skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white
  whitesmoke yellow yellowgreen`.split(/\s+/).join('|');
const colorLiteral = new RegExp(`#[\\da-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\\s*\\(|\\b(?:${namedColors})\\b`, 'gi');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const badges = (html) => [...html.matchAll(/<span\b([^>]*)>([^<]*)<\/span>/g)]
  .filter(([, attributes]) => /\bdata-status=/.test(attributes))
  .map(([, attributes, label]) => ({ key: attribute(attributes, 'data-status'), label, attributes }));

function section(html, id) {
  const start = html.indexOf(`<section id="report-${id}"`);
  assert.ok(start >= 0, `missing report-${id}`);
  return html.slice(start, html.indexOf('</section>', start));
}

function fixture({ food = 2, capacity = 100 } = {}) {
  return {
    asOf: '2025-07-01T00:00:00Z',
    resources: [{ id: 'water', name: 'Water', unit: 'liters' }, { id: 'food', name: 'Food', unit: 'kits' }],
    nodes: [
      { id: 'depot', name: 'Depot', type: 'depot', x: 0, y: 0 },
      { id: 'connected', name: 'Connected', type: 'shelter', x: 10, y: 10 },
      { id: 'isolated', name: 'Isolated', type: 'shelter', x: 20, y: 20 },
    ],
    shelters: ['connected', 'isolated'].map((id) => ({ id, nodeId: id, name: id, priority: 'high', vulnerability: 0.8, population: 100, demand: { water: 10, food: 10 } })),
    roads: [
      { id: 'open', name: 'Open route', from: 'depot', to: 'connected', minutes: 5, capacity, closed: false },
      { id: 'closed', name: 'Closed route', from: 'depot', to: 'isolated', minutes: 5, capacity: 100, closed: true },
    ],
    inventory: [
      { id: 'water', depotId: 'depot', resource: 'water', quantity: 10, expiresAt: '2025-07-02T00:00:00Z' },
      { id: 'food', depotId: 'depot', resource: 'food', quantity: food, expiresAt: '2025-07-02T00:00:00Z' },
      { id: 'old', depotId: 'depot', resource: 'water', quantity: 100, expiresAt: '2025-07-01T00:00:00Z' },
    ],
    alerts: [],
  };
}

test('independent WCAG calculation matches reference luminance and threshold cases', () => {
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#767676', '#767676'), 1);
  assert.ok(Math.abs(relativeLuminance('#0a0a0a') - (10 / 255 / 12.92)) < 1e-12);
  assert.ok(Math.abs(relativeLuminance('#0b0b0b') - ((11 / 255 + 0.055) / 1.055) ** 2.4) < 1e-12);
  assert.ok(contrastRatio('#767676', '#fff') >= 4.5);
  assert.ok(contrastRatio('#777777', '#fff') < 4.5);
  assert.ok(contrastRatio('#949494', '#fff') >= 3);
  assert.ok(contrastRatio('#959595', '#fff') < 3);
  const painted = renderedColors({ color: 'rgb(0, 0, 0)', layers: [
    { background: 'rgba(0, 0, 0, 0)', opacity: 1 },
    { background: 'rgb(255, 255, 255)', opacity: 1 },
  ] });
  assert.equal(contrastRatio(painted.foreground, painted.background), 21);
  const translucent = renderedColors({ color: '#000', layers: [{ background: '#fff', opacity: 0.5 }] });
  assert.deepEqual(translucent.foreground, [127.5, 127.5, 127.5, 1]);
  assert.deepEqual(translucent.background, [255, 255, 255, 1]);
});

test('CSS token aliases resolve transitively and invalid references fail explicitly', () => {
  assert.deepEqual(parseTokens(':root { --a: #123456; --b: var(--a); --c: var(--b); }'), { '--a': '#123456', '--b': '#123456', '--c': '#123456' });
  assert.throws(() => parseTokens(':root { --a: var(--missing); }'), /Missing CSS token/);
  assert.throws(() => parseTokens(':root { --a: var(--b); --b: var(--a); }'), /Circular CSS token/);
});

test('source color tokens meet text, status and map stroke contrast thresholds', () => {
  const tokens = parseTokens(source('tokens.css'));
  const required = ['ink', 'ink-2', 'muted', 'paper', 'white', 'teal', 'teal-dark', 'line', 'map-bg',
    ...['good', 'warn', 'info'].flatMap((tone) => [`status-${tone}-fg`, `status-${tone}-bg`]),
    ...['open', 'allocated', 'saturated', 'noCapacity', 'closed'].map((key) => `road-${key}`)];
  for (const key of required) assert.ok(tokens[`--${key}`], `missing --${key}`);
  const pairs = ['ink', 'ink-2', 'muted', 'teal', 'teal-dark'].flatMap((fg) => ['white', 'paper'].map((bg) => [fg, bg, 4.5]));
  pairs.push(...['good', 'warn', 'info'].map((tone) => [`status-${tone}-fg`, `status-${tone}-bg`, 4.5]));
  pairs.push(...['open', 'allocated', 'saturated', 'noCapacity', 'closed'].map((key) => [`road-${key}`, 'map-bg', 3]));
  for (const [fg, bg, threshold] of pairs) {
    const ratio = contrastRatio(tokens[`--${fg}`], tokens[`--${bg}`]);
    assert.ok(ratio >= threshold, `--${fg} on --${bg}: ${ratio.toFixed(3)}:1, required ${threshold}:1`);
  }
});

for (const file of ['styles.css', 'report.css']) {
  test(`${file} consumes color tokens rather than defining color literals`, () => {
    const css = source(file).replace(/\/\*[\s\S]*?\*\//g, '');
    // Custom-property names and selectors are not color literals.
    const valuesOnly = [...css.matchAll(/(?:^|[;{])\s*[-\w]+\s*:\s*([^;{}]+)/g)]
      .map(([, value]) => value.replace(/--[\w-]+/g, '')).join(';');
    assert.deepEqual(valuesOnly.match(colorLiteral) || [], [], `${file} contains literal colors`);
  });
}

test('central vocabulary and every legend entry are frozen, complete and valid', () => {
  function frozen(value, path) {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value), `${path} must be frozen`);
      for (const [key, child] of Object.entries(value)) frozen(child, `${path}.${key}`);
    }
  }
  for (const [name, value] of Object.entries({ STATUS, EQUITY, REPORT, COPY, LEGEND, wording })) frozen(value, name);
  for (const [key, status] of Object.entries(STATUS)) {
    assert.ok(status.label.trim(), `${key} label`);
    assert.ok(status.description.trim(), `${key} description`);
    assert.ok(['good', 'warn', 'info'].includes(status.tone), `${key} tone`);
  }
  assert.deepEqual(LEGEND.routes.keys, ['allocated', 'open', 'saturated', 'noCapacity', 'closed']);
  assert.deepEqual(LEGEND.shelters.keys, ['full', 'partial', 'none']);
  assert.deepEqual(LEGEND.report.keys, ['reachable', 'disconnected', 'expired', 'met', 'shortfall', 'disabled']);
  for (const [kind, legend] of Object.entries(LEGEND)) {
    assert.equal(new Set(legend.keys).size, legend.keys.length);
    const html = renderLegend(kind);
    assert.ok(html.includes(`data-legend="${kind}"`));
    assert.ok(html.includes(`aria-label="${legend.title}"`));
    const entries = [...html.matchAll(/<li\b[^>]*data-legend-status="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
    assert.deepEqual(entries.map(([, key]) => key), legend.keys);
    for (const [, key, entry] of entries) {
      assert.ok(STATUS[key], `unknown legend status ${key}`);
      assert.ok(text(entry).includes(STATUS[key].label));
      assert.ok(text(entry).includes(STATUS[key].description));
    }
  }
});

test('status classification preserves road precedence and equity/coverage boundaries', () => {
  for (const [input, expected] of [
    [{ closed: true, capacity: 0, remaining: 0, used: 0 }, 'closed'],
    [{ closed: false, capacity: 0, remaining: 0, used: 0 }, 'noCapacity'],
    [{ capacity: 5, remaining: 0, used: 5 }, 'saturated'],
    [{ capacity: 5, remaining: 3, used: 2 }, 'allocated'],
    [{ capacity: 5, remaining: 5, used: 0 }, 'open'],
  ]) assert.equal(roadStatus(input), expected);
  for (const met of [true, false]) assert.equal(equityStatus(0, met), 'disabled');
  assert.equal(equityStatus(0.4, true), 'met');
  assert.equal(equityStatus(0.4, false), 'shortfall');
  for (const [coverage, expected] of [[0, 'none'], [0.0001, 'partial'], [0.99, 'partial'], [1, 'full']]) assert.equal(coverageStatus(coverage), expected);
});

test('rendered report status keys, accessible descriptions and legend use the central definitions', () => {
  const seen = new Set();
  for (const [input, options] of [[fixture(), {}], [fixture({ food: 10 }), {}], [fixture(), { equityFloor: 0 }], [fixture({ capacity: 0 }), {}], [fixture({ capacity: 3 }), {}]]) {
    const html = renderReport(input, allocate(input, options), options);
    assert.ok(html.includes(renderLegend('report')), 'report must render the registry legend');
    assert.ok(text(html).includes(REPORT.title));
    for (const item of REPORT.sections) assert.ok(text(section(html, item.id)).includes(item.title));
    const rendered = badges(html);
    assert.ok(rendered.length > 0, 'report needs semantic status badges, not only legend labels');
    for (const badge of rendered) {
      assert.ok(STATUS[badge.key], `unknown rendered status ${badge.key}`);
      assert.equal(text(badge.label), STATUS[badge.key].label);
      assert.equal(attribute(badge.attributes, 'title'), STATUS[badge.key].description);
      assert.ok(badge.attributes.includes(`report-status-${STATUS[badge.key].tone}`));
      seen.add(badge.key);
    }
  }
  for (const key of [...LEGEND.report.keys, 'noCapacity', 'saturated', 'closed']) assert.ok(seen.has(key), `report never rendered ${key}`);
});

test('zero equity floor renders Disabled without reporting any shelter as Met', () => {
  const input = fixture();
  const options = { equityFloor: 0, inventoryScale: 0 };
  const plan = allocate(input, options);
  const report = buildReport(input, plan, options);
  assert.equal(report.equity.metCount, 2, 'planner accounting stays unchanged when its floor is vacuously met');
  assert.ok(report.equity.shelters.every((shelter) => shelter.resources.every((resource) => resource.target === 0 && resource.shortfall === 0)));
  const html = section(renderReport(input, plan, options), 'equity');
  const statuses = badges(html);
  assert.equal(statuses.filter((badge) => badge.key === 'disabled').length, 4, 'each shelter/resource row must show Disabled');
  assert.ok(statuses.every((badge) => badge.key !== 'met'));
  assert.doesNotMatch(text(html), /\b\d+\s+(?:met|of\s+\d+\s+shelters\s+met)\b/i);
  assert.ok(text(html).includes(EQUITY.disabled));
  assert.ok(text(html).includes(wording.floor(0)));
});

test('zero-capacity report rows distinguish No capacity from positive-capacity Saturated roads', () => {
  const input = fixture();
  for (const [capacity, expected] of [[0, 'noCapacity'], [3, 'saturated']]) {
    input.roads[0].capacity = capacity;
    const plan = allocate(input);
    const html = renderReport(input, plan);
    assert.deepEqual(badges(section(html, 'bottlenecks')).map((badge) => badge.key), [expected, 'closed']);
    if (capacity === 0) {
      assert.ok(badges(section(html, 'shelters')).every((badge) => badge.key === 'disconnected'));
      assert.doesNotMatch(text(section(html, 'bottlenecks')), /0% saturated|NaN|Infinity/i);
    }
  }
});

test('rendered equity keeps resource-level shortages despite aggregate coverage above the floor', () => {
  const input = fixture();
  const options = { equityFloor: 0.4 };
  const plan = allocate(input, options);
  const report = buildReport(input, plan, options);
  assert.equal(plan.shelters.find((shelter) => shelter.id === 'connected').coverage, 0.6);
  const equity = report.equity.shelters.find((shelter) => shelter.id === 'connected');
  assert.equal(equity.met, false);
  assert.deepEqual(equity.resources.map(({ id, target, allocated, shortfall }) => ({ id, target, allocated, shortfall })), [
    { id: 'water', target: 4, allocated: 10, shortfall: 0 },
    { id: 'food', target: 4, allocated: 2, shortfall: 2 },
  ]);
  const rows = [...section(renderReport(input, plan, options), 'equity').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => row).filter((row) => text(row).includes('(connected)'));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(badges(row).map((badge) => badge.key), ['shortfall']);
  const cells = [...rows[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell));
  assert.deepEqual(cells.slice(-3), ['4', '2', '2'], 'food target, final allocation and shortage must actually reach the rendered cells');
});

test('report numeric column positions stay stable through central header vocabulary', () => {
  const html = renderReport(scenario, allocate(scenario));
  const expected = [
    [REPORT.captions.shelters, [2, 4, 6, 7, 8]],
    [REPORT.captions.unmet, [3, 4, 5]],
    [REPORT.captions.bottlenecks, [1, 2, 3, 4]],
    [REPORT.captions.closed, [2]],
    [REPORT.captions.expired, [3, 4]],
    [REPORT.captions.equity, [1, 4, 5, 6]],
  ];
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)].map(([, table]) => table);
  for (const [caption, indices] of expected) {
    const table = tables.find((markup) => text(markup.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1] || '') === caption);
    assert.ok(table, `missing table ${caption}`);
    const head = table.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1];
    const headers = [...head.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)];
    const numeric = headers.flatMap(([, attributes], index) => /\breport-number\b/.test(attributes) ? [index] : []);
    assert.deepEqual(numeric, indices, `${caption} numeric indices`);
    for (const [, , label] of headers) assert.ok(Object.values(REPORT.columns).includes(text(label)), `noncentral column ${text(label)}`);
  }
});

test('central count wording handles single, zero and multiple results', () => {
  for (const [key, singular, plural] of [
    ['shelters', 'shelter', 'shelters'], ['shipments', 'shipment', 'shipments'],
    ['decisions', 'decision', 'decisions'], ['capacityIssues', 'open capacity issue', 'open capacity issues'],
    ['resourceShortfalls', 'resource shortfall', 'resource shortfalls'],
    ['shortfalls', 'shortfall', 'shortfalls'], ['openRoads', 'open road', 'open roads'],
  ]) {
    assert.equal(wording[key](1), `1 ${singular}`);
    assert.equal(wording[key](0), `0 ${plural}`);
    assert.equal(wording[key](2), `2 ${plural}`);
  }
  assert.equal(wording.lotsExcluded(1), '1 lot excluded');
  assert.equal(wording.unmetShelters(1), '1 shelter with unmet demand');
  assert.equal(wording.expiredExcluded(1), '1 unit excluded as expired');
  assert.equal(wording.scaledExcluded(1), '1 scaled unit excluded');
  assert.ok(REPORT.introduction.includes('at most two decimal places'));
  assert.ok(COPY.controlsIntro.includes('attempted equity floor'));
});
