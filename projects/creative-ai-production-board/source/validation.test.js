import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSETS, CREDITS, CUTS } from './board-data.js';
import {
  buildManifest,
  checkExportSafety,
  findDuplicateCredits,
  findInvalidTimings,
  findMissingAssets,
  findOutOfOrderScenes,
  findTimingGaps,
  findTimingOverlaps,
  findUnclearedAssets,
  formatSeconds,
  resolveCueAssetId,
  validateCut,
  validateProduction,
} from './validation.js';

function scene(overrides = {}) {
  return {
    id: 's01', number: '01', title: 'The city holds its breath',
    start: 0, end: 10, assetId: 'frame-skyline', cue: 'signal-hum',
    cueLabel: 'Low hum / fade in', ...overrides,
  };
}

function production(overrides = {}) {
  return {
    scenes: [scene()], assets: structuredClone(ASSETS), credits: structuredClone(CREDITS),
    ...overrides,
  };
}

function manifestInput(overrides = {}) {
  const { scenes, assets, credits } = production();
  return {
    project: 'The last signal', cutKey: 'quiet',
    cut: { label: 'Quiet Signal', duration: 10, scenes }, assets, credits,
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('missing frame assets return the original affected scenes', () => {
  const scenes = [scene(), scene({ id: 'missing', assetId: 'absent' }), scene({ id: 'empty', assetId: '' })];
  assert.deepEqual(findMissingAssets(scenes, ASSETS), scenes.slice(1));
  const result = validateProduction(production({ scenes }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /missing assets/i);
  assert.equal(result.safety.safe, false);
});

test('legacy cue names resolve to their actual audio IDs', () => {
  const scenes = [scene(), scene({ id: 'voice', cue: 'voice-note-07', start: 10, end: 20 })];
  assert.deepEqual(findMissingAssets(scenes, ASSETS), []);
  assert.deepEqual(findUnclearedAssets(scenes, ASSETS), []);
  assert.deepEqual(findMissingAssets(scenes, ASSETS.filter((asset) => asset.id !== 'audio-voice')), [scenes[1]]);
});

test('explicit cueAssetId overrides legacy resolution and missing cues block', () => {
  const good = scene({ cueAssetId: 'audio-voice' });
  const bad = scene({ cueAssetId: 'absent', assetId: 'also-absent' });
  assert.deepEqual(findMissingAssets([good], ASSETS), []);
  assert.deepEqual(findMissingAssets([bad], ASSETS), [bad]);
  assert.equal(validateProduction(production({ scenes: [bad] })).ok, false);
  for (const cueAssetId of ['', null, undefined]) {
    const invalid = scene({ cueAssetId });
    assert.deepEqual(findMissingAssets([invalid], ASSETS), [invalid]);
  }
});

test('absent cues require explicit silence; unresolved arbitrary references are missing', () => {
  const absent = scene({ cue: undefined });
  assert.deepEqual(findMissingAssets([absent], ASSETS), [absent]);
  assert.equal(validateProduction(production({ scenes: [absent] })).ok, false);
  assert.equal(validateProduction(production({ scenes: [scene({ cue: undefined, silent: true })] })).ok, true);
  assert.deepEqual(findMissingAssets([scene({ cue: 'audio-voice' })], ASSETS), []);
  const unknown = scene({ cue: 'not-bundled' });
  assert.deepEqual(findMissingAssets([unknown], ASSETS), [unknown]);
});

test('duplicate credits normalize case, Unicode, and internal whitespace for name and role', () => {
  const first = { name: 'Rae Biko', role: 'Sound design' };
  const second = { name: '  RAE\tBIKO  ', role: '  sound   DESIGN ' };
  const third = { name: 'Ｒａｅ Ｂｉｋｏ', role: 'Sound design' };
  const credits = [first, second, { name: 'Rae Biko', role: 'Voice' }, third];
  assert.deepEqual(findDuplicateCredits(credits), [{ credit: second, first }, { credit: third, first }]);
  const result = validateProduction(production({ credits }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /duplicate credit/i);
});

test('credit pair keys do not collide when a field includes a separator', () => {
  assert.deepEqual(findDuplicateCredits([
    { name: 'A::B', role: 'C' }, { name: 'A', role: 'B::C' },
  ]), []);
});

test('overlaps detect non-adjacent nested intervals and report actual shared duration', () => {
  const outer = scene({ id: 'outer', start: 0, end: 100 });
  const inner = scene({ id: 'inner', start: 10, end: 20 });
  const later = scene({ id: 'later', start: 30, end: 40 });
  const scenes = deepFreeze([later, outer, inner]);
  assert.deepEqual(findTimingOverlaps(scenes), [
    { previous: outer, current: inner, overlap: 10 },
    { previous: outer, current: later, overlap: 10 },
  ]);
  assert.equal(validateProduction(production({ scenes })).ok, false);
  assert.deepEqual(scenes.map(({ id }) => id), ['later', 'outer', 'inner']);
});

test('all simultaneously overlapping pairs are detected, including equal starts', () => {
  const a = scene({ id: 'a', start: 0, end: 20 });
  const b = scene({ id: 'b', start: 0, end: 10 });
  const c = scene({ id: 'c', start: 5, end: 15 });
  assert.deepEqual(findTimingOverlaps([c, b, a]), [
    { previous: a, current: b, overlap: 10 },
    { previous: a, current: c, overlap: 10 },
    { previous: b, current: c, overlap: 5 },
  ]);
});

test('touching scene boundaries and gaps are not overlaps', () => {
  const scenes = [scene(), scene({ start: 10, end: 20 }), scene({ start: 25, end: 30 })];
  assert.deepEqual(findTimingOverlaps(scenes), []);
  assert.equal(validateProduction(production({ scenes })).ok, true);
});

const INVALID_TIMINGS = [
  ['negative start', { start: -1 }],
  ['zero duration', { start: 10, end: 10 }],
  ['reversed range', { start: 20, end: 10 }],
  ['NaN start', { start: NaN }],
  ['infinite end', { end: Infinity }],
  ['negative infinite start', { start: -Infinity }],
  ['missing start', { start: undefined }],
  ['null end', { end: null }],
  ['string start', { start: '0' }],
  ['string end', { end: '10' }],
];

for (const [description, timing] of INVALID_TIMINGS) {
  test(`invalid timing blocks validation and manifest: ${description}`, () => {
    const invalid = scene(timing);
    const scenes = [invalid];
    const result = validateProduction(production({ scenes }));
    assert.equal(result.ok, false);
    assert.equal(result.safety.safe, false);
    assert.deepEqual(result.invalidTimings, scenes);
    assert.deepEqual(findInvalidTimings(scenes), scenes);
    assert.deepEqual(findTimingOverlaps(scenes), []);
    assert.throws(() => buildManifest(manifestInput({ cut: { scenes } })), /invalid timing/i);
  });
}

test('fractional finite timings are valid', () => {
  assert.equal(validateProduction(production({ scenes: [scene({ start: 0.25, end: 10.75 })] })).ok, true);
});

test('uncleared frames and audio cues are detected and cannot be silently omitted', () => {
  const input = production();
  input.assets.find((asset) => asset.id === 'frame-skyline').rightsStatus = 'pending';
  input.assets.find((asset) => asset.id === 'audio-hum').rightsStatus = 'unknown';
  const uncleared = findUnclearedAssets(input.scenes, input.assets);
  assert.deepEqual(uncleared.map(({ asset }) => asset.id), ['frame-skyline', 'audio-hum']);
  const result = validateProduction(input);
  assert.equal(result.ok, false);
  assert.equal(result.safety.safe, false);
  assert.match(result.warnings.join('; '), /rights review/i);
  assert.deepEqual(result.unclearedAssets.map(({ asset }) => asset.id), ['frame-skyline', 'audio-hum']);
  assert.throws(() => buildManifest(manifestInput({ assets: input.assets })), /rights clearance/i);
});

test('missing assets retain the existing uncleared result shape', () => {
  const missing = scene({ assetId: 'absent', cue: undefined });
  const [issue] = findUnclearedAssets([missing], ASSETS);
  assert.equal(issue.scene, missing);
  assert.equal(issue.asset, undefined);
});

test('scene and cue types and embedded rights labels must be usable', () => {
  const wrongFrame = validateProduction(production({ scenes: [scene({ assetId: 'audio-hum' })] }));
  const wrongCue = validateProduction(production({ scenes: [scene({ cueAssetId: 'frame-window' })] }));
  for (const result of [wrongFrame, wrongCue]) {
    assert.equal(result.ok, false);
    assert.equal(result.invalidAssetTypes.length, 1);
    assert.match(result.errors.join('; '), /FRAME.*AUDIO/);
  }
  for (const id of ['frame-skyline', 'audio-hum']) {
    const assets = structuredClone(ASSETS);
    assets.find((asset) => asset.id === id).rightsLabel = '  ';
    const result = validateProduction(production({ assets }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingRightsLabels.map((asset) => asset.id), [id]);
    assert.throws(() => buildManifest(manifestInput({ assets })), /rights labels/i);
  }
});

test('malformed arrays, credits, asset IDs, and scene records are blocking rather than crashing', () => {
  for (const input of [null, production({ scenes: {} }), production({ assets: null }), production({ credits: 'bad' })]) {
    assert.equal(validateProduction(input).ok, false);
  }
  for (const credit of [null, {}, { name: 'Rae', role: ' ' }, { name: 42, role: 'Voice' }]) {
    assert.equal(validateProduction(production({ credits: [credit] })).ok, false);
  }
  for (const asset of [null, {}, { id: '' }, ASSETS[0]]) {
    assert.equal(validateProduction(production({ assets: [...ASSETS, asset] })).ok, false);
  }
  assert.equal(validateProduction(production({ scenes: [null] })).ok, false);
  assert.deepEqual(findMissingAssets(null, null), []);
  assert.deepEqual(findDuplicateCredits(null), []);
  assert.deepEqual(findTimingOverlaps(null), []);
  assert.deepEqual(findUnclearedAssets(null, null), []);
});

test('safe export defaults preserve the public helper shape', () => {
  assert.deepEqual(checkExportSafety(), { safe: true, blockers: [], notices: [] });
  assert.equal(validateProduction(production()).ok, true);
  assert.equal(checkExportSafety({}, { errors: [], warnings: ['Review note'] }).safe, true);
});

for (const [flag, value, reason] of [
  ['includeUncleared', true, /uncleared/i],
  ['allowUnresolved', true, /resolve/i],
  ['embedRightsLabels', false, /rights labels/i],
]) {
  test(`unsafe export setting blocks validation and manifest: ${flag}`, () => {
    const settings = { [flag]: value };
    const result = validateProduction(production({ exportSettings: settings }));
    assert.equal(result.ok, false);
    assert.equal(checkExportSafety(settings, result).safe, false);
    assert.match(result.safety.blockers.join('; '), reason);
    assert.throws(() => buildManifest(manifestInput({ settings })), reason);
  });
}

test('incorrect setting types and unknown distributions cannot bypass safety', () => {
  for (const settings of [
    null, [], 'unsafe', { distribution: 'unknown' }, { distribution: null },
    { includeUncleared: 'false' }, { allowUnresolved: 0 },
    { embedRightsLabels: 'false' }, { publicDistribution: 'true' },
  ]) {
    assert.equal(checkExportSafety(settings).safe, false);
    assert.throws(() => buildManifest(manifestInput({ settings })), /unsafe manifest/i);
  }
});

test('checkExportSafety honors reported production issues and cannot override clearance', () => {
  for (const validation of [
    { errors: ['Missing asset'] }, { ok: false }, { missingAssets: [scene()] },
    { timingOverlaps: [{}] }, { invalidTimings: [scene()] }, { duplicateCredits: [{}] },
    { unclearedAssets: [{}] }, null,
  ]) {
    assert.equal(checkExportSafety({}, validation).safe, false);
  }
  assert.equal(checkExportSafety({ includeUncleared: true }, { unclearedAssets: [{}] }).safe, false);
});

test('both bundled cuts remain valid for default internal-review exports', () => {
  assert.deepEqual(Object.keys(CUTS).sort(), ['pulse', 'quiet']);
  for (const [cutKey, cut] of Object.entries(CUTS)) {
    const result = validateCut({ cut, assets: ASSETS, credits: CREDITS });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.unclearedAssets, []);
    assert.equal(result.editorialAssets.length, 1);
    assert.deepEqual(result.timingGaps, []);
    assert.deepEqual(result.outOfOrder, []);
    assert.deepEqual(result.missingCues, []);
    assert.deepEqual(result.cueTimingIssues, []);
    assert.deepEqual(result.durationIssues, []);
    assert.deepEqual(result, validateProduction({
      scenes: cut.scenes, duration: cut.duration, assets: ASSETS, credits: CREDITS,
    }));
    const manifest = buildManifest(manifestInput({ cutKey, cut, assets: ASSETS, credits: CREDITS }));
    assert.equal(manifest.settings.distribution, 'internal-review');
    assert.equal(manifest.duration, cut.duration);
    assert.equal(manifest.assets.length, 6);
    assert.equal(manifest.scenes.length, 5);
    assert.equal(manifest.continuity.status, 'review');
    assert.deepEqual(manifest.continuity.timingGaps, []);
    assert.ok(manifest.continuity.issues.every((issue) => issue.severity === 'warning'));
    assert.ok(manifest.scenes.every((scene) => scene.timingStatus === 'pass' && scene.continuity === 'pass'));
  }
});

test('valid manifest includes credits, frame rights, audio rights, and cue metadata', () => {
  const input = manifestInput();
  const manifest = buildManifest(input);
  assert.equal(manifest.project, input.project);
  assert.equal(manifest.activeCut, input.cutKey);
  assert.equal(manifest.cut, input.cut.label);
  assert.equal(manifest.duration, input.cut.duration);
  assert.equal(manifest.localOnly, true);
  assert.deepEqual(manifest.credits, input.credits);
  assert.deepEqual(manifest.settings, {
    distribution: 'internal-review', embedRightsLabels: true, includeUncleared: false, allowUnresolved: false,
  });
  assert.equal(manifest.validation.ok, true);
  assert.equal(manifest.validation.rightsLabelsEmbedded, true);
  assert.deepEqual(manifest.assets.map((asset) => asset.id), ['frame-skyline', 'audio-hum']);
  assert.equal(manifest.scenes[0].rightsStatus, 'cleared');
  assert.equal(manifest.scenes[0].rightsLabel, ASSETS.find((asset) => asset.id === 'frame-skyline').rightsLabel);
  assert.equal(manifest.scenes[0].cueAssetId, 'audio-hum');
  assert.deepEqual(manifest.scenes[0].audioCue, {
    cue: 'signal-hum', assetId: 'audio-hum', name: 'signal-hum.wav', type: 'AUDIO',
    label: 'Low hum / fade in', time: '00:00', start: 0, end: 10,
    rightsStatus: 'cleared', rightsLabel: 'Original',
  });
});

test('manifest honors explicit cue references and retains valid scene order', () => {
  const scenes = [
    scene({ id: 'earlier', start: 0, end: 10, cue: undefined, silent: true }),
    scene({ id: 'later', start: 15, end: 20, cueAssetId: 'audio-voice', cueTime: undefined }),
  ];
  const manifest = buildManifest(manifestInput({ cut: { label: 'Cut', scenes } }));
  assert.equal(manifest.duration, 20);
  assert.deepEqual(manifest.scenes.map(({ id }) => id), ['earlier', 'later']);
  assert.equal(manifest.scenes[1].cueAssetId, 'audio-voice');
  assert.equal(manifest.scenes[1].audioCue.assetId, 'audio-voice');
  assert.equal(manifest.scenes[1].audioCue.time, '00:15');
  assert.equal(manifest.scenes[1].audioCue.rightsLabel, 'Voice release on file');
  assert.equal(manifest.scenes[0].audioCue, null);
  assert.deepEqual(manifest.assets.map(({ id }) => id), ['frame-skyline', 'audio-voice']);
});

test('editorial frames are permitted internally and blocked for requested public distribution', () => {
  const scenes = [scene({ assetId: 'frame-hands' })];
  const internal = validateProduction(production({ scenes }));
  assert.equal(internal.ok, true);
  assert.match(internal.safety.notices.join('; '), /internal-review/);
  const input = manifestInput({ cut: { scenes } });
  const manifest = buildManifest(input);
  assert.equal(manifest.scenes[0].rightsLabel, ASSETS.find((asset) => asset.id === 'frame-hands').rightsLabel);
  for (const settings of [{ distribution: 'public' }, { distribution: 'public-distribution' }, { publicDistribution: true }]) {
    const result = validateProduction(production({ scenes, exportSettings: settings }));
    assert.equal(result.ok, false);
    assert.equal(checkExportSafety(settings, internal).safe, false);
    assert.match(result.safety.blockers.join('; '), /editorial-only.*public/i);
    assert.throws(() => buildManifest({ ...input, settings }), /editorial-only.*public/i);
  }
});

test('editorial audio cues have the same public distribution restriction as frames', () => {
  const assets = structuredClone(ASSETS);
  const audio = assets.find((asset) => asset.id === 'audio-hum');
  audio.rightsStatus = 'editorial';
  audio.rightsLabel = 'Editorial audio only';
  const input = manifestInput({ assets });
  const internal = buildManifest(input);
  assert.equal(internal.scenes[0].audioCue.rightsLabel, 'Editorial audio only');
  assert.throws(() => buildManifest({ ...input, settings: { distribution: 'public' } }), /editorial-only/i);
});

test('public export permits cleared and AI-assisted assets and excludes unused editorial assets', () => {
  for (const assetId of ['frame-skyline', 'frame-rooftop']) {
    const scenes = [scene({ assetId })];
    const settings = { distribution: 'public' };
    assert.equal(validateProduction(production({ scenes, exportSettings: settings })).ok, true);
    const manifest = buildManifest(manifestInput({ cut: { scenes }, settings }));
    assert.equal(manifest.settings.distribution, 'public');
    assert.equal(manifest.assets.some((asset) => asset.rightsStatus === 'editorial'), false);
  }
});

test('manifest cannot export missing assets, duplicate credits, or overlapping scenes', () => {
  for (const [overrides, reason] of [
    [{ cut: { scenes: [scene({ assetId: 'absent' })] } }, /missing assets/i],
    [{ cut: { scenes: [scene({ cueAssetId: 'absent' })] } }, /missing assets/i],
    [{ credits: [CREDITS[0], { name: ' rae biko ', role: 'DIRECTION + EDIT' }] }, /duplicate credit/i],
    [{ cut: { scenes: [scene(), scene({ id: 'second', start: 5, end: 15 })] } }, /timing overlap/i],
  ]) {
    assert.throws(() => buildManifest(manifestInput(overrides)), reason);
  }
});

test('manifest requires project and cut input and a duration that covers its scenes', () => {
  for (const input of [null, {}, manifestInput({ project: '' }), manifestInput({ cutKey: '' }),
    manifestInput({ cut: null }), manifestInput({ cut: { scenes: [] } })]) {
    assert.throws(() => buildManifest(input), /manifest/i);
  }
  for (const duration of [0, -1, NaN, Infinity, '10']) {
    assert.throws(() => buildManifest(manifestInput({ cut: { duration, scenes: [scene()] } })), /duration/i);
  }
  assert.equal(buildManifest(manifestInput({ cut: { duration: 12, scenes: [scene()] } })).duration, 12);
});

test('validation and manifest are pure, deterministic, and detached from nested input metadata', () => {
  const input = manifestInput({
    project: { title: 'The last signal', owner: { name: 'Rae Biko' } },
    credits: [{ ...CREDITS[0], metadata: { source: 'local' } }],
  });
  const snapshot = structuredClone(input);
  deepFreeze(input);
  const validationInput = deepFreeze({ scenes: input.cut.scenes, assets: input.assets, credits: input.credits });
  assert.deepEqual(validateProduction(validationInput), validateProduction(validationInput));
  const first = buildManifest(input);
  assert.deepEqual(first, buildManifest(input));
  assert.deepEqual(input, snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  first.project.owner.name = 'Changed';
  first.credits[0].metadata.source = 'Changed';
  first.assets[0].rightsLabel = 'Changed';
  first.scenes[0].title = 'Changed';
  assert.deepEqual(input, snapshot);
  assert.deepEqual(buildManifest(input), buildManifest(snapshot));
});

test('formatSeconds formats boundaries and fractions and handles invalid inputs consistently', () => {
  for (const [seconds, expected] of [[0, '00:00'], [59.99, '00:59'], [60, '01:00'],
    [198, '03:18'], [6000, '100:00'], [-5, '00:00'], [NaN, '00:00'],
    [Infinity, '00:00'], [undefined, '00:00'], [null, '00:00'], ['60', '00:00']]) {
    assert.equal(formatSeconds(seconds), expected);
  }
});

test('exact touching fractional boundaries pass while even tiny actual overlaps block', () => {
  const scenes = [
    scene({ id: 'a', start: 0, end: 0.25 }),
    scene({ id: 'b', start: 0.25, end: 10.75 }),
    scene({ id: 'c', start: 10.75, end: 20.125 }),
  ];
  const result = validateProduction(production({ scenes, duration: 20.125 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.timingOverlaps, []);
  assert.deepEqual(result.timingGaps, []);
  assert.equal(buildManifest(manifestInput({ cut: { scenes, duration: 20.125 } })).continuity.status, 'pass');
  const overlapping = structuredClone(scenes);
  overlapping[1].start -= 0.000000001;
  const blocked = validateProduction(production({ scenes: overlapping }));
  assert.equal(blocked.ok, false);
  assert.ok(blocked.timingOverlaps[0].overlap > 0);
  assert.equal(blocked.issues.find((issue) => issue.code === 'timing-overlap').severity, 'error');
  assert.throws(() => buildManifest(manifestInput({ cut: { scenes: overlapping } })), /overlap/i);
});

test('union coverage avoids false gaps inside nested scenes and uses the maximum coverage end', () => {
  const scenes = deepFreeze([
    scene({ id: 'outer', start: 5, end: 100 }),
    scene({ id: 'inner', start: 10, end: 20 }),
    scene({ id: 'later-inner', start: 30, end: 40 }),
    scene({ id: 'after', start: 110, end: 120 }),
  ]);
  const expected = [
    { start: 0, end: 5, duration: 5 },
    { start: 100, end: 110, duration: 10 },
    { start: 120, end: 125, duration: 5 },
  ];
  assert.deepEqual(findTimingGaps(scenes, 125), expected);
  const result = validateProduction(production({ scenes, duration: 125 }));
  assert.equal(result.ok, false);
  assert.equal(result.timingOverlaps.length, 2);
  assert.deepEqual(result.timingGaps, expected);
  const gaps = result.issues.filter((issue) => issue.code === 'timing-gap');
  assert.deepEqual(gaps.map((issue) => issue.sceneIds), [['outer'], ['outer', 'after'], ['after']]);
  assert.ok(gaps.every((issue) => issue.severity === 'warning'));
});

test('leading, internal, and trailing gaps are exportable warnings with computed per-scene status', () => {
  const scenes = [
    scene({ id: 'first', start: 2, end: 7, continuity: 'match' }),
    scene({ id: 'second', start: 10, end: 15, continuity: 'match' }),
    scene({ id: 'middle', start: 15, end: 18, continuity: 'watch' }),
    scene({ id: 'last', start: 18, end: 20, continuity: 'match' }),
  ];
  const cut = { scenes, duration: 22 };
  const result = validateCut({ cut, assets: ASSETS, credits: CREDITS });
  const expected = [
    { start: 0, end: 2, duration: 2 },
    { start: 7, end: 10, duration: 3 },
    { start: 20, end: 22, duration: 2 },
  ];
  assert.equal(result.ok, true);
  assert.equal(result.safety.safe, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.timingGaps, expected);
  assert.equal(result.warnings.length, 3);
  assert.equal(checkExportSafety({}, result).safe, true);
  const manifest = buildManifest(manifestInput({ cut }));
  assert.deepEqual(manifest.continuity, {
    status: 'review', issues: result.issues.filter((issue) => issue.severity === 'warning'), timingGaps: expected,
  });
  assert.deepEqual(manifest.validation.continuity, manifest.continuity);
  assert.deepEqual(manifest.scenes.map((scene) => scene.timingStatus), ['review', 'review', 'pass', 'review']);
  assert.deepEqual(manifest.scenes.map((scene) => scene.continuity), ['review', 'review', 'pass', 'review']);
  assert.equal(scenes[2].continuity, 'watch');
  assert.deepEqual(findTimingGaps(scenes), expected.slice(0, 2));
});

test('out-of-order scenes block validation and download even with no overlaps or gaps', () => {
  const later = scene({ id: 'later', number: '02', title: 'Later scene', start: 10, end: 20 });
  const earlier = scene({ id: 'earlier', number: '01', title: 'Earlier scene' });
  const cut = deepFreeze({ scenes: [later, earlier], duration: 20 });
  const result = validateCut({ cut, assets: ASSETS, credits: CREDITS });
  assert.equal(result.ok, false);
  assert.deepEqual(result.timingOverlaps, []);
  assert.deepEqual(result.timingGaps, []);
  assert.deepEqual(result.outOfOrder, [{ previous: later, current: earlier }]);
  assert.deepEqual(findOutOfOrderScenes(cut.scenes), result.outOfOrder);
  const issue = result.issues.find((issue) => issue.code === 'scene-order');
  assert.equal(issue.severity, 'error');
  assert.deepEqual(issue.sceneIds, ['later', 'earlier']);
  for (const text of ['later', 'earlier', '02', '01', 'Later scene', 'Earlier scene']) {
    assert.ok(issue.message.includes(text));
    assert.ok(result.safety.blockers.join('; ').includes(text));
  }
  assert.throws(() => buildManifest(manifestInput({ cut })), /timestamp order|starts earlier/i);
  assert.deepEqual(cut.scenes.map((scene) => scene.id), ['later', 'earlier']);
});

test('missing, empty, null, and unknown cues block unless explicit silence is declared', () => {
  const absent = scene();
  delete absent.cue;
  for (const invalid of [absent, ...['', '   ', null, undefined, 'unknown'].map((cue) => scene({ cue }))]) {
    const result = validateProduction(production({ scenes: [invalid] }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingCues, [invalid]);
    assert.deepEqual(findMissingAssets([invalid], ASSETS), [invalid]);
    const issue = result.issues.find((issue) => issue.code === 'missing-cue');
    assert.equal(issue.severity, 'error');
    assert.deepEqual(issue.sceneIds, ['s01']);
    assert.match(result.safety.blockers.join('; '), /s01.*audio cue/i);
    assert.throws(() => buildManifest(manifestInput({ cut: { scenes: [invalid] } })), /audio cue/i);
  }
  for (const cueAssetId of ['', '   ', null, undefined, 'unknown']) {
    const invalid = scene({ cueAssetId });
    const result = validateProduction(production({ scenes: [invalid] }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingCues, [invalid]);
    assert.throws(() => buildManifest(manifestInput({ cut: { scenes: [invalid] } })), /audio cue/i);
  }
});

test('only silent:true declares intent and actual cue references conflict with silence', () => {
  const intentional = scene({ silent: true, cue: undefined });
  delete intentional.cue;
  const result = validateProduction(production({ scenes: [intentional] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingCues, []);
  assert.deepEqual(findMissingAssets([intentional], ASSETS), []);
  const manifest = buildManifest(manifestInput({ cut: { scenes: [intentional] } }));
  assert.equal(manifest.scenes[0].silent, true);
  assert.equal(manifest.scenes[0].audioCue, null);
  assert.deepEqual(manifest.assets.map((asset) => asset.id), ['frame-skyline']);
  for (const silent of [false, 'true', 1, undefined, null]) {
    assert.equal(validateProduction(production({ scenes: [scene({ silent, cue: undefined })] })).ok, false);
  }
  for (const invalid of [
    scene({ silent: true }),
    scene({ silent: true, cue: undefined, cueAssetId: 'audio-voice' }),
    scene({ silent: true, cue: 'unknown' }),
    scene({ silent: true, cueAssetId: null }),
  ]) {
    const result = validateProduction(production({ scenes: [invalid] }));
    assert.equal(result.ok, false);
    assert.match(result.issues.find((issue) => issue.code === 'missing-cue').message, /silent.*references audio cue/i);
    assert.throws(() => buildManifest(manifestInput({ cut: { scenes: [invalid] } })), /silent.*references audio cue/i);
  }
});

test('cue resolution is explicit, prototype-safe, and missing cue labels are optional', () => {
  assert.equal(resolveCueAssetId(scene()), 'audio-hum');
  assert.equal(resolveCueAssetId(scene({ cue: 'voice-note-07' })), 'audio-voice');
  assert.equal(resolveCueAssetId(scene({ cueAssetId: 'audio-voice' })), 'audio-voice');
  assert.equal(resolveCueAssetId(scene({ cueAssetId: null })), null);
  assert.equal(resolveCueAssetId(scene({ cueAssetId: undefined })), undefined);
  assert.equal(resolveCueAssetId(scene({ cue: 'toString' })), 'toString');
  assert.equal(resolveCueAssetId(null), undefined);
  const cut = { scenes: [scene({ cueLabel: undefined })] };
  assert.equal(validateCut({ cut, assets: ASSETS, credits: CREDITS }).ok, true);
  assert.equal(buildManifest(manifestInput({ cut })).scenes[0].audioCue.label, null);
});

for (const cueTime of ['00:01', '00:10', '00:11', '00:60', '0:1', '00:03.',
  '00:03text', '-01:00', '', null, 3, NaN, `${'9'.repeat(400)}:00`]) {
  test(`malformed or outside cue entry blocks export: ${String(cueTime).slice(0, 30)}`, () => {
    const cut = { scenes: [scene({ start: 2, end: 10, cueTime })] };
    const result = validateCut({ cut, assets: ASSETS, credits: CREDITS });
    assert.equal(result.ok, false);
    assert.equal(result.cueTimingIssues.length, 1);
    const issue = result.issues.find((issue) => issue.code === 'cue-timing');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.assetId, 'audio-hum');
    assert.deepEqual(issue.sceneIds, ['s01']);
    assert.throws(() => buildManifest(manifestInput({ cut })), /cue time/i);
  });
}

test('cue entries allow fractional seconds, arbitrary minute width, and an optional computed start', () => {
  for (const cueTime of [undefined, '00:02', '00:02.5', '00:09.999999']) {
    const cut = { scenes: [scene({ start: 2, end: 10, cueTime })] };
    assert.equal(validateCut({ cut, assets: ASSETS, credits: CREDITS }).ok, true);
    assert.equal(buildManifest(manifestInput({ cut })).scenes[0].audioCue.time, cueTime ?? '00:02');
  }
  for (const cueTime of [undefined, '100:00.25', '00100:00.25']) {
    const cut = { scenes: [scene({ start: 6000.25, end: 6002, cueTime })] };
    assert.equal(validateCut({ cut, assets: ASSETS, credits: CREDITS }).ok, true);
    assert.equal(buildManifest(manifestInput({ cut })).scenes[0].audioCue.time, cueTime ?? '100:00.25');
  }
  const cut = { scenes: [scene({ start: 0.25, end: 1 })] };
  assert.equal(buildManifest(manifestInput({ cut })).scenes[0].audioCue.time, '00:00.25');
  const tiny = { scenes: [scene({ start: 1e-21, end: 1 })] };
  assert.equal(buildManifest(manifestInput({ cut: tiny })).scenes[0].audioCue.time, '00:00.000000000000000000001');
});

test('empty cuts and invalid declared durations fail shared validation, while undefined derives the end', () => {
  for (const cut of [undefined, null, {}, { scenes: [] }, { scenes: null }]) {
    const result = validateCut({ cut, assets: ASSETS, credits: CREDITS });
    assert.equal(result.ok, false);
    assert.equal(result.safety.safe, false);
    assert.ok(result.issues.some((issue) => issue.code === 'empty-cut'));
  }
  for (const duration of [-1, NaN, Infinity, -Infinity, '10', null, 9.999999]) {
    const cut = { scenes: [scene()], duration };
    const result = validateCut({ cut, assets: ASSETS, credits: CREDITS });
    assert.equal(result.ok, false);
    assert.equal(result.durationIssues.length, 1);
    assert.match(result.safety.blockers.join('; '), /duration/i);
    assert.throws(() => buildManifest(manifestInput({ cut })), /duration/i);
  }
  const cut = { scenes: [scene()], duration: undefined };
  assert.equal(validateCut({ cut, assets: ASSETS, credits: CREDITS }).duration, 10);
  assert.deepEqual(validateCut({ cut, assets: ASSETS, credits: CREDITS }).durationIssues, []);
  assert.equal(buildManifest(manifestInput({ cut })).duration, 10);
});

test('all unsafe flag combinations remain blocked and report actionable setting reasons', () => {
  for (let mask = 1; mask < 8; mask += 1) {
    const settings = {
      includeUncleared: Boolean(mask & 1),
      allowUnresolved: Boolean(mask & 2),
      embedRightsLabels: !Boolean(mask & 4),
    };
    const result = validateProduction(production({ exportSettings: settings }));
    assert.equal(result.ok, false);
    const settingIssues = result.issues.filter((issue) => issue.code === 'unsafe-setting');
    assert.equal(settingIssues.length, [1, 2, 4].filter((bit) => mask & bit).length);
    assert.ok(settingIssues.every((issue) => issue.severity === 'error' && issue.sceneIds.length === 0));
    assert.throws(() => buildManifest(manifestInput({ settings })), /unsafe manifest/i);
    for (const issue of settingIssues) assert.ok(result.safety.blockers.includes(issue.message));
  }
  const cut = { scenes: [scene({ assetId: 'frame-hands' })] };
  const settings = { publicDistribution: true, includeUncleared: true, allowUnresolved: true, embedRightsLabels: false };
  const result = validateCut({ cut, assets: ASSETS, credits: CREDITS, exportSettings: settings });
  assert.equal(result.ok, false);
  assert.match(result.safety.blockers.join('; '), /Editorial-only.*public/);
  assert.throws(() => buildManifest(manifestInput({ cut, settings })), /public distribution/i);
});

test('missing frame and audio rights labels identify their references and prevent export', () => {
  for (const assetId of ['frame-skyline', 'audio-hum']) {
    const assets = structuredClone(ASSETS);
    delete assets.find((asset) => asset.id === assetId).rightsLabel;
    const result = validateProduction(production({ assets }));
    assert.equal(result.ok, false);
    const issue = result.issues.find((issue) => issue.code === 'rights-label');
    assert.equal(issue.assetId, assetId);
    assert.deepEqual(issue.sceneIds, ['s01']);
    assert.match(issue.message, /s01.*01.*The city holds its breath/);
    assert.ok(result.safety.blockers.join('; ').includes(assetId));
    assert.throws(() => buildManifest(manifestInput({ assets })), /rights label/i);
  }
});

test('correcting settings recovers validation and manifest without stale ok poisoning', () => {
  const input = manifestInput();
  input.settings = { includeUncleared: true, allowUnresolved: true, embedRightsLabels: false };
  const bad = validateCut({ cut: input.cut, assets: input.assets, credits: input.credits, exportSettings: input.settings });
  assert.equal(bad.ok, false);
  assert.throws(() => buildManifest(input), /unsafe manifest/i);
  input.settings.includeUncleared = false;
  input.settings.allowUnresolved = false;
  input.settings.embedRightsLabels = true;
  const good = validateCut({ cut: input.cut, assets: input.assets, credits: input.credits, exportSettings: input.settings });
  assert.equal(good.ok, true);
  assert.deepEqual(good.issues, []);
  assert.deepEqual(good.safety.blockers, []);
  assert.equal(bad.ok, false);
  assert.equal(checkExportSafety(input.settings, bad).safe, true);
  assert.equal(validateProduction(production({
    exportSettings: input.settings, ok: bad.ok, safety: bad.safety, issues: bad.issues,
  })).ok, true);
  input.validation = bad;
  assert.equal(buildManifest(input).validation.ok, true);

  const editorialCut = { scenes: [scene({ assetId: 'frame-hands' })] };
  const publicSettings = { distribution: 'public' };
  const publicResult = validateCut({ cut: editorialCut, assets: ASSETS, credits: CREDITS, exportSettings: publicSettings });
  assert.equal(publicResult.ok, false);
  assert.equal(checkExportSafety({ distribution: 'internal-review' }, publicResult).safe, true);
  const internalResult = validateCut({ cut: editorialCut, assets: ASSETS, credits: CREDITS, exportSettings: {} });
  assert.equal(internalResult.ok, true);
  assert.equal(internalResult.issues.find((issue) => issue.code === 'editorial-rights').severity, 'warning');
  assert.equal(buildManifest(manifestInput({ cut: editorialCut })).validation.ok, true);
});

test('download revalidates current scenes instead of trusting a previously successful check', () => {
  const input = manifestInput();
  input.validation = validateCut({ cut: input.cut, assets: input.assets, credits: input.credits });
  assert.equal(input.validation.ok, true);
  input.cut.scenes[0].cueAssetId = 'gone';
  assert.throws(() => buildManifest(input), /gone/);
  input.cut.scenes[0].cueAssetId = 'audio-hum';
  assert.equal(buildManifest(input).validation.ok, true);
  input.cut.duration = NaN;
  assert.throws(() => buildManifest(input), /duration/);
});

test('validateCut and validateProduction preserve parity and structured diagnostics for failures', () => {
  const cases = [
    { scenes: [] },
    { scenes: [scene({ cue: null })] },
    { scenes: [scene({ cueTime: '00:10' })] },
    { scenes: [scene({ end: NaN })] },
    { scenes: [scene({ start: 10, end: 20 }), scene()] },
    { scenes: [scene(), scene({ id: 'nested', start: 2, end: 5 })] },
    { scenes: [scene()], duration: NaN },
    { scenes: [scene({ start: 1 })], duration: 12 },
  ];
  for (const cut of cases) {
    for (const exportSettings of [{}, { includeUncleared: true }]) {
      const result = validateCut({ cut, assets: ASSETS, credits: CREDITS, exportSettings });
      assert.deepEqual(result, validateProduction({
        scenes: cut.scenes, duration: cut.duration, assets: ASSETS, credits: CREDITS, exportSettings,
      }));
      for (const field of ['errors', 'warnings', 'issues', 'timingGaps', 'outOfOrder', 'missingCues', 'cueTimingIssues', 'durationIssues']) {
        assert.ok(Array.isArray(result[field]), field);
      }
      assert.equal(typeof result.ok, 'boolean');
      assert.equal(typeof result.safety.safe, 'boolean');
      for (const issue of result.issues) {
        assert.equal(typeof issue.code, 'string');
        assert.ok(['error', 'warning'].includes(issue.severity));
        assert.equal(typeof issue.message, 'string');
        assert.ok(issue.message.length > 0);
        assert.ok(Array.isArray(issue.sceneIds));
        assert.ok(issue.sceneIds.every((id) => typeof id === 'string'));
      }
    }
  }
  assert.equal(checkExportSafety({}, { ok: false, issues: [{ severity: 'warning', message: 'Review' }] }).safe, false);
  assert.equal(checkExportSafety({}, { issues: [{ code: 'cue-timing', severity: 'error', message: 'Fix the cue' }] }).safe, false);
});

test('invalid credit records do not create duplicate-credit findings', () => {
  const credits = [null, {}, { name: ' ', role: ' ' }, { name: 42, role: 'Voice' }];
  const result = validateProduction(production({ credits }));
  assert.deepEqual(findDuplicateCredits(credits), []);
  assert.equal(result.duplicateCredits.length, 0);
  assert.equal(result.invalidCredits.length, credits.length);
  assert.match(result.errors.join('; '), /non-empty name and role/i);
});

test('stable shared-scene credit IDs merge once instead of blocking as duplicates', () => {
  const shared = { id: 'credit-shared-editor', name: 'Ari Vale', role: 'Editorial review' };
  const credits = [
    { ...shared, sceneIds: ['s01'] },
    { ...shared, sceneIds: ['s02', 'p02'] },
  ];
  assert.deepEqual(findDuplicateCredits(credits), []);
  const manifest = buildManifest(manifestInput({ credits }));
  assert.equal(manifest.credits.length, 1);
  assert.deepEqual(manifest.credits[0].sceneIds, ['s01', 's02', 'p02']);
});

test('same credit name and role with different IDs remains an actionable duplicate', () => {
  const credits = [
    { id: 'credit-one', name: 'Ari Vale', role: 'Editorial review' },
    { id: 'credit-two', name: ' ari  vale ', role: 'EDITORIAL REVIEW' },
  ];
  const result = validateProduction(production({ credits }));
  assert.equal(result.ok, false);
  assert.equal(result.duplicateCredits.length, 1);
  assert.match(result.issues.find((issue) => issue.code === 'duplicate-credit').message, /duplicate credit/i);
  assert.throws(() => buildManifest(manifestInput({ credits })), /duplicate credit/i);
});

test('manifest exports alternate-cut timing warnings and rights labels without bypassing active-cut safety', () => {
  const alternate = structuredClone(CUTS.pulse);
  alternate.scenes[1].start = 25;
  alternate.scenes[1].cueTime = '00:25';
  const manifest = buildManifest({
    project: 'The last signal',
    cutKey: 'quiet',
    cut: structuredClone(CUTS.quiet),
    assets: structuredClone(ASSETS),
    credits: structuredClone(CREDITS),
    alternateCuts: { pulse: alternate },
  });
  assert.equal(manifest.safety.safe, true);
  assert.equal(manifest.settings.includeUncleared, false);
  assert.equal(manifest.settings.allowUnresolved, false);
  assert.equal(manifest.validation.rightsLabelsEmbedded, true);
  assert.ok(manifest.rightsLabels.every((entry) => entry.label));
  assert.equal(manifest.alternateCuts.length, 1);
  assert.equal(manifest.alternateCuts[0].status, 'review');
  assert.equal(manifest.alternateCuts[0].warnings.some((issue) => issue.code === 'timing-gap'), true);
  assert.ok(manifest.alternateCuts[0].rightsLabels.every((entry) => entry.label));
  assert.equal(manifest.validation.alternateCutWarnings[0].timingGaps.length, 1);
});
