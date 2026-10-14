import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataset } from '../src/fixtures.js';
import { buildScorecard } from '../src/evaluation.js';
import {
  DETERMINISTIC_EVIDENCE_FILES,
  OPTIONAL_BUNDLE_FILES,
  REQUIRED_ARTIFACT_FILES,
  SOURCE_FILES,
  buildEvidenceFiles,
} from '../src/bundle.js';

const REQUIRED_BUNDLE_FILES = Object.freeze([
  ...DETERMINISTIC_EVIDENCE_FILES,
  ...REQUIRED_ARTIFACT_FILES,
  'checks.json',
  ...SOURCE_FILES.map((file) => `source/${file}`),
]);

function directoryPath(directory) {
  return directory instanceof URL ? fileURLToPath(directory) : resolve(String(directory));
}

function isSafeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !isAbsolute(value)
    && !posix.isAbsolute(value)
    && !value.includes('\\')
    && !value.includes('\0')
    && posix.normalize(value) === value
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function assertRegularFile(path, label) {
  const info = await lstat(path);
  assert.equal(info.isSymbolicLink(), false, `${label} must not be a symbolic link.`);
  assert.equal(info.isFile(), true, `${label} must be a regular file.`);
  return info;
}

async function listFiles(directory, allowed, prefix = '') {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, child);
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `${child} must not be a symbolic link.`);
    if (info.isDirectory()) {
      assert.ok([...allowed].some((file) => file.startsWith(`${child}/`)), `Unlisted directory: ${child}`);
      files.push(...await listFiles(directory, allowed, child));
    } else if (info.isFile()) files.push(child);
    else throw new Error(`${child} is not a regular file or directory.`);
  }
  return files.sort();
}

async function readJson(path, label) {
  await assertRegularFile(path, label);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function verifyManifest(directory) {
  const manifestPath = join(directory, 'manifest.json');
  const manifest = await readJson(manifestPath, 'manifest.json');
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Manifest must be an object.');
  assert.equal(manifest.schemaVersion, 1, 'Manifest schemaVersion must be 1.');
  assert.equal(manifest.complete, true, 'Evidence manifest is not complete.');
  assert.deepEqual(Object.keys(manifest).sort(), ['complete', 'files', 'schemaVersion'].sort(), 'Manifest has unexpected fields.');
  assert.ok(Array.isArray(manifest.files), 'Manifest files must be an array.');

  const allowed = new Set([...REQUIRED_BUNDLE_FILES, ...OPTIONAL_BUNDLE_FILES]);
  const required = new Set(REQUIRED_BUNDLE_FILES);
  for (const entry of manifest.files) {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'Manifest entries must be objects.');
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'path', 'sha256'], 'Manifest entry has unexpected fields.');
    assert.ok(isSafeRelativePath(entry.path), `Unsafe manifest path: ${entry.path}`);
    assert.notEqual(entry.path, 'manifest.json', 'manifest.json must not hash itself.');
    assert.ok(allowed.has(entry.path), `Unallowlisted manifest path: ${entry.path}`);
    assert.match(entry.sha256 ?? '', /^[0-9a-f]{64}$/u, `Invalid sha256 for ${entry.path}.`);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, `Invalid byte count for ${entry.path}.`);
  }
  const paths = manifest.files.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, 'Manifest contains duplicate paths.');
  assert.deepEqual(paths, [...paths].sort(), 'Manifest paths must be sorted.');
  for (const path of required) assert.ok(paths.includes(path), `Manifest is missing required file: ${path}`);

  const actualFiles = await listFiles(directory, new Set([...paths, 'manifest.json']));
  const actualWithoutManifest = actualFiles.filter((path) => path !== 'manifest.json');
  assert.deepEqual(new Set(actualWithoutManifest), new Set(paths), 'Bundle contains an unlisted file or has a missing listed file.');
  assert.equal(actualWithoutManifest.length, paths.length, 'Bundle file count does not match manifest.');

  for (const entry of manifest.files) {
    const path = join(directory, ...entry.path.split('/'));
    await assertRegularFile(path, entry.path);
    const content = await readFile(path);
    assert.equal(content.byteLength, entry.bytes, `Byte count mismatch for ${entry.path}.`);
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256, `SHA-256 mismatch for ${entry.path}.`);
  }
  return manifest;
}

function verifyChecks(checks, manifest) {
  assert.equal(checks?.schemaVersion, 1, 'checks.json schemaVersion must be 1.');
  assert.equal(checks?.status, 'passed', 'Recorded checks are not all passed.');
  assert.ok(Array.isArray(checks.commands), 'checks.json must list commands.');
  const expectedCommands = [
    ['scorecard', ['run', 'scorecard']],
    ['scorecard byte check', ['run', 'scorecard', '--', '--check']],
    ['unit tests', ['test']],
    ['syntax checks', ['run', 'check']],
    ['browser checks', ['run', 'test:browser']],
  ];
  assert.equal(checks.commands.length, expectedCommands.length, 'Recorded command list is incomplete.');
  for (const [index, command] of checks.commands.entries()) {
    const [name, args] = expectedCommands[index];
    assert.equal(command.name, name, 'Recorded command order differs from the required checks.');
    assert.ok(['npm', 'npm.cmd'].includes(command.argv?.[0]), `Invalid executable for ${name}.`);
    assert.deepEqual(command.argv.slice(1), args, `Invalid arguments for ${name}.`);
    assert.equal(command.command, command.argv.join(' '), `Command display differs from argv for ${name}.`);
    assert.equal(command.status, 'passed', `Recorded command failed: ${command.name}.`);
    assert.equal(command.exitCode, 0, `Recorded command did not exit 0: ${command.name}.`);
  }
  assert.equal(checks.deterministicCore?.status, 'passed', 'Deterministic core reproduction was not passed.');
  assert.equal(checks.deterministicCore?.name, 'deterministic core reproduction', 'Deterministic core check name is missing.');
  assert.equal(checks.deterministicCore?.byteForByte, true, 'Deterministic core was not checked byte-for-byte.');
  for (const key of ['tests', 'passed', 'failed', 'skipped']) {
    assert.ok(Number.isSafeInteger(checks.unit?.[key]) && checks.unit[key] >= 0, `Invalid TAP ${key} count.`);
  }
  assert.equal(checks.unit.failed, 0, 'Recorded TAP failures are nonzero.');
  assert.ok(checks.unit.tests >= checks.unit.passed + checks.unit.failed + checks.unit.skipped, 'Recorded TAP counts are inconsistent.');
  assert.ok(Array.isArray(checks.unit.passedNames), 'Unit passed names are missing.');
  assert.ok(checks.unit.passedNames.every((name) => typeof name === 'string' && name.length > 0), 'Unit passed names must be strings.');
  assert.ok(Number.isSafeInteger(checks.browser?.checks) && checks.browser.checks > 0, 'Browser check count is missing.');
  assert.equal(checks.browser.trailingCount, checks.browser.checks, 'Browser trailing count is inconsistent.');
  assert.ok(Array.isArray(checks.browser.passedNames), 'Browser passed names are missing.');
  assert.ok(checks.browser.passedNames.every((name) => typeof name === 'string' && name.length > 0), 'Browser passed names must be strings.');
  assert.equal(checks.browser.passedNames?.length, checks.browser.checks, 'Browser PASS names disagree with the count.');
  assert.equal(typeof checks.environment?.node, 'string', 'Node version is missing from checks.json.');
  assert.equal(typeof checks.environment?.platform, 'string', 'Platform is missing from checks.json.');
  assert.equal(typeof checks.environment?.playwright, 'string', 'Playwright version is missing from checks.json.');
  assert.equal(checks.sourceStability?.status, 'passed', 'Source stability was not checked.');
  const sourceHashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, manifest.files.find((entry) => entry.path === `source/${file}`).sha256]));
  assert.deepEqual(checks.sourceStability.sha256, sourceHashes, 'Recorded source hashes differ from the copied source.');
}

/**
 * Verify a completed bundle without importing any code from the bundle's
 * untrusted file list. The modules imported above are the verifier's own
 * local modules; source snapshots are treated as bytes and are never run.
 */
export async function verifyEvidence(directory) {
  const root = directoryPath(directory);
  const rootInfo = await lstat(root);
  assert.equal(rootInfo.isSymbolicLink(), false, 'Evidence directory must not be a symbolic link.');
  assert.equal(rootInfo.isDirectory(), true, 'Evidence path must be a directory.');
  const manifest = await verifyManifest(root);

  // A verifier invoked outside the bundle uses its own trusted modules. Do not
  // silently accept different reproduction code merely because it was rehashed.
  for (const source of ['src/evaluation.js', 'src/fixtures.js', 'src/workspace.js', 'src/bundle.js', 'scripts/verify-evidence.js']) {
    const trusted = await readFile(new URL(`../${source}`, import.meta.url));
    const copied = await readFile(join(root, 'source', ...source.split('/')));
    assert.equal(copied.equals(trusted), true, `Source snapshot differs from the verifier's local code: ${source}`);
  }

  const scorecardPath = join(root, 'scorecard.json');
  const scorecardBytes = await readFile(scorecardPath);
  let scorecard;
  try {
    scorecard = JSON.parse(scorecardBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`scorecard.json is not valid JSON: ${error.message}`);
  }
  assert.equal(scorecard.schemaVersion, 2, 'scorecard.json must be schema v2.');
  assert.deepEqual(scorecard.snapshot, dataset, 'scorecard snapshot does not match the fixed local fixture.');
  const recomputed = buildScorecard(scorecard.snapshot, scorecard.baselineId, scorecard.candidateId);
  assert.equal(scorecardBytes.equals(Buffer.from(`${JSON.stringify(recomputed, null, 2)}\n`, 'utf8')), true, 'scorecard.json does not reproduce byte-for-byte.');

  const generated = buildEvidenceFiles(recomputed);
  for (const [name, expected] of Object.entries(generated)) {
    const content = await readFile(join(root, name));
    assert.equal(content.equals(Buffer.from(expected, 'utf8')), true, `${name} does not reproduce byte-for-byte.`);
  }
  assert.equal((await readFile(join(root, 'source', 'scorecard.json'))).equals(scorecardBytes), true, 'Copied source scorecard is inconsistent.');
  verifyChecks(await readJson(join(root, 'checks.json'), 'checks.json'), manifest);
  return {
    verified: true,
    fileCount: manifest.files.length,
    datasetId: scorecard.datasetId,
    baselineId: scorecard.baselineId,
    candidateId: scorecard.candidateId,
    candidateScore: scorecard.summaries.candidate.score,
  };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const localRoot = dirname(dirname(thisFile));
  const defaultDirectory = basename(localRoot) === 'source' ? dirname(localRoot) : join(localRoot, 'evidence');
  const target = process.argv[2] || defaultDirectory;
  verifyEvidence(target)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(`Evidence verification failed: ${error.message}`);
      process.exitCode = 1;
    });
}
