import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenario } from '../src/data.js';
import { allocate } from '../src/planner.js';
import { buildReport } from '../src/report.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FORMATTER_URL = new URL('../src/terminal-report.js', import.meta.url);
const HEADINGS = [
  'Climate Resource Allocator - sample scenario',
  'Baseline summary',
  'Shelter coverage',
  'Resources (demand / allocated / unmet)',
  'Constraints and equity',
  'What-if scenarios',
];
const ENVIRONMENTS = [
  { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  { TZ: 'America/New_York', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' },
  { TZ: 'America/New_York', LANG: 'C', LC_ALL: 'C' },
];

function runCommand(name, environment = ENVIRONMENTS[0]) {
  const scriptPath = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...environment, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${name} terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${name} failed:\n${result.stderr}`);
  assert.equal(result.stderr, '', `${name} must not write to stderr`);
  return result.stdout;
}

function assertCleanOutput(stdout, maxWidth = Infinity) {
  assert.equal(typeof stdout, 'string');
  assert.ok(stdout.length > 0, 'output must not be empty');
  assert.doesNotMatch(stdout, /[\u001b\u009b]/u, 'output must not contain ANSI escapes');
  assert.doesNotMatch(stdout, /\b(?:undefined|NaN|Infinity)\b/, 'output must contain valid values');
  assert.doesNotMatch(stdout, /\r/, 'output must use deterministic LF line endings');
  for (const [index, line] of stdout.split('\n').entries()) {
    assert.doesNotMatch(line, /\s$/u, `line ${index + 1} has trailing whitespace`);
    assert.ok([...line].length <= maxWidth, `line ${index + 1} exceeds ${maxWidth} characters: ${line}`);
  }
}

function sampleSections(stdout) {
  assertCleanOutput(stdout, 80);
  assert.doesNotMatch(stdout, /\n{3}/, 'sections must have exactly one separating blank line');
  const lines = stdout.split('\n');
  const indices = HEADINGS.map((heading) => {
    const matches = lines.flatMap((line, index) => line === heading ? [index] : []);
    assert.equal(matches.length, 1, `expected heading exactly once: ${heading}`);
    return matches[0];
  });
  assert.equal(indices[0], 0, 'title must be the first line');
  for (let index = 1; index < indices.length; index += 1) {
    assert.ok(indices[index] > indices[index - 1], `${HEADINGS[index]} is out of order`);
    assert.equal(lines[indices[index] - 1], '', `${HEADINGS[index]} needs a separating blank line`);
    assert.notEqual(lines[indices[index] - 2], '', `${HEADINGS[index]} has extra blank lines`);
  }
  return HEADINGS.map((_, index) => {
    const end = indices[index + 1] === undefined ? lines.length : indices[index + 1] - 1;
    const body = lines.slice(indices[index] + 1, end);
    // A final standalone success message may have its own separating blank line.
    const successIndex = body.indexOf('Sample scenario checks passed.');
    const content = successIndex < 0 ? body : body.slice(0, successIndex);
    while (content.at(-1) === '') content.pop();
    assert.ok(content.length > 0, `${HEADINGS[index]} must have content`);
    assert.ok(content.every((line) => line !== ''), `${HEADINGS[index]} has an extra section break`);
    return body.join('\n');
  });
}

function assertLabelValue(section, label, value) {
  // Labels may have qualifiers and padding; the colon and grouped value matter.
  assert.match(section, new RegExp(`^[ \\t]*[^:\\n]*\\b(?:${label})\\b[^:\\n]*:[ \\t]*${value}(?=[ \\t]|$)`, 'im'));
}

function assertSampleSummary(stdout) {
  const [introduction, baseline, shelters, resources, constraints, whatIf] = sampleSections(stdout);
  assert.match(introduction, /^(?=[^\n]*\bSynthetic\b)(?=[^\n]*\bsnapshot\b)(?=[^\n]*\bUTC\b)(?=[^\n]*2026-10-14)(?=[^\n]*09:00)[^\n]*:[^\n]+$/im,
    'snapshot must be explicitly synthetic, timestamped, and UTC');
  assert.ok(introduction.includes('Synthetic planning only; not an emergency dispatch system.'));
  for (const [label, value] of [
    ['demand', '4,682'],
    ['allocated', '3,747'],
    ['unmet', '935'],
    ['expired', '335'],
    ['available|usable', '4,880'],
    ['coverage', '80\\.03%'],
  ]) assertLabelValue(baseline, label, value);

  for (const shelter of scenario.shelters) {
    const line = shelters.split('\n').find((entry) => entry.includes(shelter.name) || entry.includes(shelter.id));
    assert.ok(line, `missing shelter coverage: ${shelter.name}`);
    assert.match(line, /:[^\n]*\d+(?:\.\d+)?%/, `${shelter.name} needs labeled percentage coverage`);
  }
  const resourceQuantities = {
    water: ['3,360', '2,764', '596'],
    food: ['1,120', '832', '288'],
    medical: ['202', '151', '51'],
  };
  for (const resource of scenario.resources) {
    const line = resources.split('\n').find((entry) => entry.includes(resource.name) || entry.includes(resource.id));
    assert.ok(line, `missing resource totals: ${resource.name}`);
    const quantities = resourceQuantities[resource.id].join('[ \\t]*\\/[ \\t]*');
    assert.match(line, new RegExp(`:[ \\t]*${quantities}(?:[ \\t]|$)`),
      `${resource.name} needs correct grouped demand / allocated / unmet quantities`);
  }
  assert.match(constraints, /bottleneck[^\n]*:/i);
  assert.match(constraints, /equity[^\n]*:/i);
  assert.match(whatIf, /\b4,272\b/, 'expanded capacity allocation must be grouped');
  assert.match(whatIf, /\+525\b/, 'expanded capacity must show the signed improvement');
  assert.match(whatIf, /\b410\b/, 'expanded capacity must show remaining unmet demand');
  assert.match(whatIf, /inventory[^\n]*:/i);
  assert.match(whatIf, /hill(?:top|-access)[^\n]*:/i);
}

function assertReadabilitySummary(stdout) {
  assertCleanOutput(stdout);
  const lines = stdout.split('\n');
  assert.equal(lines.pop(), '', 'readability summary must end in a newline');
  assert.equal(lines.shift(), 'Report markup readability check passed.');
  assert.equal(lines.length, 3, 'each readability count must have its own line');
  for (const [index, [label, value]] of [
    ['sections?', '5'], ['tables?', '6'], ['priority badges?', '18'],
  ].entries()) {
    assert.match(lines[index], new RegExp(`^[ \\t]+${label}:[ \\t]*${value}$`, 'i'));
  }
}

test('sample command prints the complete readable terminal contract', () => {
  const stdout = runCommand('sample-scenario.js');
  assertSampleSummary(stdout);
  assert.ok(stdout.endsWith('Sample scenario checks passed.\n'), 'sample must end with the exact success sentence');
});

test('report readability command prints success and separate indented counts', () => {
  assertReadabilitySummary(runCommand('report-readability.js'));
});

test('both commands repeat byte-for-byte across time zones and locales', () => {
  for (const name of ['sample-scenario.js', 'report-readability.js']) {
    const expected = runCommand(name);
    assert.equal(runCommand(name), expected, `${name} must be deterministic on repetition`);
    for (const environment of ENVIRONMENTS.slice(1)) {
      assert.equal(runCommand(name, environment), expected,
        `${name} changed under TZ=${environment.TZ}, LC_ALL=${environment.LC_ALL}`);
    }
  }
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('pure sample formatter accepts frozen inputs without mutation and repeats deterministically', async () => {
  const { formatSampleSummary } = await import(FORMATTER_URL.href);
  assert.equal(typeof formatSampleSummary, 'function');
  const input = structuredClone(scenario);
  const options = { inventoryScale: 1, roadCapacityScale: 1, equityFloor: 0.4 };
  const baseline = allocate(input, options);
  const report = buildReport(input, baseline, options);
  const expanded = allocate(input, { ...options, roadCapacityScale: 1.5 });
  const noInventory = allocate(input, { ...options, inventoryScale: 0 });
  const hilltop = allocate(input, { ...options, closedRoadIds: ['hill-access'] })
    .shelters.find((shelter) => shelter.id === 'hilltop');
  const args = [input, baseline, report, { expanded, noInventory, hilltop }];
  const original = structuredClone(args);
  args.forEach(deepFreeze);

  const stdout = formatSampleSummary(...args);
  assertSampleSummary(stdout);
  assert.equal(formatSampleSummary(...args), stdout, 'formatter must repeat deterministically');
  assert.equal(formatSampleSummary(...structuredClone(original)), stdout, 'output must depend on values rather than identity');
  assert.deepEqual(args, original, 'formatter must preserve every input');
});
