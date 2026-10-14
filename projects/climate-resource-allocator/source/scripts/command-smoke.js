#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HEADINGS = [
  'Climate Resource Allocator - sample scenario',
  'Baseline summary',
  'Shelter coverage',
  'Resources (demand / allocated / unmet)',
  'Constraints and equity',
  'What-if scenarios',
];

function runCommand(name) {
  const scriptPath = fileURLToPath(new URL(name, import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `terminated by ${result.signal}`);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr.trim()}`);
  assert.equal(result.stderr, '', 'unexpected stderr');
  assert.doesNotMatch(result.stdout, /[\u001b\u009b]|\b(?:undefined|NaN|Infinity)\b/u, 'invalid terminal output');
  for (const line of result.stdout.split('\n')) {
    assert.doesNotMatch(line, /\s$/u, 'trailing whitespace');
  }
  return result.stdout;
}

function checkSample(stdout) {
  assert.ok(stdout.endsWith('Sample scenario checks passed.\n'), 'missing sample success sentence');
  assert.doesNotMatch(stdout, /\r|\n{3}/, 'invalid section spacing or line endings');
  const lines = stdout.split('\n');
  let previous = -1;
  const positions = HEADINGS.map((heading, index) => {
    const position = lines.indexOf(heading);
    assert.ok(position > previous, `missing or out-of-order heading: ${heading}`);
    assert.equal(lines.lastIndexOf(heading), position, `duplicate heading: ${heading}`);
    if (index === 0) assert.equal(position, 0, 'sample title must be first');
    else assert.equal(lines[position - 1], '', `missing blank before ${heading}`);
    previous = position;
    return position;
  });
  for (const line of lines) assert.ok([...line].length <= 80, 'sample line exceeds 80 characters');
  assert.match(stdout, /Synthetic[^\n]*snapshot[^\n]*UTC/i, 'missing explicit synthetic UTC snapshot');
  assert.ok(stdout.includes('Synthetic planning only; not an emergency dispatch system.'), 'missing planning disclaimer');
  const baseline = lines.slice(positions[1] + 1, positions[2]).join('\n');
  for (const [label, value] of [
    ['demand', '4,682'], ['allocated', '3,747'], ['unmet', '935'],
    ['expired', '335'], ['available|usable', '4,880'],
  ]) {
    assert.match(baseline, new RegExp(`^[ \\t]*[^:\\n]*\\b(?:${label})\\b[^:\\n]*:[ \\t]*${value}\\b`, 'im'),
      `missing baseline ${label}: ${value}`);
  }
  const whatIf = lines.slice(positions[5] + 1).join('\n');
  for (const quantity of [/\b4,272\b/, /\+525\b/, /\b410\b/]) {
    assert.match(whatIf, quantity, 'missing expected what-if quantity');
  }
}

function checkReadability(stdout) {
  assert.match(stdout, /^Report markup readability check passed\.\n/, 'missing readability success sentence');
  const lines = stdout.split('\n');
  assert.equal(lines.length, 5, 'expected success, three count lines, and a final newline');
  assert.equal(lines[4], '', 'missing final newline');
  for (const [index, [label, value]] of [
    ['sections?', '5'], ['tables?', '6'], ['priority badges?', '18'],
  ].entries()) {
    assert.match(lines[index + 1], new RegExp(`^[ \\t]+${label}:[ \\t]*${value}$`, 'i'),
      `missing ${label} count ${value}`);
  }
}

for (const [name, check] of [
  ['sample-scenario.js', checkSample],
  ['report-readability.js', checkReadability],
]) {
  try {
    check(runCommand(name));
    console.log(`${name} passed.`);
  } catch (error) {
    const message = String(error.message).split('\n')[0];
    console.error(`${name} failed: ${message}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log('Command smoke verification passed.');
