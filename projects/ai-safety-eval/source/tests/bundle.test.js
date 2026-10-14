import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataset } from '../src/fixtures.js';
import { buildScorecard } from '../src/evaluation.js';
import {
  DETERMINISTIC_EVIDENCE_FILES,
  SOURCE_FILES,
  buildEvidenceFiles,
  createManifest,
  sha256,
} from '../src/bundle.js';
import { verifyEvidence } from '../scripts/verify-evidence.js';

const report = buildScorecard(dataset, 'run-1-2', 'run-1-3');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function writeManifest(directory, files) {
  await writeFile(join(directory, 'manifest.json'), json(createManifest(files)));
}

async function makeTempBundle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'guardrail-evidence-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    ...buildEvidenceFiles(report),
    'source/scorecard.json': json(report),
    // Synthetic bytes for integrity testing, not browser evidence claims.
    'screenshots/matrix-desktop.png': Buffer.from('synthetic desktop artifact'),
    'screenshots/matrix-mobile.png': Buffer.from('synthetic mobile artifact'),
  };
  for (const source of SOURCE_FILES) files[`source/${source}`] = await readFile(new URL(`../${source}`, import.meta.url));
  const commands = [
    ['scorecard', ['run', 'scorecard']],
    ['scorecard byte check', ['run', 'scorecard', '--', '--check']],
    ['unit tests', ['test']],
    ['syntax checks', ['run', 'check']],
    ['browser checks', ['run', 'test:browser']],
  ].map(([name, args]) => ({ name, command: ['npm', ...args].join(' '), argv: ['npm', ...args], status: 'passed', exitCode: 0 }));
  const checks = {
    schemaVersion: 1,
    status: 'passed',
    commands,
    deterministicCore: { name: 'deterministic core reproduction', status: 'passed', byteForByte: true },
    environment: { node: process.version, platform: process.platform, playwright: 'synthetic-test-record' },
    unit: { tests: 1, passed: 1, failed: 0, skipped: 0, passedNames: ['synthetic unit record'] },
    browser: { checks: 1, trailingCount: 1, passedNames: ['synthetic browser record'], scope: 'synthetic test' },
    sourceStability: { status: 'passed', sha256: Object.fromEntries(SOURCE_FILES.map((source) => [source, sha256(files[`source/${source}`])])) },
  };
  files['checks.json'] = json(checks);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(directory, ...relative.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await writeManifest(directory, files);
  return { directory, files, checks };
}

test('pure core generation is deterministic and preserves a JSON-round-tripped report', () => {
  const before = structuredClone(report);
  const first = buildEvidenceFiles(report);
  assert.deepEqual(first, buildEvidenceFiles(report));
  assert.deepEqual(first, buildEvidenceFiles(JSON.parse(JSON.stringify(report))));
  assert.deepEqual(report, before);
  assert.deepEqual(Object.keys(first), DETERMINISTIC_EVIDENCE_FILES);
  assert.deepEqual(JSON.parse(first['scorecard.json']), report);
  assert.throws(() => buildEvidenceFiles({ ...report, schemaVersion: 1 }), /schema v2/);
});

test('case evidence retains both records, annotations, exact quotes, provenance, and transition accounting', () => {
  const evidence = JSON.parse(buildEvidenceFiles(report)['case-evidence.json']);
  assert.equal(evidence.cases.length, 24);
  assert.deepEqual(evidence.context.runs.map((run) => run.id), ['run-1-2', 'run-1-3']);
  for (const item of evidence.cases) {
    const row = report.comparisons.find((comparison) => comparison.prompt.id === item.prompt.id);
    assert.deepEqual(item.prompt, row.prompt);
    assert.deepEqual(item.prompt.provenance, row.prompt.provenance);
    for (const side of ['baseline', 'candidate']) {
      assert.deepEqual(item[side].record, row[side].record);
      assert.deepEqual(item[side].evaluation, row[side]);
      assert.deepEqual(item[side].explanation, report.explanations.find((explanation) => explanation.promptId === item.prompt.id)[side]);
    }
  }
  const rejected = evidence.cases.find((item) => item.prompt.id === 'fairness-02');
  assert.equal(rejected.candidate.record.annotation.reviewer, 'Synthetic fixture reviewer');
  assert.equal(rejected.candidate.explanation.properties[0].evidence[0].quote, rejected.candidate.record.response);
  assert.deepEqual(rejected.transition, {
    change: 'regression', transition: 'pass → abstention-rejected', accountingChanged: true,
    earnedWeightDelta: -3, contributionDelta: { pass: -3, abstention: 0 },
  });
});

test('accounting, summary, and CSV explain disjoint counts, weights, contributions, and fixture reviews', () => {
  const files = buildEvidenceFiles(report);
  assert.deepEqual(JSON.parse(files['accounting.json']), {
    scoring: report.scoring, baselineId: report.baselineId, candidateId: report.candidateId,
    summaries: report.summaries, comparisonSummary: report.comparisonSummary,
  });
  const candidate = report.summaries.candidate;
  assert.equal(candidate.passed + candidate.failed + candidate.abstentions + candidate.missing, 24);
  assert.equal(candidate.acceptedAbstentions + candidate.rejectedAbstentions, 3);
  assert.equal(candidate.weightedPassed + candidate.weightedAbstentions, 50);
  assert.match(files['summary.md'], /18 ordinary passes \+ 3 ordinary failures \+ 3 abstentions \(2 accepted, 1 rejected\) \+ 0 missing = 24 total/);
  assert.match(files['summary.md'], /22\/24 annotated responses/);
  assert.match(files['summary.md'], /fixture reviews, not live measurements/);
  assert.match(files['summary.md'], /critical = 5, high = 3, medium = 2, low = 1/);
  assert.match(files['summary.md'], /43 ordinary-pass weight \+ 7 accepted-abstention weight = 50\/61/);
  assert.match(files['summary.md'], /70\.4918.*11\.4754/);
  assert.match(files['summary.md'], /abstention-accepted → failure/);
  assert.match(files['summary.md'], /not claimed to be bit-identical across machines/);
  const csv = files['cases.csv'];
  assert.equal(csv.trimEnd().split('\r\n').length, 25);
  assert.match(csv, /"transition","accounting_changed","earned_weight_delta"/);
  assert.match(csv, /"earned_weight","weighted_total","contribution_points"/);
  assert.match(csv, /"abstention","abstention","true","abstention","accepted","abstain","true","2","61","3\.2787"/);
  assert.match(csv, /"pass → abstention-rejected"/);
});

test('manifest sorting and SHA-256 hashes are stable and byte counts use UTF-8', () => {
  const first = createManifest({ 'z.txt': 'z', 'a.txt': 'é→' });
  const second = createManifest({ 'a.txt': 'é→', 'z.txt': 'z' });
  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map((file) => file.path), ['a.txt', 'z.txt']);
  assert.equal(first.files[0].bytes, 5);
  assert.equal(first.files[0].sha256, sha256(Buffer.from('é→', 'utf8')));
  assert.equal(createManifest({ 'manifest.json': 'excluded', 'z.txt': 'z' }).files.length, 1);
  for (const path of ['../outside.txt', '/absolute', 'source/../escape', 'source\\escape', 'x\0y', 'C:/escape']) {
    assert.throws(() => createManifest({ [path]: 'nope' }), /safe relative/);
  }
});

test('an overlapping evidence retry cannot overwrite another run lock or its published manifest', async (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await mkdtemp(join(root, 'bundle-lock-test-'));
  const lock = `${directory}.evidence-lock`;
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await unlink(lock); });
  await writeFile(lock, 'Synthetic lock fixture: active local run\n');
  await writeFile(join(directory, 'manifest.json'), 'Previous manifest must be preserved.\n');
  const result = spawnSync(process.execPath, ['scripts/evidence-bundle.js', basename(directory)], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Another evidence run owns the output lock/);
  assert.equal(await readFile(lock, 'utf8'), 'Synthetic lock fixture: active local run\n');
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), 'Previous manifest must be preserved.\n');
});

test('a complete temporary bundle verifies and reproduces from an unrelated working directory', async (t) => {
  const { directory, files } = await makeTempBundle(t);
  const verified = await verifyEvidence(directory);
  assert.equal(verified.verified, true);
  assert.equal(verified.fileCount, Object.keys(files).length);
  assert.equal(verified.candidateScore, 81.97);
  const result = spawnSync(process.execPath, [join(directory, 'reproduce.mjs')], { cwd: tmpdir(), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reproduced, true);
});

test('integrity verification detects byte-length and same-length hash mismatches', async (t) => {
  const { directory, files } = await makeTempBundle(t);
  const path = join(directory, 'summary.md');
  await writeFile(path, `${files['summary.md']}extra`);
  await assert.rejects(() => verifyEvidence(directory), /Byte count mismatch for summary.md/);
  await writeFile(path, files['summary.md'].replace('Guardrail', 'GUARDRAIL'));
  await assert.rejects(() => verifyEvidence(directory), /SHA-256 mismatch for summary.md/);
});

test('manifest tampering rejects hash edits, missing files, duplicates, unsorted paths, and incomplete state', async (t) => {
  const { directory, files } = await makeTempBundle(t);
  const original = createManifest(files);
  const mutations = [
    [(manifest) => { manifest.files[0].sha256 = '0'.repeat(64); }, /SHA-256 mismatch/],
    [(manifest) => { manifest.files = manifest.files.filter((entry) => entry.path !== 'cases.csv'); }, /missing required file/],
    [(manifest) => { manifest.files.push(manifest.files[0]); }, /duplicate paths/],
    [(manifest) => { manifest.files.reverse(); }, /must be sorted/],
    [(manifest) => { manifest.complete = false; }, /not complete/],
  ];
  for (const [mutate, expected] of mutations) {
    const manifest = structuredClone(original);
    mutate(manifest);
    await writeFile(join(directory, 'manifest.json'), json(manifest));
    await assert.rejects(() => verifyEvidence(directory), expected);
  }
});

test('verifier rejects unsafe or unallowlisted manifest paths before reading them', async (t) => {
  const { directory, files } = await makeTempBundle(t);
  const original = createManifest(files);
  for (const path of ['../escape', '/tmp/escape', 'source/../escape', 'source\\escape', './scorecard.json', '', 'private/log.txt', 'manifest.json']) {
    const manifest = structuredClone(original);
    manifest.files[0].path = path;
    await writeFile(join(directory, 'manifest.json'), json(manifest));
    await assert.rejects(() => verifyEvidence(directory), /Unsafe manifest path|Unallowlisted manifest path|must not hash itself/);
  }
});

test('unlisted files and symbolic links are rejected', async (t) => {
  const { directory } = await makeTempBundle(t);
  const extra = join(directory, 'private.log');
  await writeFile(extra, 'unlisted test data');
  await assert.rejects(() => verifyEvidence(directory), /unlisted file/);
  await unlink(extra);
  const screenshot = join(directory, 'screenshots', 'matrix-mobile.png');
  await unlink(screenshot);
  await symlink('../scorecard.json', screenshot);
  await assert.rejects(() => verifyEvidence(directory), /symbolic link/);
  await unlink(screenshot);
  await rename(join(directory, 'source'), join(directory, 'source-original'));
  await symlink('source-original', join(directory, 'source'));
  await assert.rejects(() => verifyEvidence(directory), /symbolic link/);
  await unlink(join(directory, 'source'));
  await rename(join(directory, 'source-original'), join(directory, 'source'));
  const manifest = join(directory, 'manifest.json');
  await rename(manifest, join(directory, 'manifest-original.json'));
  await symlink('manifest-original.json', manifest);
  await assert.rejects(() => verifyEvidence(directory), /symbolic link/);
});

test('rehashing altered deterministic files does not bypass core reproduction', async (t) => {
  const { directory, files } = await makeTempBundle(t);
  files['accounting.json'] = files['accounting.json'].replace('81.97', '99.99');
  await writeFile(join(directory, 'accounting.json'), files['accounting.json']);
  await writeManifest(directory, files);
  await assert.rejects(() => verifyEvidence(directory), /accounting.json does not reproduce byte-for-byte/);
});

test('a self-consistent report from changed fixtures is rejected', async (t) => {
  const { directory, files } = await makeTempBundle(t);
  const changed = structuredClone(dataset);
  changed.records[0].annotation.note = 'Different, valid synthetic fixture review.';
  const generated = buildEvidenceFiles(buildScorecard(changed, 'run-1-2', 'run-1-3'));
  Object.assign(files, generated);
  files['source/scorecard.json'] = generated['scorecard.json'];
  for (const [name, content] of Object.entries(generated)) await writeFile(join(directory, name), content);
  await writeFile(join(directory, 'source', 'scorecard.json'), generated['scorecard.json']);
  await writeManifest(directory, files);
  await assert.rejects(() => verifyEvidence(directory), /snapshot does not match the fixed local fixture/);
});

test('verifier treats copied code as bytes and rejects changed reproduction source without running it', async (t) => {
  const { directory, files } = await makeTempBundle(t);
  const sentinel = join(directory, 'executed-untrusted-code');
  files['source/src/evaluation.js'] = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'bad');\n`;
  await writeFile(join(directory, 'source', 'src', 'evaluation.js'), files['source/src/evaluation.js']);
  await writeManifest(directory, files);
  await assert.rejects(() => verifyEvidence(directory), /Source snapshot differs.*src\/evaluation.js/);
  await assert.rejects(() => lstat(sentinel), { code: 'ENOENT' });
});

test('rehashing run evidence cannot hide a failed recorded command or inconsistent parsed counts', async (t) => {
  const { directory, files, checks } = await makeTempBundle(t);
  checks.commands[2].exitCode = 1;
  files['checks.json'] = json(checks);
  await writeFile(join(directory, 'checks.json'), files['checks.json']);
  await writeManifest(directory, files);
  await assert.rejects(() => verifyEvidence(directory), /did not exit 0/);
  checks.commands[2].exitCode = 0;
  checks.browser.trailingCount = 2;
  files['checks.json'] = json(checks);
  await writeFile(join(directory, 'checks.json'), files['checks.json']);
  await writeManifest(directory, files);
  await assert.rejects(() => verifyEvidence(directory), /Browser trailing count is inconsistent/);
});
