import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  checkGeneratedFiles,
  generateFiles,
  generateManifestJson,
  sourceVersions,
} from '../scripts/generate';

test('generates a manifest with source metadata, counts, and stable routes', () => {
  const manifest = JSON.parse(generateManifestJson()) as {
    schemaVersion: number;
    packageName: string;
    generatedFrom: { generatorPath: string; sources: typeof sourceVersions };
    versions: Array<{
      version: string;
      label: string;
      apiPath: string;
      sourcePath: string;
      symbolCount: number;
      memberCount: number;
      symbolCounts: Record<string, number>;
    }>;
    urls: Record<string, string>;
    anchors: Record<string, string>;
  };

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.packageName, 'webpack');
  assert.equal(manifest.generatedFrom.generatorPath, 'scripts/generate.ts');
  assert.deepEqual(manifest.generatedFrom.sources, sourceVersions);
  assert.deepEqual(manifest.versions.map(version => version.version), ['5.99.0', '5.98.0']);
  assert.deepEqual(manifest.versions.map(version => version.label), ['Latest', 'Previous']);
  for (const version of manifest.versions) {
    assert.equal(version.apiPath, '/generated/api.json');
    assert.equal(version.sourcePath, sourceVersions.find(source => source.version === version.version)?.sourcePath);
    assert.ok(version.symbolCount > 0);
    assert.ok(version.memberCount > 0);
    assert.equal(Object.values(version.symbolCounts).reduce((sum, count) => sum + count, 0), version.symbolCount);
  }
  assert.deepEqual(manifest.urls, {
    api: '/generated/api.json',
    manifest: '/generated/manifest.json',
    version: '/?version={version}',
    symbol: '/?version={version}&symbol={symbolId}#symbol-{stableSymbolId}',
    source: '/?version={version}&source={sourcePath}#L{line}',
    compare: '/?version={version}&compare=true#compare',
    diagnostics: '/?diagnostics=true',
  });
  assert.deepEqual(manifest.anchors, {
    symbol: 'symbol-{stableSymbolId}',
    member: 'member-{stableMemberId}',
    overload: 'overload-{stableOwnerId}-{index}',
    diff: 'diff-{stableSymbolId}',
    sourceLine: 'L{line}',
  });
});

test('generates byte-for-byte deterministic API and manifest outputs', () => {
  const first = generateFiles();
  const second = generateFiles();
  assert.equal(first.api, second.api);
  assert.equal(first.manifest, second.manifest);
  assert.equal(first.diagnostics, second.diagnostics);
});

test('checks API and manifest outputs together', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-generated-'));
  try {
    const apiPath = path.join(directory, 'api.json');
    const manifestPath = path.join(directory, 'manifest.json');
    const diagnosticsPath = path.join(directory, 'diagnostics.json');
    const generated = generateFiles();
    fs.writeFileSync(apiPath, generated.api);
    fs.writeFileSync(manifestPath, generated.manifest);
    fs.writeFileSync(diagnosticsPath, generated.diagnostics);
    assert.doesNotThrow(() => checkGeneratedFiles(apiPath, manifestPath, diagnosticsPath));

    fs.writeFileSync(manifestPath, `${generated.manifest.trim()}\n `);
    assert.throws(
      () => checkGeneratedFiles(apiPath, manifestPath, diagnosticsPath),
      /Generated manifest is stale/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
