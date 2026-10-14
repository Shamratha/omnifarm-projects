import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataset } from '../src/fixtures.js';
import { buildScorecard } from '../src/evaluation.js';
import {
  OPTIONAL_BUNDLE_FILES,
  SOURCE_FILES,
  buildEvidenceFiles,
  createManifest,
} from '../src/bundle.js';
import { verifyEvidence } from './verify-evidence.js';

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const outputArgument = process.argv[2] || 'evidence';
const output = resolve(projectRoot, outputArgument);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let outputInitialized = false;
let checks;
let runLock;
const lockPath = `${output}.evidence-lock`;

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function ensureOutput() {
  const path = relative(projectRoot, output);
  const parts = path.split(sep);
  const reserved = new Set(['src', 'scripts', 'tests', 'test-results', 'node_modules']);
  if (!path || isAbsolute(path) || parts.some((part) => !/^[\w-]+$/u.test(part)) || reserved.has(parts[0])) {
    throw new Error('Evidence output must be a separate non-source directory within the project.');
  }
  await safeParent(projectRoot, `${parts.join('/')}.evidence-lock`);
  try {
    runLock = await open(lockPath, 'wx');
    await runLock.writeFile(`Local evidence generation owned by PID ${process.pid}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another evidence run owns the output lock. Wait for it rather than overwrite its manifest.');
    throw error;
  }
  await safeParent(projectRoot, `${parts.join('/')}/manifest.json`);
  await writeBundleFile('manifest.json', json({ schemaVersion: 1, complete: false, status: 'running', files: [] }));
  outputInitialized = true;
}

async function safeParent(directory, relativePath) {
  const parts = relativePath.split('/');
  parts.pop();
  let current = directory;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      assert.equal(info.isSymbolicLink(), false, `${relativePath} has a symbolic-link parent.`);
      assert.equal(info.isDirectory(), true, `${current} must be a directory.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
}

async function writeBundleFile(relativePath, content) {
  await safeParent(output, relativePath);
  const path = join(output, ...relativePath.split('/'));
  try {
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `${relativePath} must not be a symbolic link.`);
    assert.equal(info.isFile(), true, `${relativePath} must be a regular file.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(path, content);
}

async function hashProjectSources() {
  const snapshot = {};
  for (const file of SOURCE_FILES) {
    for (const parent of file.split('/').slice(0, -1)) {
      const info = await lstat(join(projectRoot, parent));
      assert.equal(info.isSymbolicLink(), false, `${file} has a symbolic-link parent.`);
      assert.equal(info.isDirectory(), true, `${parent} must be a directory.`);
    }
    const path = join(projectRoot, ...file.split('/'));
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `${file} must not be a symbolic link.`);
    assert.equal(info.isFile(), true, `${file} must be a regular file.`);
    const content = await readFile(path);
    snapshot[file] = { content, sha256: hash(content) };
  }
  return snapshot;
}

function sourceHashes(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([file, item]) => [file, item.sha256]));
}

async function playwrightVersion() {
  const packagePath = join(projectRoot, 'node_modules', 'playwright', 'package.json');
  const packageInfo = JSON.parse(await readFile(packagePath, 'utf8'));
  return packageInfo.version;
}

async function environment() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    playwright: await playwrightVersion(),
  };
}

function tapSummary(outputText) {
  const value = (label) => {
    const matches = [...outputText.matchAll(new RegExp(`^# ${label}\\s+(\\d+)\\s*$`, 'gmu'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  const tests = value('tests');
  const passed = value('pass');
  const failed = value('fail');
  const skipped = value('skipped');
  if ([tests, passed, failed, skipped].some((item) => item === null)) throw new Error('Unit output did not contain complete TAP counts.');
  const passedNames = [...outputText.matchAll(/^\s*ok \d+ - (.+)$/gmu)]
    .map((match) => match[1].trim())
    .filter((name) => !/ # (?:SKIP|TODO)\b/iu.test(name));
  if (!passedNames.length && passed > 0) throw new Error('Unit TAP output did not contain passed test names.');
  return { tests, passed, failed, skipped, passedNames };
}

function browserSummary(outputText) {
  const passedNames = [...outputText.matchAll(/^PASS (.+)$/gmu)].map((match) => match[1].trim());
  const trailing = [...outputText.matchAll(/^(\d+) browser checks passed \(([^)]+)\)\.$/gmu)].at(-1);
  if (!passedNames.length || !trailing) throw new Error('Browser output did not contain PASS lines and a trailing browser count.');
  const checks = Number(trailing[1]);
  assert.equal(passedNames.length, checks, 'Browser PASS line count disagrees with the trailing count.');
  return { checks, passedNames, trailingCount: checks, scope: trailing[2] };
}

async function runCommand(name, args) {
  const command = `${npmCommand} ${args.join(' ')}`;
  const startedAt = new Date().toISOString();
  const child = spawn(npmCommand, args, { cwd: projectRoot, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const [exitCode, signal] = await once(child, 'close');
  if (spawnError) throw spawnError;
  return {
    name,
    startedAt,
    completedAt: new Date().toISOString(),
    command,
    argv: [npmCommand, ...args],
    exitCode,
    signal: signal || null,
    status: exitCode === 0 ? 'passed' : 'failed',
    stdout,
    stderr,
  };
}

async function writeChecks(checks) {
  await writeBundleFile('checks.json', json(checks));
}

async function runChecks(checks) {
  const commands = [
    ['scorecard', ['run', 'scorecard']],
    ['scorecard byte check', ['run', 'scorecard', '--', '--check']],
    ['unit tests', ['test']],
    ['syntax checks', ['run', 'check']],
    ['browser checks', ['run', 'test:browser']],
  ];
  for (const [name, args] of commands) {
    const result = await runCommand(name, args);
    const recorded = { ...result };
    delete recorded.stdout;
    delete recorded.stderr;
    checks.commands.push(recorded);
    await writeChecks(checks);
    try {
      if (name === 'unit tests') checks.unit = tapSummary(result.stdout);
      if (name === 'browser checks') checks.browser = browserSummary(result.stdout);
    } catch (error) {
      recorded.summaryError = error.message;
      await writeChecks(checks);
      if (result.exitCode !== 0) throw new Error(`${result.command} failed with exit code ${result.exitCode}; ${error.message}`);
      throw error;
    }
    await writeChecks(checks);
    if (result.exitCode !== 0) throw new Error(`${result.command} failed with exit code ${result.exitCode}.`);
    if (name === 'unit tests' && checks.unit.failed !== 0) throw new Error('Unit TAP output reports failures despite exit code 0.');
  }
  return checks;
}

async function copyScreenshots() {
  const screenshots = {};
  for (const [sourceName, outputName, required] of [
    ['matrix-desktop.png', 'screenshots/matrix-desktop.png', true],
    ['matrix-mobile.png', 'screenshots/matrix-mobile.png', true],
    ['evidence-detail.png', 'screenshots/evidence-detail.png', false],
  ]) {
    const sourcePath = join(projectRoot, 'test-results', sourceName);
    try {
      const info = await lstat(sourcePath);
      assert.equal(info.isSymbolicLink(), false, `${sourceName} must not be a symbolic link.`);
      assert.equal(info.isFile(), true, `${sourceName} must be a regular file.`);
      screenshots[outputName] = await readFile(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT' && !required) continue;
      throw new Error(`Cannot copy browser screenshot ${sourceName}: ${error.message}`);
    }
  }
  return screenshots;
}

async function invalidate(errorMessage) {
  if (!outputInitialized) return;
  try {
    if (checks) {
      checks.status = 'failed';
      checks.error = errorMessage;
      checks.completedAt = new Date().toISOString();
      await writeChecks(checks);
    }
  } catch { /* The manifest is invalidated independently below. */ }
  try {
    await writeBundleFile('manifest.json', json({ schemaVersion: 1, complete: false, status: 'failed', error: errorMessage, files: [] }));
  } catch {
    // Preserve the original failure if the output path itself became unusable.
  }
}

try {
  await ensureOutput();
  checks = {
    schemaVersion: 1,
    status: 'running',
    commands: [],
    deterministicCore: { name: 'deterministic core reproduction', status: 'pending' },
    environment: await environment(),
    startedAt: new Date().toISOString(),
  };
  await writeChecks(checks);
  const beforeSources = await hashProjectSources();
  await runChecks(checks);
  const afterSources = await hashProjectSources();
  assert.deepEqual(sourceHashes(afterSources), sourceHashes(beforeSources), 'Project source files changed while checks were running.');

  const report = buildScorecard(dataset, 'run-1-2', 'run-1-3');
  const generated = buildEvidenceFiles(report);
  const secondGenerated = buildEvidenceFiles(buildScorecard(dataset, 'run-1-2', 'run-1-3'));
  assert.deepEqual(generated, secondGenerated, 'Deterministic evidence core changed between reproductions.');
  assert.equal(await readFile(join(projectRoot, 'scorecard.json'), 'utf8'), generated['scorecard.json'], 'The checked root scorecard differs from the evidence scorecard.');
  checks.deterministicCore = { name: 'deterministic core reproduction', status: 'passed', byteForByte: true };
  console.log('PASS deterministic core reproduction');
  checks.sourceStability = { status: 'passed', sha256: sourceHashes(afterSources) };
  checks.passedNames = [...checks.commands.map((item) => item.name), ...checks.unit.passedNames, ...checks.browser.passedNames, checks.deterministicCore.name];
  checks.status = 'passed';
  checks.completedAt = new Date().toISOString();
  await writeChecks(checks);

  const files = { ...generated, 'checks.json': json(checks), 'source/scorecard.json': generated['scorecard.json'] };
  for (const [file, item] of Object.entries(afterSources)) files[`source/${file}`] = item.content;
  Object.assign(files, await copyScreenshots());
  for (const file of OPTIONAL_BUNDLE_FILES.filter((name) => !(name in files))) {
    await safeParent(output, file);
    try {
      const path = join(output, ...file.split('/'));
      const info = await lstat(path);
      assert.ok(info.isFile() && !info.isSymbolicLink(), `${file} must be a regular file.`);
      await unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const [file, content] of Object.entries(files)) await writeBundleFile(file, content);
  const manifest = createManifest(files);
  await writeBundleFile('manifest.json', json(manifest));
  const verification = await verifyEvidence(output);
  console.log(JSON.stringify({ output: relative(projectRoot, output) || '.', files: manifest.files.map((item) => item.path), testCount: checks.unit.tests, browserCheckCount: checks.browser.checks, verification }, null, 2));
} catch (error) {
  console.error(`Evidence bundle failed: ${error.message}`);
  await invalidate(error.message);
  process.exitCode = 1;
} finally {
  if (runLock) {
    await runLock.close();
    await unlink(lockPath);
  }
}
