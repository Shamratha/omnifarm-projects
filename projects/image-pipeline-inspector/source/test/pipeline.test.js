import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_REGISTRY,
  applyMask,
  buildManifest,
  compareRevisions,
  convertProfile,
  createInspectorDocument,
  exportManifest,
  getEffectiveVisibility,
  getVisibleLayerIds,
  summarizePipeline,
  validateDocument
} from '../src/pipeline.js';

const baseImage = {
  width: 2,
  height: 2,
  profile: 'srgb',
  pixels: Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255])
};
const mask = { width: 2, height: 2, profile: 'gray709', pixels: Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0, 128, 128, 128, 128, 64, 64, 64, 64]) };

test('masked layer changes alpha only and does not mutate source', () => {
  const result = applyMask(baseImage, mask);
  assert.deepEqual(Array.from(result.pixels), [10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 128, 100, 110, 120, 64]);
  assert.equal(baseImage.pixels[3], 255);
});

test('mask dimensions are validated deterministically', () => {
  assert.throws(() => applyMask(baseImage, { ...mask, width: 1 }), (error) => error.code === 'MASK_DIMENSION_MISMATCH');
});

test('inverted masks preserve source alpha and do not mutate the mask', () => {
  const source = { ...baseImage, pixels: Uint8Array.from(baseImage.pixels) };
  source.pixels[7] = 128;
  const result = applyMask(source, mask, { invert: true });
  assert.deepEqual([result.pixels[3], result.pixels[7], result.pixels[11], result.pixels[15]], [0, 128, 127, 191]);
  assert.equal(mask.pixels[0], 255);
  assert.equal(source.pixels[3], 255);
});

test('profile conversion uses stable Rec. 709 luminance and preserves alpha', () => {
  const image = { width: 3, height: 1, profile: 'srgb', pixels: Uint8Array.from([255, 0, 0, 17, 0, 255, 0, 128, 0, 0, 255, 255]) };
  const result = convertProfile(image, { targetProfile: 'gray709', profiles: PROFILE_REGISTRY });
  assert.deepEqual(Array.from(result.pixels), [54, 54, 54, 17, 182, 182, 182, 128, 18, 18, 18, 255]);
});

test('same-profile conversion is byte-identical and unknown profiles fail', () => {
  const result = convertProfile(baseImage, { targetProfile: 'srgb' });
  assert.deepEqual(Array.from(result.pixels), Array.from(baseImage.pixels));
  assert.throws(() => convertProfile(baseImage, { targetProfile: 'not-a-profile' }), (error) => error.code === 'UNSUPPORTED_PROFILE');
});

test('hidden layers and hidden ancestors are not effectively visible', () => {
  const document = { id: 'visibility', canvas: { profile: 'srgb' }, layers: [
    { id: 'group', visible: false }, { id: 'child', visible: true, parentId: 'group' }, { id: 'shown', visible: true }
  ] };
  assert.equal(getEffectiveVisibility(document, 'child'), false);
  assert.deepEqual(getVisibleLayerIds(document), ['shown']);
});

test('validation catches hidden-layer missing assets and broken parents', () => {
  const document = { id: 'broken', canvas: { profile: 'srgb' }, layers: [
    { id: 'hidden', visible: false, assetId: 'missing' }, { id: 'orphan', visible: true, parentId: 'gone' }
  ], assets: [] };
  const report = validateDocument(document);
  assert.deepEqual(report.issues.map((issue) => issue.code), ['BROKEN_REFERENCE', 'MISSING_ASSET']);
  assert.equal(report.statistics.visibleLayerCount, 1);
});

test('revision comparison identifies changes and explicit destructive operations', () => {
  const before = { id: 'doc', revision: { id: 'rev-1' }, canvas: { profile: 'srgb' }, layers: [{ id: 'a', visible: true, opacity: 1 }] };
  const after = { id: 'doc', revision: { id: 'rev-2' }, canvas: { profile: 'gray709' }, layers: [{ id: 'a', visible: true, opacity: .5 }], operations: [{ type: 'rasterized', path: 'layers[a]', subjectId: 'a', destructive: true }] };
  const result = compareRevisions(before, after);
  assert.equal(result.destructive, true);
  assert.equal(result.destructiveChanges[0].type, 'rasterized');
  assert.ok(result.changes.some((change) => change.type === 'profile-changed'));
});

test('validation catches missing masks even on hidden layers', () => {
  const document = { id: 'mask-broken', canvas: { profile: 'srgb' }, layers: [
    { id: 'masked', visible: false, assetId: 'present', mask: { assetId: 'missing-mask', enabled: true } }
  ], assets: [{ id: 'present', kind: 'svg' }] };
  const report = validateDocument(document);
  assert.deepEqual(report.issues.map((issue) => issue.code), ['MISSING_MASK_ASSET']);
});

test('manifest export includes hidden and unresolved references with stable bytes', () => {
  const document = createInspectorDocument();
  const manifest = buildManifest(document);
  assert.equal(manifest.layers.find((layer) => layer.id === 'grain').visible, false);
  assert.deepEqual(manifest.assets.find((asset) => asset.id === 'asset-legacy-missing'), { id: 'asset-legacy-missing', kind: 'unresolved', present: false });
  const outputA = exportManifest(document);
  const outputB = exportManifest(structuredClone(document));
  assert.equal(outputA, outputB);
  assert.equal(outputA.endsWith('\n'), true);
  assert.equal(JSON.parse(outputA).schemaVersion, 1);
});

test('manifest retains source paths, profile metadata, and edited mask parameters', () => {
  const document = createInspectorDocument();
  document.layers.find((layer) => layer.id === 'mountain').mask = {
    assetId: 'asset-mask', enabled: true, invert: true, feather: 24, edgeShift: -3
  };
  const output = exportManifest(document);
  const manifest = JSON.parse(output);
  assert.equal(manifest.assets.find((asset) => asset.id === 'asset-subject').path, 'fixtures/mountain-cutout.svg');
  assert.equal(manifest.assets.find((asset) => asset.id === 'asset-subject').profile, 'displayP3');
  assert.equal(manifest.layers.find((layer) => layer.id === 'mountain').mask.feather, 24);
  const reorderKeys = (value) => Array.isArray(value) ? value.map(reorderKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reorderKeys(nested)])) : value;
  assert.equal(exportManifest(reorderKeys(document)), output);
});

function summaryRegressionDocument() {
  return {
    id: 'pipeline-regression',
    revision: { id: 'rev-summary-1' },
    canvas: { profile: 'unsupported-profile' },
    assets: [{ id: 'present', kind: 'svg' }],
    layers: [
      { id: 'grade', name: 'Color grade', visible: true, assetId: 'present' },
      { id: 'hidden-broken', name: 'Hidden masked texture', visible: false, assetId: 'missing-asset', mask: { assetId: 'missing-mask', enabled: true } },
      { id: 'orphan', name: 'Orphan layer', visible: true, parentId: 'missing-parent' },
      { id: 'cycle-a', name: 'Cycle A', visible: true, parentId: 'cycle-b' },
      { id: 'cycle-b', name: 'Cycle B', visible: true, parentId: 'cycle-a' }
    ],
    operations: [
      { type: 'adjustment', path: 'layers[grade].params', subjectId: 'grade', destructive: false, amount: 12 },
      { type: 'rasterize', path: 'layers[hidden-broken]', subjectId: 'hidden-broken', destructive: true, reason: 'flatten texture' },
      { type: 'bake-mask', layerId: 'orphan', destructive: true, settings: { feather: 4 } },
      { type: 'external-edit', subjectId: 'external-target', destructive: true, source: 'plugin' },
      { type: 'document-edit', destructive: true, detail: 'rewrite document metadata' },
      { type: 'legacy-flag', subjectId: 'grade', destructive: 1 }
    ]
  };
}

test('pipeline summary preserves destructive operation order and filters deterministic reference issues', () => {
  const document = summaryRegressionDocument();
  const validation = validateDocument(document);
  assert.deepEqual(validation.issues.map((issue) => issue.code), [
    'BROKEN_REFERENCE',
    'MISSING_ASSET',
    'MISSING_MASK_ASSET',
    'UNSUPPORTED_PROFILE',
    'REFERENCE_CYCLE',
    'REFERENCE_CYCLE'
  ]);

  assert.deepEqual(summarizePipeline(document, { validation }), {
    destructiveEdits: {
      count: 4,
      edits: [
        { type: 'rasterize', path: 'layers[hidden-broken]', subjectId: 'hidden-broken', destructive: true, reason: 'flatten texture', layerName: 'Hidden masked texture' },
        { type: 'bake-mask', layerId: 'orphan', destructive: true, settings: { feather: 4 }, subjectId: 'orphan', path: 'operations[2]', layerName: 'Orphan layer' },
        { type: 'external-edit', subjectId: 'external-target', destructive: true, source: 'plugin', path: 'operations[3]', layerName: 'external-target' },
        { type: 'document-edit', destructive: true, detail: 'rewrite document metadata', subjectId: 'pipeline-regression', path: 'operations[4]', layerName: 'pipeline-regression' }
      ]
    },
    brokenReferences: {
      count: 5,
      references: [
        { code: 'BROKEN_REFERENCE', severity: 'error', path: 'layers[2].parentId', subjectId: 'orphan', details: { parentId: 'missing-parent' }, layerName: 'Orphan layer' },
        { code: 'MISSING_ASSET', severity: 'error', path: 'layers[1].assetId', subjectId: 'hidden-broken', details: { assetId: 'missing-asset' }, layerName: 'Hidden masked texture' },
        { code: 'MISSING_MASK_ASSET', severity: 'error', path: 'layers[1].mask.assetId', subjectId: 'hidden-broken', details: { assetId: 'missing-mask' }, layerName: 'Hidden masked texture' },
        { code: 'REFERENCE_CYCLE', severity: 'error', path: 'layers[cycle-a].parentId', subjectId: 'cycle-a', layerName: 'Cycle A' },
        { code: 'REFERENCE_CYCLE', severity: 'error', path: 'layers[cycle-b].parentId', subjectId: 'cycle-b', layerName: 'Cycle B' }
      ]
    }
  });
});

test('manifest includes the summary and operation log with byte-stable export', () => {
  const document = summaryRegressionDocument();
  const validation = validateDocument(document);
  const expectedSummary = summarizePipeline(document, { validation });
  const manifest = buildManifest(document, { validation });

  assert.deepEqual(manifest.summary, expectedSummary);
  assert.deepEqual(manifest.operations, document.operations);
  assert.equal(exportManifest(document), exportManifest(structuredClone(document)));

  const exported = JSON.parse(exportManifest(document));
  assert.deepEqual(exported.summary, expectedSummary);
  assert.deepEqual(exported.operations, document.operations);
});

test('repaired documents report empty destructive and broken-reference states', () => {
  const document = summaryRegressionDocument();
  const repaired = structuredClone(document);
  repaired.canvas.profile = 'srgb';
  repaired.assets.push({ id: 'missing-asset', kind: 'svg' }, { id: 'missing-mask', kind: 'svg' });
  repaired.layers.find((layer) => layer.id === 'orphan').parentId = null;
  repaired.layers.filter((layer) => layer.id === 'cycle-a' || layer.id === 'cycle-b').forEach((layer) => { layer.parentId = null; });
  repaired.operations = [];

  const validation = validateDocument(repaired);
  assert.deepEqual(validation.issues, []);
  assert.deepEqual(summarizePipeline(repaired, { validation }), {
    destructiveEdits: { count: 0, edits: [] },
    brokenReferences: { count: 0, references: [] }
  });
});
