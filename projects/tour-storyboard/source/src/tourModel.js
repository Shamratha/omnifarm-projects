// Camera altitude is measured in metres above ground level (AGL).
export const CAMERA_ALTITUDE_MIN = 1;
export const CAMERA_ALTITUDE_MAX = 100000;
export const DEFAULT_CAMERA_ALTITUDE = 250;

const EARTH_RADIUS_METERS = 6371008.8;

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingCoordinate(value) {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.trim().length === 0);
}

export function validCoordinates(point) {
  return isObject(point)
    && isFiniteNumber(point.lat)
    && point.lat >= -90
    && point.lat <= 90
    && isFiniteNumber(point.lng)
    && point.lng >= -180
    && point.lng <= 180;
}

function normalizedLongitudeDeltaDegrees(fromLongitude, toLongitude) {
  return ((toLongitude - fromLongitude + 540) % 360) - 180;
}

export function haversineDistanceMeters(from, to) {
  if (!validCoordinates(from) || !validCoordinates(to)) return null;

  const latitude1 = from.lat * (Math.PI / 180);
  const latitude2 = to.lat * (Math.PI / 180);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = normalizedLongitudeDeltaDegrees(from.lng, to.lng) * (Math.PI / 180);
  const sineLatitude = Math.sin(deltaLatitude / 2);
  const sineLongitude = Math.sin(deltaLongitude / 2);
  const haversine = Math.min(
    1,
    Math.max(0, sineLatitude ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * sineLongitude ** 2),
  );
  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  return EARTH_RADIUS_METERS * centralAngle;
}

export function routeDistanceMeters(scenes) {
  if (!Array.isArray(scenes)) return null;

  let distance = 0;
  let previous = null;
  for (const scene of scenes) {
    if (!isObject(scene) || !validCoordinates(scene.camera)) return null;
    if (previous) distance += haversineDistanceMeters(previous, scene.camera);
    if (!isFiniteNumber(distance)) return null;
    previous = scene.camera;
  }
  return distance;
}

export function totalDurationSeconds(scenes) {
  if (!Array.isArray(scenes)) return null;

  let total = 0;
  for (const scene of scenes) {
    if (!isObject(scene) || !isFiniteNumber(scene.duration) || scene.duration <= 0) return null;
    total += scene.duration;
    if (!isFiniteNumber(total)) return null;
  }
  return total;
}

export function sceneStartSeconds(scenes, id) {
  if (!Array.isArray(scenes)) return null;

  let elapsed = 0;
  for (const scene of scenes) {
    if (!isObject(scene)) return null;
    if (scene.id === id) return elapsed;
    if (!isFiniteNumber(scene.duration) || scene.duration <= 0) return null;
    elapsed += scene.duration;
    if (!isFiniteNumber(elapsed)) return null;
  }
  return null;
}

export function sceneAtTime(scenes, time) {
  if (!Array.isArray(scenes) || !isFiniteNumber(time) || time < 0) return null;

  let elapsed = 0;
  for (const scene of scenes) {
    if (!isObject(scene) || !isFiniteNumber(scene.duration) || scene.duration <= 0) return null;
    const end = elapsed + scene.duration;
    if (!isFiniteNumber(end)) return null;
    if (time < end) return scene;
    elapsed = end;
  }
  return null;
}

const CAMERA_OPTIONAL_FIELDS = ['zoom', 'bearing', 'tilt'];

function validPreviewCamera(camera) {
  return validCoordinates(camera)
    && isFiniteNumber(camera.altitude)
    && camera.altitude >= CAMERA_ALTITUDE_MIN
    && camera.altitude <= CAMERA_ALTITUDE_MAX;
}

function previewOptionalFieldState(camera, field) {
  if (!Object.hasOwn(camera, field)) return { kind: 'missing' };

  const value = camera[field];
  const valid = isFiniteNumber(value)
    && (field !== 'zoom' || (value >= 0.8 && value <= 2.5))
    && (field !== 'bearing' || (value >= 0 && value <= 360))
    && (field !== 'tilt' || (value >= 0 && value <= 45));
  return valid ? { kind: 'valid', value } : { kind: 'invalid' };
}

function normalizedBearingDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function normalizedSignedLongitude(value) {
  if (value >= -180 && value <= 180) return value;
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && value > 0 ? 180 : normalized;
}

function interpolateOptionalCameraField(field, current, next, progress) {
  const currentState = previewOptionalFieldState(current, field);
  if (!next) {
    return currentState.kind === 'valid' && field === 'bearing'
      ? normalizedBearingDegrees(currentState.value)
      : currentState.kind === 'valid' ? currentState.value : undefined;
  }

  // At a keyframe, the current camera is sufficient; a malformed next value
  // is only relevant once interpolation has actually begun.
  if (progress === 0) {
    return currentState.kind === 'valid' && field === 'bearing'
      ? normalizedBearingDegrees(currentState.value)
      : currentState.kind === 'valid' ? currentState.value : undefined;
  }

  const nextState = previewOptionalFieldState(next, field);
  if (currentState.kind === 'invalid' && nextState.kind === 'missing') return undefined;
  if (currentState.kind === 'missing' && nextState.kind === 'invalid') return null;
  if (currentState.kind === 'invalid' || nextState.kind === 'invalid') return null;
  if (currentState.kind === 'missing' && nextState.kind === 'missing') return undefined;
  if (currentState.kind === 'missing') return nextState.value;
  if (nextState.kind === 'missing') return currentState.value;

  if (field === 'bearing') {
    const delta = normalizedLongitudeDeltaDegrees(currentState.value, nextState.value);
    return normalizedBearingDegrees(currentState.value + delta * progress);
  }
  return currentState.value + (nextState.value - currentState.value) * progress;
}

function interpolatedCamera(current, next, progress) {
  const camera = {
    lat: current.lat + (next ? next.lat - current.lat : 0) * progress,
    lng: normalizedSignedLongitude(
      current.lng + (next ? normalizedLongitudeDeltaDegrees(current.lng, next.lng) : 0) * progress,
    ),
    altitude: current.altitude + (next ? next.altitude - current.altitude : 0) * progress,
  };

  for (const field of CAMERA_OPTIONAL_FIELDS) {
    const value = interpolateOptionalCameraField(field, current, next, progress);
    if (value === null) return null;
    if (value !== undefined) camera[field] = value;
  }
  return camera;
}

export function cameraAtTime(scenes, time) {
  if (!Array.isArray(scenes) || scenes.length === 0 || !isFiniteNumber(time) || time < 0) return null;

  const records = [];
  let elapsed = 0;
  for (const scene of scenes) {
    if (!isObject(scene) || !isFiniteNumber(scene.duration) || scene.duration <= 0) return null;
    if (!validPreviewCamera(scene.camera)) return null;

    const end = elapsed + scene.duration;
    if (!isFiniteNumber(end)) return null;
    records.push({ camera: scene.camera, duration: scene.duration, start: elapsed, end });
    elapsed = end;
  }

  if (time > elapsed) return null;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const isFinal = index === records.length - 1;
    if (time < record.end || (isFinal && time === record.end)) {
      const next = isFinal ? null : records[index + 1].camera;
      const progress = isFinal ? 0 : (time - record.start) / record.duration;
      return interpolatedCamera(record.camera, next, progress);
    }
  }

  return null;
}

function captionTimingValues(scene) {
  if (!isObject(scene) || !isFiniteNumber(scene.duration) || scene.duration <= 0) return null;

  const timing = scene.captionTiming;
  if (timing === undefined) return { start: 0, end: scene.duration };
  if (!isObject(timing)) return null;

  const start = timing.start === undefined ? 0 : timing.start;
  const end = timing.end === undefined || timing.end === null ? scene.duration : timing.end;
  if (!isFiniteNumber(start) || !isFiniteNumber(end)) return null;
  return { start, end };
}

// Offsets can spill past a scene; validateTour reports bounds and overlaps separately.
export function captionInterval(scene, sceneStart = 0) {
  if (!isFiniteNumber(sceneStart)) return null;
  const timing = captionTimingValues(scene);
  if (!timing) return null;
  const start = sceneStart + timing.start;
  const end = sceneStart + timing.end;
  return isFiniteNumber(start) && isFiniteNumber(end) ? { start, end } : null;
}

function makeError(code, field, message, sceneIndex, sceneId) {
  const error = { code, field, message };
  if (sceneId !== undefined) error.sceneId = sceneId;
  if (sceneIndex !== undefined) error.sceneIndex = sceneIndex;
  return error;
}

function addSceneError(errors, code, field, message, scene, sceneIndex) {
  const sceneId = isObject(scene) && scene.id !== undefined ? scene.id : undefined;
  errors.push(makeError(code, field, message, sceneIndex, sceneId));
}

function isValidSceneId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

function sceneName(scene, index) {
  return typeof scene?.title === 'string' && scene.title.length > 0
    ? scene.title
    : `scene ${index + 1}`;
}

function validateCaptionTiming(scene, sceneIndex, errors, hasCaption, durationValid) {
  const timing = scene.captionTiming;
  if (timing === undefined) {
    return durationValid && hasCaption
      ? { start: 0, end: scene.duration }
      : null;
  }

  if (!isObject(timing)) {
    addSceneError(
      errors,
      'invalid_caption_timing',
      'captionTiming',
      'captionTiming must be an object when provided.',
      scene,
      sceneIndex,
    );
    return null;
  }

  const start = timing.start === undefined ? 0 : timing.start;
  const end = timing.end === undefined || timing.end === null ? scene.duration : timing.end;
  const numeric = isFiniteNumber(start) && isFiniteNumber(end);
  const ordered = numeric && start >= 0 && end > start;

  if (hasCaption && (!numeric || !ordered)) {
    addSceneError(
      errors,
      'invalid_caption_timing',
      'captionTiming',
      'Caption timing must use finite values with start >= 0 and end > start.',
      scene,
      sceneIndex,
    );
  }

  if (hasCaption && durationValid && numeric && end > scene.duration) {
    addSceneError(
      errors,
      'caption_out_of_bounds',
      'captionTiming.end',
      'Caption timing end must not exceed the scene duration.',
      scene,
      sceneIndex,
    );
  }

  // A finite, ordered spill must still participate in global overlap checks.
  return hasCaption && numeric && ordered && durationValid
    ? { start, end }
    : null;
}

function validateCaptionTimestamp(scene, sceneIndex, errors, sceneStart, captionTiming) {
  if (!captionTiming || !isFiniteNumber(sceneStart)) return;

  const start = Math.round((sceneStart + captionTiming.start) * 1000);
  const end = Math.round((sceneStart + captionTiming.end) * 1000);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
    addSceneError(
      errors,
      'invalid_caption_timestamp',
      'captionTiming',
      'Caption timestamps must fit in safely representable milliseconds.',
      scene,
      sceneIndex,
    );
  } else if (end <= start) {
    addSceneError(
      errors,
      'caption_precision_loss',
      'captionTiming',
      'Caption must remain longer than zero after rounding to milliseconds.',
      scene,
      sceneIndex,
    );
  }
}

export function validateTour(tour) {
  const errors = [];
  if (!isObject(tour)) {
    return [makeError('malformed_tour', 'tour', 'Tour must be an object.')];
  }

  if (typeof tour.title !== 'string') {
    errors.push(makeError('invalid_title', 'title', 'Tour title must be a string.'));
  }

  if (!Array.isArray(tour.scenes)) {
    errors.push(makeError('malformed_scenes', 'scenes', 'Tour scenes must be an array.'));
    return errors;
  }
  if (tour.scenes.length === 0) {
    errors.push(makeError('no_scenes', 'scenes', 'Tour must contain at least one scene.'));
    return errors;
  }

  const seenIds = new Set();
  const sceneRecords = [];
  let elapsed = 0;
  let allDurationsValid = true;
  let totalDurationOverflowed = false;

  for (let sceneIndex = 0; sceneIndex < tour.scenes.length; sceneIndex += 1) {
    const scene = tour.scenes[sceneIndex];
    if (!isObject(scene)) {
      errors.push(makeError('malformed_scene', `scenes[${sceneIndex}]`, 'Scene must be an object.', sceneIndex));
      allDurationsValid = false;
      continue;
    }

    if (!isValidSceneId(scene.id)) {
      addSceneError(errors, 'missing_id', 'id', 'Scene id must be a non-empty string.', scene, sceneIndex);
    } else if (seenIds.has(scene.id)) {
      addSceneError(errors, 'duplicate_id', 'id', 'Scene id must be unique.', scene, sceneIndex);
    } else {
      seenIds.add(scene.id);
    }

    if (typeof scene.title !== 'string') {
      addSceneError(errors, 'invalid_title', 'title', 'Scene title must be a string.', scene, sceneIndex);
    }
    if (typeof scene.caption !== 'string') {
      addSceneError(errors, 'invalid_caption', 'caption', 'Scene caption must be a string.', scene, sceneIndex);
    }

    const durationValid = isFiniteNumber(scene.duration) && scene.duration > 0;
    if (!durationValid) {
      addSceneError(
        errors,
        'invalid_duration',
        'duration',
        'Scene duration must be a finite number greater than zero.',
        scene,
        sceneIndex,
      );
      allDurationsValid = false;
    }

    const camera = scene.camera;
    if (!isObject(camera)) {
      addSceneError(errors, 'missing_camera', 'camera', 'Scene camera must be an object.', scene, sceneIndex);
    } else {
      if (isMissingCoordinate(camera.lat)) {
        addSceneError(errors, 'missing_coordinates', 'camera.lat', 'Camera latitude is required.', scene, sceneIndex);
      } else if (!isFiniteNumber(camera.lat) || camera.lat < -90 || camera.lat > 90) {
        addSceneError(errors, 'invalid_latitude', 'camera.lat', 'Camera latitude must be between -90 and 90.', scene, sceneIndex);
      }
      if (isMissingCoordinate(camera.lng)) {
        addSceneError(errors, 'missing_coordinates', 'camera.lng', 'Camera longitude is required.', scene, sceneIndex);
      } else if (!isFiniteNumber(camera.lng) || camera.lng < -180 || camera.lng > 180) {
        addSceneError(errors, 'invalid_longitude', 'camera.lng', 'Camera longitude must be between -180 and 180.', scene, sceneIndex);
      }
      if (!isFiniteNumber(camera.altitude) || camera.altitude < CAMERA_ALTITUDE_MIN || camera.altitude > CAMERA_ALTITUDE_MAX) {
        addSceneError(
          errors,
          'invalid_altitude',
          'camera.altitude',
          `Camera altitude must be between ${CAMERA_ALTITUDE_MIN} and ${CAMERA_ALTITUDE_MAX}.`,
          scene,
          sceneIndex,
        );
      }
      if (Object.hasOwn(camera, 'zoom') && (!isFiniteNumber(camera.zoom) || camera.zoom < 0.8 || camera.zoom > 2.5)) {
        addSceneError(errors, 'invalid_zoom', 'camera.zoom', 'Camera zoom must be between 0.8 and 2.5.', scene, sceneIndex);
      }
      if (Object.hasOwn(camera, 'bearing') && (!isFiniteNumber(camera.bearing) || camera.bearing < 0 || camera.bearing > 360)) {
        addSceneError(errors, 'invalid_bearing', 'camera.bearing', 'Camera bearing must be between 0 and 360.', scene, sceneIndex);
      }
      if (Object.hasOwn(camera, 'tilt') && (!isFiniteNumber(camera.tilt) || camera.tilt < 0 || camera.tilt > 45)) {
        addSceneError(errors, 'invalid_tilt', 'camera.tilt', 'Camera tilt must be between 0 and 45.', scene, sceneIndex);
      }
    }

    const hasCaption = typeof scene.caption === 'string' && scene.caption.trim().length > 0;
    const captionTiming = validateCaptionTiming(scene, sceneIndex, errors, hasCaption, durationValid);
    validateCaptionTimestamp(scene, sceneIndex, errors, elapsed, captionTiming);
    sceneRecords.push({ scene, sceneIndex, start: elapsed, captionTiming });
    if (durationValid) {
      elapsed += scene.duration;
      if (!isFiniteNumber(elapsed)) {
        allDurationsValid = false;
        totalDurationOverflowed = true;
      }
    }
  }

  if (totalDurationOverflowed) {
    errors.push(makeError('invalid_total_duration', 'scenes', 'Total scene duration must be finite.'));
  }

  if (allDurationsValid) {
    const intervals = sceneRecords
      .filter((record) => record.captionTiming)
      .map((record) => ({
        ...record,
        interval: {
          start: record.start + record.captionTiming.start,
          end: record.start + record.captionTiming.end,
        },
      }));

    for (let firstIndex = 0; firstIndex < intervals.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < intervals.length; secondIndex += 1) {
        const first = intervals[firstIndex];
        const second = intervals[secondIndex];
        if (Math.max(first.interval.start, second.interval.start) < Math.min(first.interval.end, second.interval.end)) {
          const overlap = makeError(
            'caption_overlap',
            'captionTiming',
            `Caption overlap between scene ${first.sceneIndex + 1} ("${sceneName(first.scene, first.sceneIndex)}") and scene ${second.sceneIndex + 1} ("${sceneName(second.scene, second.sceneIndex)}").`,
            first.sceneIndex,
            isObject(first.scene) ? first.scene.id : undefined,
          );
          overlap.relatedSceneId = isObject(second.scene) ? second.scene.id : undefined;
          overlap.relatedSceneIndex = second.sceneIndex;
          errors.push(overlap);
        }
      }
    }
  }

  return errors;
}
