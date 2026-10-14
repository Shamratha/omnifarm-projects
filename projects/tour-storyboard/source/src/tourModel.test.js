import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_ALTITUDE_MAX,
  CAMERA_ALTITUDE_MIN,
  DEFAULT_CAMERA_ALTITUDE,
  cameraAtTime,
  captionInterval,
  haversineDistanceMeters,
  isFiniteNumber,
  routeDistanceMeters,
  sceneAtTime,
  sceneStartSeconds,
  totalDurationSeconds,
  validCoordinates,
  validateTour,
} from './tourModel.js';

function makeScene(id = 'scene-1', overrides = {}) {
  const { camera: cameraOverride, ...sceneOverrides } = overrides;
  return {
    id,
    title: `Scene ${id}`,
    caption: `Caption ${id}`,
    duration: 10,
    camera: cameraOverride === undefined
      ? { lat: 0, lng: 0, altitude: DEFAULT_CAMERA_ALTITUDE }
      : cameraOverride,
    ...sceneOverrides,
  };
}

function makeTour(scenes = [makeScene()]) {
  return { title: 'A tour', scenes };
}

function hasCode(errors, code) {
  return errors.some((error) => error.code === code);
}

test('exports camera altitude constants and keeps number validation strict', () => {
  assert.equal(CAMERA_ALTITUDE_MIN, 1);
  assert.equal(CAMERA_ALTITUDE_MAX, 100000);
  assert.equal(DEFAULT_CAMERA_ALTITUDE, 250);

  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(-12.5), true);
  for (const value of ['', '12', '   ', null, undefined, NaN, Infinity, -Infinity, true, [], {}, new Number(2)]) {
    assert.equal(isFiniteNumber(value), false, `expected ${String(value)} to be rejected`);
  }
});

test('validCoordinates accepts zero and inclusive boundaries without coercion', () => {
  assert.equal(validCoordinates({ lat: 0, lng: 0 }), true);
  assert.equal(validCoordinates({ lat: -90, lng: -180 }), true);
  assert.equal(validCoordinates({ lat: 90, lng: 180 }), true);

  for (const value of [undefined, null, '', '0', NaN, Infinity, -Infinity, true]) {
    assert.equal(validCoordinates({ lat: value, lng: 0 }), false);
    assert.equal(validCoordinates({ lat: 0, lng: value }), false);
  }
  for (const lat of [-90.0001, 90.0001]) assert.equal(validCoordinates({ lat, lng: 0 }), false);
  for (const lng of [-180.0001, 180.0001]) assert.equal(validCoordinates({ lat: 0, lng }), false);
  assert.equal(validCoordinates(null), false);
  assert.equal(validCoordinates({}), false);
});

test('haversine distance handles known, wrapped, polar, and antipodal coordinates', () => {
  const london = { lat: 51.5074, lng: -0.1278 };
  const newYork = { lat: 40.7128, lng: -74.006 };
  const londonNewYork = haversineDistanceMeters(london, newYork);
  assert.ok(londonNewYork > 5_550_000 && londonNewYork < 5_590_000);

  const eastAcrossDateLine = haversineDistanceMeters({ lat: 0, lng: 179 }, { lat: 0, lng: -179 });
  const westAcrossDateLine = haversineDistanceMeters({ lat: 0, lng: -179 }, { lat: 0, lng: 179 });
  assert.ok(Math.abs(eastAcrossDateLine - 222390.16) < 1);
  assert.ok(Math.abs(westAcrossDateLine - 222390.16) < 1);

  assert.equal(haversineDistanceMeters({ lat: 45, lng: 180 }, { lat: 45, lng: -180 }), 0);
  assert.equal(haversineDistanceMeters({ lat: 45, lng: -180 }, { lat: 45, lng: 180 }), 0);
  assert.ok(haversineDistanceMeters({ lat: 90, lng: 0 }, { lat: 90, lng: 120 }) < 1e-6);
  assert.ok(haversineDistanceMeters({ lat: -90, lng: 0 }, { lat: -90, lng: 120 }) < 1e-6);
  assert.equal(haversineDistanceMeters({ lat: 12, lng: 34 }, { lat: 12, lng: 34 }), 0);
  const antipodal = haversineDistanceMeters({ lat: 90, lng: 0 }, { lat: -90, lng: 0 });
  const nearlyAntipodal = haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 0.000001, lng: 179.999999 });
  assert.ok(Math.abs(antipodal - 20_015_114.442) < 1);
  assert.ok(Number.isFinite(nearlyAntipodal) && nearlyAntipodal <= antipodal);
  assert.equal(haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: '0', lng: 1 }), null);
});

test('route distance sums only consecutive camera points and validates every point', () => {
  const first = makeScene('first', { camera: { lat: 0, lng: 0, altitude: 250 } });
  const second = makeScene('second', { camera: { lat: 0, lng: 1, altitude: 250 } });
  const third = makeScene('third', { camera: { lat: 1, lng: 1, altitude: 250 } });
  const firstLeg = haversineDistanceMeters(first.camera, second.camera);
  const secondLeg = haversineDistanceMeters(second.camera, third.camera);

  assert.equal(routeDistanceMeters([]), 0);
  assert.equal(routeDistanceMeters([first]), 0);
  assert.ok(Math.abs(routeDistanceMeters([first, second, third]) - (firstLeg + secondLeg)) < 1e-6);
  assert.ok(Math.abs(routeDistanceMeters([third, second, first]) - (secondLeg + firstLeg)) < 1e-6);
  assert.equal(routeDistanceMeters([first, second]), firstLeg);
  assert.ok(Math.abs(routeDistanceMeters([first, second, third]) - 222390.16) < 1);
  const eastAcrossDateLine = [
    makeScene('east-one', { camera: { lat: 0, lng: 179, altitude: 250 } }),
    makeScene('east-two', { camera: { lat: 0, lng: -179, altitude: 250 } }),
  ];
  const westAcrossDateLine = [...eastAcrossDateLine].reverse();
  assert.ok(Math.abs(routeDistanceMeters(eastAcrossDateLine) - 222390.16) < 1);
  assert.ok(Math.abs(routeDistanceMeters(westAcrossDateLine) - 222390.16) < 1);
  assert.equal(routeDistanceMeters([makeScene('bad', { camera: { lat: 91, lng: 0, altitude: 250 } })]), null);
  assert.equal(routeDistanceMeters([makeScene('bad', { camera: { lat: 0, lng: '1', altitude: 250 } })]), null);
  assert.equal(routeDistanceMeters(null), null);
});

test('totalDurationSeconds requires every duration to be a positive finite number', () => {
  const scenes = [makeScene('one', { duration: 2 }), makeScene('two', { duration: 3.5 })];
  assert.equal(totalDurationSeconds([]), 0);
  assert.equal(totalDurationSeconds([scenes[1]]), 3.5);
  assert.equal(totalDurationSeconds(scenes), 5.5);

  for (const duration of [0, -1, '3', '', null, NaN, Infinity, -Infinity]) {
    assert.equal(totalDurationSeconds([makeScene('bad', { duration })]), null, `duration ${String(duration)} should fail`);
  }
  assert.equal(totalDurationSeconds([null]), null);
  assert.equal(totalDurationSeconds(null), null);
});

test('sceneStartSeconds stops when the requested scene is found', () => {
  const scenes = [
    makeScene('first', { duration: 10 }),
    makeScene('target', { duration: 20 }),
    makeScene('invalid-later', { duration: Infinity }),
  ];

  assert.equal(sceneStartSeconds(scenes, 'first'), 0);
  assert.equal(sceneStartSeconds(scenes, 'target'), 10);
  assert.equal(sceneStartSeconds([makeScene('target', { duration: NaN }), null], 'target'), 0);
  assert.equal(sceneStartSeconds([makeScene('bad', { duration: NaN }), makeScene('target')], 'target'), null);
  assert.equal(sceneStartSeconds([], 'target'), null);
  assert.equal(sceneStartSeconds([scenes[0], makeScene('target'), null], 'target'), 10);
  assert.equal(sceneStartSeconds(scenes, 'missing'), null);
  assert.equal(sceneStartSeconds([makeScene('bad', { duration: 0 })], 'missing'), null);
  assert.equal(sceneStartSeconds(null, 'first'), null);
});

test('sceneAtTime uses half-open intervals and remains safe for invalid time drafts', () => {
  const first = makeScene('first', { duration: 10 });
  const second = makeScene('second', { duration: 20 });
  const third = makeScene('third', { duration: 30 });
  const scenes = [first, second, third];

  assert.equal(sceneAtTime(scenes, 0), first);
  assert.equal(sceneAtTime(scenes, 9.999), first);
  assert.equal(sceneAtTime(scenes, 10), second);
  assert.equal(sceneAtTime(scenes, 30), third);
  assert.equal(sceneAtTime(scenes, 60), null);
  assert.equal(sceneAtTime(scenes, 61), null);
  assert.equal(sceneAtTime([], 0), null);
  for (const time of [-0.1, NaN, Infinity, -Infinity, '10', '', null, undefined]) {
    assert.equal(sceneAtTime(scenes, time), null);
  }
  assert.equal(sceneAtTime([first, makeScene('bad', { duration: '20' })], 10), null);
  assert.equal(sceneAtTime(null, 0), null);
});

test('cameraAtTime returns keyframes, interpolates every camera field, and holds the final scene', () => {
  const first = makeScene('first', {
    duration: 10,
    camera: { lat: 0, lng: 20, altitude: 100, zoom: 1, bearing: 350, tilt: 0 },
  });
  const second = makeScene('second', {
    duration: 10,
    camera: { lat: 10, lng: 40, altitude: 300, zoom: 2, bearing: 10, tilt: 20 },
  });
  const scenes = [first, second];

  assert.deepEqual(cameraAtTime(scenes, 0), first.camera);
  assert.deepEqual(cameraAtTime(scenes, 10), second.camera);
  assert.deepEqual(cameraAtTime(scenes, 5), {
    lat: 5,
    lng: 30,
    altitude: 200,
    zoom: 1.5,
    bearing: 0,
    tilt: 10,
  });
  assert.deepEqual(cameraAtTime(scenes, 15), second.camera);
  assert.deepEqual(cameraAtTime(scenes, 20), second.camera);
});

test('cameraAtTime supports a single scene and follows the shortest antimeridian path', () => {
  const only = makeScene('only', {
    duration: 10,
    camera: { lat: 12, lng: 34, altitude: 250, bearing: 360 },
  });
  assert.deepEqual(cameraAtTime([only], 5), {
    lat: 12,
    lng: 34,
    altitude: 250,
    bearing: 0,
  });

  const eastAcrossDateLine = [
    makeScene('east-one', { duration: 10, camera: { lat: 0, lng: 179, altitude: 250 } }),
    makeScene('east-two', { duration: 10, camera: { lat: 0, lng: -179, altitude: 250 } }),
  ];
  assert.equal(cameraAtTime(eastAcrossDateLine, 5).lng, 180);
  assert.equal(cameraAtTime(eastAcrossDateLine, 7.5).lng, -179.5);
});

test('cameraAtTime rejects malformed timelines and cameras without mutating scenes', () => {
  const scenes = [
    makeScene('one', { camera: { lat: 0, lng: 0, altitude: 250 } }),
    makeScene('two', { camera: { lat: 1, lng: 1, altitude: 500 } }),
  ];
  const before = structuredClone(scenes);
  assert.deepEqual(cameraAtTime(scenes, 5), { lat: 0.5, lng: 0.5, altitude: 375 });
  assert.deepEqual(scenes, before);

  for (const time of [-1, NaN, Infinity, -Infinity, '5', null, undefined]) {
    assert.equal(cameraAtTime(scenes, time), null);
  }
  assert.equal(cameraAtTime(null, 0), null);
  assert.equal(cameraAtTime([], 0), null);
  for (const duration of [0, -1, NaN, Infinity, '10', null, undefined]) {
    assert.equal(cameraAtTime([makeScene('bad-duration', { duration })], 0), null);
  }
  for (const camera of [undefined, null, [], { lng: 0, altitude: 250 }, { lat: 0, lng: 0 }, { lat: 91, lng: 0, altitude: 250 }, { lat: 0, lng: 0, altitude: 0 }]) {
    const scene = makeScene('bad-camera');
    scene.camera = camera;
    assert.equal(cameraAtTime([scene], 0), null);
  }
});

test('captionInterval uses strict offsets and automatic end timing', () => {
  const scene = makeScene('caption', { duration: 20 });
  assert.deepEqual(captionInterval(scene), { start: 0, end: 20 });
  assert.deepEqual(captionInterval(scene, 100), { start: 100, end: 120 });
  assert.deepEqual(
    captionInterval({ ...scene, captionTiming: { start: 3, end: 7 } }, 100),
    { start: 103, end: 107 },
  );
  assert.deepEqual(
    captionInterval({ ...scene, captionTiming: { start: 3 } }, 100),
    { start: 103, end: 120 },
  );
  assert.deepEqual(
    captionInterval({ ...scene, captionTiming: { start: 3, end: null } }, 100),
    { start: 103, end: 120 },
  );
  assert.equal(captionInterval({ ...scene, captionTiming: { start: '3', end: 7 } }), null);
  assert.equal(captionInterval({ ...scene, captionTiming: { start: 3, end: Infinity } }), null);
  assert.equal(captionInterval(scene, '100'), null);
  assert.equal(captionInterval(null), null);
});

test('captionInterval defaults individual offsets and safely rejects malformed timing', () => {
  const scene = makeScene('caption', { duration: 20 });
  for (const captionTiming of [undefined, {}, { end: null }]) {
    assert.deepEqual(captionInterval({ ...scene, captionTiming }, 7), { start: 7, end: 27 });
  }
  assert.deepEqual(captionInterval({ ...scene, captionTiming: { end: 5 } }, 7), { start: 7, end: 12 });
  assert.deepEqual(captionInterval({ ...scene, captionTiming: { start: 5, end: 25 } }, 7), { start: 12, end: 32 });
  for (const captionTiming of [null, false, [], 'later', { start: null }, { start: NaN }, { end: '5' }]) {
    assert.equal(captionInterval({ ...scene, captionTiming }), null);
  }
  assert.equal(captionInterval({ ...scene, duration: NaN }), null);
  assert.equal(captionInterval({ ...scene, duration: Number.MAX_VALUE }, Number.MAX_VALUE), null);
});

test('validateTour reports malformed tour and scene shapes without throwing', () => {
  assert.deepEqual(validateTour(null), [
    { code: 'malformed_tour', field: 'tour', message: 'Tour must be an object.' },
  ]);
  assert.ok(hasCode(validateTour({ title: 'Tour', scenes: 'nope' }), 'malformed_scenes'));
  assert.ok(hasCode(validateTour({ title: 'Tour', scenes: [] }), 'no_scenes'));

  const errors = validateTour({ title: 42, scenes: [null, makeScene('valid')] });
  assert.ok(hasCode(errors, 'invalid_title'));
  assert.ok(hasCode(errors, 'malformed_scene'));
  assert.ok(errors.some((error) => error.code === 'malformed_scene' && error.sceneIndex === 0));

  for (const tour of [undefined, 1, '', 'tour', [], false]) {
    assert.ok(hasCode(validateTour(tour), 'malformed_tour'));
  }
  for (const scenes of [undefined, null, {}, '', 0]) {
    assert.ok(hasCode(validateTour({ title: 'Tour', scenes }), 'malformed_scenes'));
  }
  for (const scene of [undefined, [], 0, false, 'scene']) {
    assert.ok(hasCode(validateTour(makeTour([scene])), 'malformed_scene'));
  }
});

test('validateTour distinguishes missing and invalid coordinates, including zero coordinates', () => {
  const missing = makeScene('missing', { camera: { altitude: DEFAULT_CAMERA_ALTITUDE } });
  const zero = makeScene('zero', { camera: { lat: 0, lng: 0, altitude: DEFAULT_CAMERA_ALTITUDE } });
  const invalid = makeScene('invalid', { camera: { lat: NaN, lng: '0', altitude: DEFAULT_CAMERA_ALTITUDE } });
  const outOfRange = makeScene('range', { camera: { lat: 90.1, lng: -180.1, altitude: DEFAULT_CAMERA_ALTITUDE } });

  const zeroErrors = validateTour(makeTour([zero]));
  assert.equal(zeroErrors.length, 0);

  const missingErrors = validateTour(makeTour([missing]));
  assert.ok(missingErrors.some((error) => error.code === 'missing_coordinates' && error.field === 'camera.lat'));
  assert.ok(missingErrors.some((error) => error.code === 'missing_coordinates' && error.field === 'camera.lng'));

  const invalidErrors = validateTour(makeTour([invalid]));
  assert.ok(hasCode(invalidErrors, 'invalid_latitude'));
  assert.ok(hasCode(invalidErrors, 'invalid_longitude'));
  assert.ok(!hasCode(invalidErrors, 'missing_coordinates'));

  const rangeErrors = validateTour(makeTour([outOfRange]));
  assert.ok(hasCode(rangeErrors, 'invalid_latitude'));
  assert.ok(hasCode(rangeErrors, 'invalid_longitude'));
});

test('validateTour checks ids, strings, altitude, duration, and optional camera limits', () => {
  const base = makeScene('same');
  const malformed = {
    ...base,
    id: 'same',
    title: null,
    caption: 5,
    duration: 0,
    camera: {
      lat: 0,
      lng: 0,
      altitude: undefined,
      zoom: 2.6,
      bearing: -1,
      tilt: Infinity,
    },
  };
  const duplicate = makeScene('same');
  const missingId = makeScene('missing-id', { id: '' });
  const errors = validateTour(makeTour([malformed, duplicate, missingId]));

  assert.ok(hasCode(errors, 'missing_id'));
  assert.ok(hasCode(errors, 'duplicate_id'));
  assert.ok(hasCode(errors, 'invalid_title'));
  assert.ok(hasCode(errors, 'invalid_caption'));
  assert.ok(hasCode(errors, 'invalid_altitude'));
  assert.ok(hasCode(errors, 'invalid_duration'));
  assert.ok(hasCode(errors, 'invalid_zoom'));
  assert.ok(hasCode(errors, 'invalid_bearing'));
  assert.ok(hasCode(errors, 'invalid_tilt'));

  for (const altitude of [undefined, null, '', -1, 0, 0.999, CAMERA_ALTITUDE_MAX + 1, '250', NaN, Infinity, -Infinity]) {
    assert.ok(hasCode(validateTour(makeTour([makeScene('altitude', { camera: { lat: 0, lng: 0, altitude } })])), 'invalid_altitude'));
  }
  for (const duration of [undefined, null, '', 0, -1, '10', NaN, Infinity, -Infinity]) {
    assert.ok(hasCode(validateTour(makeTour([makeScene('duration', { duration })])), 'invalid_duration'));
  }
});

test('validateTour accepts a valid single scene and reports corrupted coordinates or duration', () => {
  const valid = makeTour([makeScene('only')]);
  assert.deepEqual(validateTour(valid), []);
  assert.equal(routeDistanceMeters(valid.scenes), 0);
  assert.equal(totalDurationSeconds(valid.scenes), 10);

  const badCoordinates = makeScene('bad-coordinates', {
    camera: { lat: '0', lng: null, altitude: DEFAULT_CAMERA_ALTITUDE },
  });
  const badDuration = makeScene('bad-duration', { duration: 0 });
  const coordinateErrors = validateTour(makeTour([badCoordinates]));
  assert.deepEqual(coordinateErrors.map((error) => error.code), ['invalid_latitude', 'missing_coordinates']);
  assert.deepEqual(validateTour(makeTour([badDuration])).map((error) => error.code), ['invalid_duration']);
  assert.equal(routeDistanceMeters([badCoordinates]), null);
  assert.equal(totalDurationSeconds([badDuration]), null);
});

test('validateTour accepts inclusive numeric limits and optional coordinate-only landmark schema', () => {
  const minimum = makeScene('minimum', {
    duration: 0.001,
    camera: { lat: -90, lng: -180, altitude: 1, zoom: 0.8, bearing: 0, tilt: 0 },
  });
  const maximum = makeScene('maximum', {
    camera: { lat: 90, lng: 180, altitude: 100000, zoom: 2.5, bearing: 360, tilt: 45 },
  });
  assert.deepEqual(validateTour(makeTour([minimum, maximum])), []);
  assert.deepEqual(validateTour(makeTour([makeScene('no-landmark')])), []);

  for (const [field, min, max] of [['zoom', 0.8, 2.5], ['bearing', 0, 360], ['tilt', 0, 45]]) {
    for (const value of [undefined, min - 0.001, max + 0.001, `${min}`, '', null, NaN, Infinity, -Infinity]) {
      const scene = makeScene('camera-range');
      scene.camera[field] = value;
      const errors = validateTour(makeTour([scene]));
      assert.ok(errors.some((error) => error.code === `invalid_${field}` && error.field === `camera.${field}`));
    }
  }
});

test('validateTour reports each coordinate field and preserves scene error context', () => {
  for (const [field, code] of [['lat', 'invalid_latitude'], ['lng', 'invalid_longitude']]) {
    for (const value of ['0', ' 1 ', 'not a number', NaN, Infinity, -Infinity]) {
      const scene = makeScene('invalid-point');
      scene.camera[field] = value;
      const errors = validateTour(makeTour([scene]));
      assert.equal(errors.length, 1);
      const error = errors[0];
      assert.equal(error.code, code);
      assert.equal(error.field, `camera.${field}`);
      assert.equal(error.sceneId, scene.id);
      assert.equal(error.sceneIndex, 0);
      assert.equal(typeof error.message, 'string');
    }
  }

  for (const field of ['lat', 'lng']) {
    for (const value of [undefined, null, '', '   ', '\t\n']) {
      const scene = makeScene('missing-value');
      scene.camera[field] = value;
      const errors = validateTour(makeTour([scene]));
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, 'missing_coordinates');
      assert.equal(errors[0].field, `camera.${field}`);
      assert.equal(errors[0].sceneId, scene.id);
      assert.equal(errors[0].sceneIndex, 0);
    }
    const scene = makeScene('missing-one');
    delete scene.camera[field];
    const errors = validateTour(makeTour([scene]));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'missing_coordinates');
    assert.equal(errors[0].field, `camera.${field}`);
  }
});

test('validateTour rejects missing cameras, ids, and text fields', () => {
  for (const camera of [undefined, null, [], false, 'camera']) {
    const scene = { ...makeScene(), camera };
    assert.ok(hasCode(validateTour(makeTour([scene])), 'missing_camera'));
  }
  for (const id of [undefined, null, '', '   ', 0, {}]) {
    assert.ok(hasCode(validateTour(makeTour([makeScene('bad-id', { id })])), 'missing_id'));
  }
  const errors = validateTour({ scenes: [{ id: 'bare-scene' }] });
  for (const code of ['invalid_title', 'invalid_caption', 'missing_camera', 'invalid_duration']) {
    assert.ok(hasCode(errors, code));
  }
});

test('validateTour validates caption timing and allows empty captions without overlap work', () => {
  const invalidTiming = makeScene('invalid-timing', {
    duration: 10,
    captionTiming: { start: -1, end: 11 },
  });
  const malformedTiming = makeScene('malformed-timing', { captionTiming: 'later' });
  const emptyCaption = makeScene('empty', {
    caption: '',
    captionTiming: { start: 0, end: 100 },
  });

  const invalidErrors = validateTour(makeTour([invalidTiming]));
  assert.ok(hasCode(invalidErrors, 'invalid_caption_timing'));
  assert.ok(hasCode(invalidErrors, 'caption_out_of_bounds'));
  assert.ok(!hasCode(validateTour(makeTour([emptyCaption])), 'caption_overlap'));
  assert.ok(hasCode(validateTour(makeTour([malformedTiming])), 'invalid_caption_timing'));

  const badNumber = validateTour(makeTour([makeScene('bad-number', {
    captionTiming: { start: '1', end: 2 },
  })]));
  assert.ok(hasCode(badNumber, 'invalid_caption_timing'));
});

test('validateTour checks automatic caption timing, order, and finite offsets', () => {
  for (const captionTiming of [undefined, {}, { end: null }, { start: 2 }, { end: 10 }, { start: 2, end: null }]) {
    assert.deepEqual(validateTour(makeTour([makeScene('automatic', { captionTiming })])), []);
  }
  for (const captionTiming of [
    null, false, [], 'later',
    { start: -1, end: 2 },
    { start: 2, end: 2 },
    { start: 3, end: 2 },
    { start: null, end: 2 },
    { start: '', end: 2 },
    { start: NaN, end: 2 },
    { start: Infinity, end: 2 },
    { start: 0, end: NaN },
    { start: 0, end: Infinity },
    { start: 0, end: '2' },
  ]) {
    assert.ok(hasCode(validateTour(makeTour([makeScene('bad-timing', { captionTiming })])), 'invalid_caption_timing'));
  }
  const errors = validateTour(makeTour([makeScene('spill', { captionTiming: { end: 10.001 } })]));
  assert.ok(hasCode(errors, 'caption_out_of_bounds'));
  assert.ok(!hasCode(errors, 'invalid_caption_timing'));
  assert.ok(hasCode(validateTour(makeTour([makeScene('empty-malformed', { caption: '', captionTiming: [] })])), 'invalid_caption_timing'));
});

test('validateTour treats whitespace captions as absent and catches WebVTT timestamp loss', () => {
  const whitespace = makeScene('whitespace', {
    caption: ' \n\t ',
    captionTiming: { start: 0, end: 10 },
  });
  assert.deepEqual(validateTour(makeTour([whitespace])), []);

  const precisionLoss = makeScene('too-short', {
    duration: 1,
    captionTiming: { start: 0.0001, end: 0.0002 },
  });
  const precisionErrors = validateTour(makeTour([precisionLoss]));
  assert.ok(precisionErrors.some((error) => error.code === 'caption_precision_loss' && error.field === 'captionTiming'));

  const unsafe = makeScene('unsafe', {
    duration: Number.MAX_VALUE,
    captionTiming: { start: 0, end: Number.MAX_VALUE },
  });
  const unsafeErrors = validateTour(makeTour([unsafe]));
  assert.ok(unsafeErrors.some((error) => error.code === 'invalid_caption_timestamp' && error.field === 'captionTiming'));
});

test('validateTour detects touching, disjoint, spill, and nested caption intervals globally', () => {
  const touching = [
    makeScene('first', { duration: 10, captionTiming: { start: 0, end: 10 } }),
    makeScene('second', { duration: 10, captionTiming: { start: 0, end: 10 } }),
  ];
  const disjoint = [
    makeScene('first', { duration: 10, captionTiming: { start: 0, end: 4 } }),
    makeScene('second', { duration: 10, captionTiming: { start: 6, end: 10 } }),
  ];
  const spill = [
    makeScene('first', { duration: 10, captionTiming: { start: 5, end: 12 } }),
    makeScene('second', { duration: 10, captionTiming: { start: 0, end: 5 } }),
  ];
  const nested = [
    makeScene('outer', { duration: 30, captionTiming: { start: 0, end: 50 } }),
    makeScene('inner', { duration: 10, captionTiming: { start: 0, end: 10 } }),
    makeScene('third', { duration: 10, captionTiming: { start: 0, end: 10 } }),
  ];

  assert.equal(validateTour(makeTour(touching)).filter((error) => error.code === 'caption_overlap').length, 0);
  assert.equal(validateTour(makeTour(disjoint)).filter((error) => error.code === 'caption_overlap').length, 0);
  assert.equal(validateTour(makeTour(spill)).filter((error) => error.code === 'caption_overlap').length, 1);
  assert.ok(hasCode(validateTour(makeTour(spill)), 'caption_out_of_bounds'));

  const nestedErrors = validateTour(makeTour(nested)).filter((error) => error.code === 'caption_overlap');
  assert.equal(nestedErrors.length, 2);
  assert.match(nestedErrors[0].message, /scene 1/);
  assert.match(nestedErrors[0].message, /scene 2/);
  assert.match(nestedErrors[0].message, /outer/);
  assert.match(nestedErrors[0].message, /inner/);
  assert.equal(nestedErrors[0].sceneIndex, 0);
  assert.equal(nestedErrors[0].sceneId, 'outer');
  assert.equal(nestedErrors[0].relatedSceneIndex, 1);
  assert.equal(nestedErrors[0].relatedSceneId, 'inner');

  const invalidDuration = validateTour(makeTour([...spill, makeScene('bad', { duration: 0 })]));
  assert.ok(hasCode(invalidDuration, 'invalid_duration'));
  assert.equal(invalidDuration.filter((error) => error.code === 'caption_overlap').length, 0);
});

test('validateTour detects every containment pair even when starts are out of scene order', () => {
  const scenes = [
    makeScene('outer', { duration: 10, captionTiming: { start: 0, end: 50 } }),
    makeScene('late-inner', { duration: 10, captionTiming: { start: 20, end: 30 } }),
    makeScene('early-inner', { duration: 10, captionTiming: { start: 0, end: 5 } }),
  ];
  const errors = validateTour(makeTour(scenes));
  const overlaps = errors.filter((error) => error.code === 'caption_overlap');
  assert.equal(overlaps.length, 2);
  assert.ok(overlaps.some((error) => /scene 1/.test(error.message) && /scene 3/.test(error.message)));
  assert.ok(overlaps.every((error) => /outer/.test(error.message)));

  const empty = { ...scenes[0], caption: '' };
  assert.equal(validateTour(makeTour([empty, scenes[1], scenes[2]])).filter((error) => error.code === 'caption_overlap').length, 0);
  const reordered = [
    { ...scenes[0], captionTiming: { start: 30, end: 40 } },
    { ...scenes[1], captionTiming: { start: 0, end: 5 } },
    { ...scenes[2], captionTiming: { start: 10, end: 15 } },
  ];
  assert.equal(validateTour(makeTour(reordered)).filter((error) => error.code === 'caption_overlap').length, 1);
});

test('validateTour does not mutate the input tour', () => {
  const tour = makeTour([
    makeScene('one', { captionTiming: { start: 1, end: 40 } }),
    makeScene('two', { captionTiming: { start: 0, end: 3 } }),
  ]);
  const before = structuredClone(tour);
  Object.freeze(tour);
  Object.freeze(tour.scenes);
  for (const scene of tour.scenes) {
    Object.freeze(scene);
    Object.freeze(scene.camera);
    Object.freeze(scene.captionTiming);
  }
  validateTour(tour);
  assert.deepEqual(tour, before);
});

test('validateTour reports overflowing total duration and replaces stale issues after correction', () => {
  const overflowing = makeTour([
    makeScene('huge-one', { duration: Number.MAX_VALUE, caption: '' }),
    makeScene('huge-two', { duration: Number.MAX_VALUE, caption: '' }),
  ]);
  assert.deepEqual(validateTour(overflowing).map((error) => error.code), ['invalid_total_duration']);

  const draft = makeTour([makeScene('live', {
    camera: { lat: '0', lng: 0, altitude: DEFAULT_CAMERA_ALTITUDE },
  })]);
  const priorIssues = validateTour(draft);
  const priorSnapshot = structuredClone(priorIssues);
  const corrected = {
    ...draft,
    scenes: [{
      ...draft.scenes[0],
      camera: { ...draft.scenes[0].camera, lat: 0 },
    }],
  };
  assert.deepEqual(validateTour(corrected), []);
  assert.deepEqual(priorIssues, priorSnapshot);
  assert.equal(priorIssues[0].code, 'invalid_latitude');
});

test('domain helpers tolerate sparse arrays and numeric overflow', () => {
  const sparse = [];
  sparse.length = 1;
  assert.equal(routeDistanceMeters(sparse), null);
  assert.equal(totalDurationSeconds(sparse), null);
  assert.equal(sceneStartSeconds(sparse, 'scene-1'), null);
  assert.equal(sceneAtTime(sparse, 0), null);
  assert.ok(hasCode(validateTour(makeTour(sparse)), 'malformed_scene'));

  const huge = makeScene('huge', { duration: Number.MAX_VALUE });
  const secondHuge = makeScene('second-huge', { duration: Number.MAX_VALUE });
  assert.equal(totalDurationSeconds([huge, secondHuge]), null);
  assert.equal(sceneAtTime([huge, secondHuge], 1), huge);
  assert.equal(sceneStartSeconds([huge, secondHuge], 'second-huge'), Number.MAX_VALUE);
  assert.equal(sceneStartSeconds([huge, secondHuge, makeScene('after-overflow')], 'after-overflow'), null);
});
