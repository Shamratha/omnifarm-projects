import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deserializeStoryboard,
  exportKml,
  exportWebVtt,
  serializeStoryboard,
} from './storyboardFiles.js';
import { totalDurationSeconds, validateTour } from './tourModel.js';

const DEFAULT_CAMERA = {
  lat: 48.8566,
  lng: 2.3522,
  altitude: 250,
  zoom: 1.25,
  bearing: 0,
  tilt: 12,
};

function makeScene(id, overrides = {}) {
  const { camera: cameraOverride, ...sceneOverrides } = overrides;
  return {
    id,
    title: `Scene ${id}`,
    caption: `Caption ${id}`,
    duration: 10,
    camera: cameraOverride === undefined ? { ...DEFAULT_CAMERA } : cameraOverride,
    ...sceneOverrides,
  };
}

function makeTour(scenes = [makeScene('one')], overrides = {}) {
  return {
    title: 'Museum tour',
    subtitle: 'A route through the city',
    scenes,
    ...overrides,
  };
}

function exportIssues(exporter, tour) {
  let issues;
  assert.throws(() => exporter(tour), (error) => {
    assert.ok(Array.isArray(error.issues), 'export error should expose validation issues');
    assert.ok(error.issues.length > 0, 'export error should explain why delivery is blocked');
    issues = error.issues;
    return true;
  }, `${exporter.name} should reject the tour`);
  return issues;
}

function assertBothExportsReject(tour, expectedCode) {
  for (const exporter of [exportKml, exportWebVtt]) {
    const issues = exportIssues(exporter, tour);
    assert.ok(
      issues.some((issue) => issue.code === expectedCode),
      `${exporter.name} should report ${expectedCode}`,
    );
  }
}

function assertInvalidStoryboard(text) {
  assert.throws(
    () => deserializeStoryboard(text),
    (error) => error.code === 'invalid_storyboard',
  );
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('JSON roundtrip preserves scene order, values, camera altitude, and caption timing', () => {
  const tour = makeTour([
    makeScene('second', {
      title: 'Second stop',
      caption: 'A second caption',
      duration: 4.75,
      camera: { ...DEFAULT_CAMERA, lat: -12.5, lng: 179.75, altitude: 4321.5, bearing: 270, tilt: 33 },
      captionTiming: { start: 0.5, end: 4.25 },
    }),
    makeScene('first', {
      title: 'First stop',
      caption: 'A first caption',
      duration: 2.25,
      camera: { ...DEFAULT_CAMERA, lat: 0, lng: -179.5, altitude: 1 },
    }),
  ]);

  const restored = deserializeStoryboard(serializeStoryboard(tour));

  assert.deepEqual(restored, { ...tour, schemaVersion: 2 });
  assert.deepEqual(validateTour(restored), []);
  assert.deepEqual(restored.scenes.map((scene) => scene.id), ['second', 'first']);
  assert.equal(restored.scenes[0].camera.altitude, 4321.5);
  assert.deepEqual(restored.scenes[0].captionTiming, { start: 0.5, end: 4.25 });
});

test('deserialization preserves invalid drafts for editor validation and export rejects them', () => {
  const drafts = [
    { scene: makeScene('missing-coordinates', { camera: { altitude: 250 } }), code: 'missing_coordinates' },
    {
      scene: makeScene('null-coordinates', { camera: { lat: null, lng: null, altitude: 250 } }),
      code: 'missing_coordinates',
    },
    { scene: makeScene('zero-duration', { duration: 0 }), code: 'invalid_duration' },
    {
      scene: makeScene('negative-altitude', { camera: { ...DEFAULT_CAMERA, altitude: -1 } }),
      code: 'invalid_altitude',
    },
  ];

  for (const { scene, code } of drafts) {
    const draft = makeTour([scene]);
    const restored = deserializeStoryboard(serializeStoryboard(draft));
    const expectedCamera = { ...DEFAULT_CAMERA, lat: null, lng: null, ...scene.camera };
    assert.deepEqual(restored.scenes, [{ ...scene, camera: expectedCamera }]);
    assert.ok(validateTour(restored).some((issue) => issue.code === code));
    assertBothExportsReject(restored, code);
  }

  const overlap = makeTour([
    makeScene('spilling', { duration: 10, captionTiming: { start: 5, end: 12 } }),
    makeScene('following', { duration: 10, captionTiming: { start: 0, end: 5 } }),
  ]);
  const restoredOverlap = deserializeStoryboard(serializeStoryboard(overlap));
  assert.deepEqual(restoredOverlap.scenes, overlap.scenes);
  assert.ok(validateTour(restoredOverlap).some((issue) => issue.code === 'caption_overlap'));
  assertBothExportsReject(restoredOverlap, 'caption_overlap');
});

test('legacy and version 2 missing camera data receive only their intended defaults', () => {
  const legacyMissingAltitude = deserializeStoryboard(JSON.stringify({
    title: 'Legacy',
    scenes: [{
      id: 'legacy-altitude',
      title: 'Legacy scene',
      caption: 'Caption',
      duration: 1,
      camera: { lat: 48, lng: 2 },
    }],
  }));
  assert.equal(legacyMissingAltitude.scenes[0].camera.altitude, 250);
  assert.doesNotThrow(() => exportKml(legacyMissingAltitude));

  const legacyExplicitAltitude = deserializeStoryboard(JSON.stringify({
    title: 'Legacy',
    scenes: [{
      id: 'legacy-explicit-altitude',
      title: 'Legacy scene',
      caption: 'Caption',
      duration: 1,
      camera: { lat: 48, lng: 2, altitude: 987.5 },
    }],
  }));
  assert.equal(legacyExplicitAltitude.scenes[0].camera.altitude, 987.5);
  assert.match(exportKml(legacyExplicitAltitude), /<altitude>987\.5<\/altitude>/);

  const legacy = deserializeStoryboard(JSON.stringify({
    title: 'Legacy',
    scenes: [{ id: 'legacy-scene', title: 'Legacy scene', caption: 'Caption', duration: 1 }],
  }));
  assert.equal(legacy.schemaVersion, 2);
  assert.deepEqual(legacy.scenes[0].camera, {
    lat: null,
    lng: null,
    altitude: 250,
    zoom: 1.25,
    bearing: 0,
    tilt: 12,
  });
  const legacyIssues = exportIssues(exportKml, legacy);
  assert.ok(legacyIssues.some((issue) => issue.field === 'camera.lat'));
  assert.ok(legacyIssues.some((issue) => issue.field === 'camera.lng'));
  assert.ok(!legacyIssues.some((issue) => issue.code === 'invalid_altitude'));

  const v2MissingCamera = deserializeStoryboard(JSON.stringify({
    schemaVersion: 2,
    title: 'Current',
    scenes: [{ id: 'v2-scene', title: 'Current scene', caption: 'Caption', duration: 1 }],
  }));
  assert.deepEqual(v2MissingCamera.scenes[0].camera, {
    lat: null,
    lng: null,
    altitude: null,
    zoom: 1.25,
    bearing: 0,
    tilt: 12,
  });
  const v2Issues = exportIssues(exportKml, v2MissingCamera);
  assert.ok(v2Issues.some((issue) => issue.field === 'camera.lat'));
  assert.ok(v2Issues.some((issue) => issue.field === 'camera.lng'));
  assert.ok(v2Issues.some((issue) => issue.code === 'invalid_altitude'));

  const v2MissingCoordinates = deserializeStoryboard(JSON.stringify({
    schemaVersion: 2,
    title: 'Current',
    scenes: [{
      id: 'v2-coordinates',
      title: 'Current scene',
      caption: 'Caption',
      duration: 1,
      camera: { altitude: 250 },
    }],
  }));
  assert.deepEqual(v2MissingCoordinates.scenes[0].camera, {
    lat: null,
    lng: null,
    altitude: 250,
    zoom: 1.25,
    bearing: 0,
    tilt: 12,
  });
  const coordinateIssues = exportIssues(exportKml, v2MissingCoordinates);
  assert.ok(coordinateIssues.every((issue) => issue.code !== 'invalid_altitude'));
  assert.equal(coordinateIssues.filter((issue) => issue.field === 'camera.lat' || issue.field === 'camera.lng').length, 2);

  const v2MissingAltitude = deserializeStoryboard(JSON.stringify({
    schemaVersion: 2,
    title: 'Current',
    scenes: [{
      id: 'v2-altitude',
      title: 'Current scene',
      caption: 'Caption',
      duration: 1,
      camera: { lat: 48, lng: 2 },
    }],
  }));
  const altitudeIssues = exportIssues(exportKml, v2MissingAltitude);
  assert.ok(altitudeIssues.some((issue) => issue.code === 'invalid_altitude'));
  assert.equal(altitudeIssues.filter((issue) => issue.field === 'camera.lat' || issue.field === 'camera.lng').length, 0);
});

test('malformed JSON, duplicate ids, and unsafe structural shapes reject', () => {
  assert.throws(
    () => deserializeStoryboard('{"title":"broken"'),
    (error) => error.code === 'invalid_json',
  );

  assertInvalidStoryboard(JSON.stringify(makeTour([
    makeScene('same'),
    makeScene('same'),
  ])));

  for (const value of [
    'null',
    '[]',
    JSON.stringify({ title: 'Tour', scenes: {} }),
    JSON.stringify({ title: 'Tour', scenes: [null] }),
    JSON.stringify({ title: 'Tour', scenes: [[]] }),
    JSON.stringify({ title: 'Tour', scenes: [makeScene('bad-camera', { camera: [] })] }),
    JSON.stringify({ title: 'Tour', scenes: [makeScene('bad-duration', { duration: {} })] }),
    JSON.stringify({ title: 'Tour', scenes: [makeScene('bad-timing', { captionTiming: [] })] }),
  ]) {
    assertInvalidStoryboard(value);
  }
});

test('KML uses XML escaping, required namespaces, and camera fields in metres AGL', () => {
  const tour = makeTour([
    makeScene('quoted', {
      title: `Stop & <"quoted">`,
      caption: `Rock & roll <now> "today" 'again'`,
      camera: {
        lat: 48.1,
        lng: -2.3,
        altitude: 4321.5,
        zoom: 1.4,
        bearing: 271.25,
        tilt: 18.5,
      },
    }),
  ], { title: `Tour & <Main> "Today" 'Now'` });

  const kml = exportKml(tour);

  assert.match(kml, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2" xmlns:gx="http:\/\/www\.google\.com\/kml\/ext\/2\.2">/);
  assert.match(kml, /<name>Tour &amp; &lt;Main&gt; &quot;Today&quot; &apos;Now&apos;<\/name>/);
  assert.match(kml, /<name>Stop &amp; &lt;&quot;quoted&quot;&gt;<\/name>/);
  assert.match(kml, /<description>Rock &amp; roll &lt;now&gt; &quot;today&quot; &apos;again&apos;<\/description>/);
  assert.match(kml, /<longitude>-2\.3<\/longitude>/);
  assert.match(kml, /<latitude>48\.1<\/latitude>/);
  assert.match(kml, /<altitude>4321\.5<\/altitude>/);
  assert.match(kml, /<heading>271\.25<\/heading>/);
  assert.match(kml, /<tilt>18\.5<\/tilt>/);
  assert.match(kml, /<altitudeMode>relativeToGround<\/altitudeMode>/);
});

test('scene reordering changes KML and WebVTT order', () => {
  const first = makeScene('first', {
    title: 'First',
    caption: 'FIRST',
    duration: 3,
    camera: { ...DEFAULT_CAMERA, lng: 1.1 },
  });
  const second = makeScene('second', {
    title: 'Second',
    caption: 'SECOND',
    duration: 7,
    camera: { ...DEFAULT_CAMERA, lng: 2.2 },
  });
  const original = makeTour([first, second]);
  const reordered = makeTour([second, first]);

  const originalKml = exportKml(original);
  const reorderedKml = exportKml(reordered);
  const originalVtt = exportWebVtt(original);
  const reorderedVtt = exportWebVtt(reordered);

  assert.notEqual(originalKml, reorderedKml);
  assert.ok(originalKml.indexOf('<name>First</name>') < originalKml.indexOf('<name>Second</name>'));
  assert.ok(reorderedKml.indexOf('<name>Second</name>') < reorderedKml.indexOf('<name>First</name>'));
  assert.ok(originalKml.indexOf('<longitude>1.1</longitude>') < originalKml.indexOf('<longitude>2.2</longitude>'));
  assert.ok(reorderedKml.indexOf('<longitude>2.2</longitude>') < reorderedKml.indexOf('<longitude>1.1</longitude>'));
  assert.notEqual(originalVtt, reorderedVtt);
  assert.ok(originalVtt.indexOf('\nFIRST\n') < originalVtt.indexOf('\nSECOND\n'));
  assert.ok(reorderedVtt.indexOf('\nSECOND\n') < reorderedVtt.indexOf('\nFIRST\n'));
  assert.match(originalVtt, /00:00:00\.000 --> 00:00:03\.000\nFIRST/);
  assert.match(reorderedVtt, /00:00:00\.000 --> 00:00:07\.000\nSECOND/);
});

test('KML emits FlyTo zero durations and Wait durations totaling visible scene time', () => {
  const tour = makeTour([
    makeScene('one', { duration: 1.25 }),
    makeScene('two', { duration: 2.75 }),
    makeScene('three', { duration: 6 }),
  ]);
  const kml = exportKml(tour);
  const flyToDurations = [...kml.matchAll(/<gx:FlyTo>[\s\S]*?<gx:duration>([^<]+)<\/gx:duration>/g)]
    .map((match) => Number(match[1]));
  const waitDurations = [...kml.matchAll(/<gx:Wait>[\s\S]*?<gx:duration>([^<]+)<\/gx:duration>/g)]
    .map((match) => Number(match[1]));

  assert.deepEqual(flyToDurations, [0, 0, 0]);
  assert.deepEqual(waitDurations, [1.25, 2.75, 6]);
  assert.equal(waitDurations.reduce((total, duration) => total + duration, 0), totalDurationSeconds(tour.scenes));
});

test('WebVTT preserves fractional milliseconds, carries minutes, and supports hours over 24', () => {
  const tour = makeTour([
    makeScene('day', { caption: '', duration: 172800.125 }),
    makeScene('late', {
      duration: 61,
      caption: 'Late caption',
      captionTiming: { start: 59.9996, end: 60.0006 },
    }),
  ]);

  const vtt = exportWebVtt(tour);

  assert.equal(countMatches(vtt, /^\d+$/gm), 1);
  assert.match(vtt, /48:01:00\.125 --> 48:01:00\.126\nLate caption/);
});

test('single-scene KML and WebVTT exports contain one scene and one cue', () => {
  const tour = makeTour([makeScene('only', {
    title: 'Only scene',
    caption: 'Only caption',
    duration: 3.5,
  })]);

  const kml = exportKml(tour);
  const vtt = exportWebVtt(tour);

  assert.equal(countMatches(kml, /<gx:FlyTo>/g), 1);
  assert.equal(countMatches(kml, /<gx:Wait>/g), 1);
  assert.equal(countMatches(kml, /<Placemark>/g), 1);
  assert.equal(countMatches(vtt, /^1$/gm), 1);
  assert.match(vtt, /00:00:00\.000 --> 00:00:03\.500\nOnly caption/);
});

test('KML preserves signed antimeridian longitude values', () => {
  const east = makeTour([makeScene('east', {
    camera: { ...DEFAULT_CAMERA, lng: 179.75 },
  })]);
  const west = makeTour([makeScene('west', {
    camera: { ...DEFAULT_CAMERA, lng: -179.75 },
  })]);

  assert.match(exportKml(east), /<longitude>179\.75<\/longitude>/);
  assert.match(exportKml(west), /<longitude>-179\.75<\/longitude>/);
});

test('empty captions omit cues but still advance the next caption by prior duration', () => {
  const vtt = exportWebVtt(makeTour([
    makeScene('silent', { caption: '  \n\t', duration: 5 }),
    makeScene('spoken', { caption: 'Next caption', duration: 2 }),
  ]));

  assert.equal(countMatches(vtt, /^\d+$/gm), 1);
  assert.doesNotMatch(vtt, /silent/);
  assert.match(vtt, /00:00:05\.000 --> 00:00:07\.000\nNext caption/);
});

test('caption offsets are honored on the cumulative scene timeline', () => {
  const vtt = exportWebVtt(makeTour([
    makeScene('offset', {
      duration: 10,
      caption: 'Offset caption',
      captionTiming: { start: 2.25, end: 7.5 },
    }),
  ]));

  assert.match(vtt, /00:00:02\.250 --> 00:00:07\.500\nOffset caption/);
});

test('invalid coordinates, altitude, duration, and caption overlap block both delivery formats', () => {
  const cases = [
    {
      code: 'missing_coordinates',
      tour: makeTour([makeScene('missing', { camera: { altitude: 250 } })]),
    },
    {
      code: 'missing_coordinates',
      tour: makeTour([makeScene('bad-coordinate', { camera: { lat: null, lng: 0, altitude: 250 } })]),
    },
    {
      code: 'invalid_altitude',
      tour: makeTour([makeScene('bad-altitude', { camera: { ...DEFAULT_CAMERA, altitude: 100001 } })]),
    },
    {
      code: 'invalid_duration',
      tour: makeTour([makeScene('bad-duration', { duration: -0.1 })]),
    },
    {
      code: 'caption_overlap',
      tour: makeTour([
        makeScene('overlap-one', { duration: 10, captionTiming: { start: 5, end: 12 } }),
        makeScene('overlap-two', { duration: 10, captionTiming: { start: 0, end: 5 } }),
      ]),
    },
  ];

  for (const { code, tour } of cases) assertBothExportsReject(tour, code);
});

test('inclusive altitude limits and positive durations are exportable', () => {
  const tour = makeTour([
    makeScene('minimums', {
      duration: 0.001,
      camera: { ...DEFAULT_CAMERA, altitude: 1 },
    }),
    makeScene('maximums', {
      duration: 2,
      camera: { ...DEFAULT_CAMERA, altitude: 100000 },
    }),
  ]);

  assert.doesNotThrow(() => exportKml(tour));
  assert.doesNotThrow(() => exportWebVtt(tour));
});

test('exporters and serializer do not mutate a storyboard draft', () => {
  const tour = makeTour([
    makeScene('one', { captionTiming: { start: 1, end: 4 } }),
    makeScene('two', { caption: 'Second\nline', duration: 3.25 }),
  ]);
  const before = structuredClone(tour);
  deepFreeze(tour);

  serializeStoryboard(tour);
  exportKml(tour);
  exportWebVtt(tour);

  assert.deepEqual(tour, before);
});

test('WebVTT reports an error when caption timing loses all duration at millisecond precision', () => {
  const tour = makeTour([makeScene('too-short', {
    duration: 1,
    captionTiming: { start: 0.0001, end: 0.0002 },
  })]);

  const issues = exportIssues(exportWebVtt, tour);
  assert.deepEqual(issues.map((issue) => issue.code), ['caption_precision_loss']);
  assert.equal(issues[0].sceneId, 'too-short');
  assert.equal(issues[0].sceneIndex, 0);
});
