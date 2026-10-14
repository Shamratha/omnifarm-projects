import {
  DEFAULT_CAMERA_ALTITUDE,
  captionInterval,
  totalDurationSeconds,
  validateTour,
} from './tourModel.js';

const STORYBOARD_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const DEFAULT_CAMERA = {
  lat: null,
  lng: null,
  altitude: null,
  zoom: 1.25,
  bearing: 0,
  tilt: 12,
};

const CAMERA_NUMERIC_FIELDS = Object.keys(DEFAULT_CAMERA);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumericDraftValue(value) {
  return value === null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function invalidStoryboard(message, code = 'invalid_storyboard') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertNumericDraftFields(value, fields, path) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const fieldValue = value[field];
    if (!isNumericDraftValue(fieldValue)) {
      throw invalidStoryboard(`${path}.${field} must be a scalar numeric draft value.`);
    }
  }
}

function cloneCamera(camera, sceneIndex, legacy) {
  if (camera === undefined) {
    return {
      ...DEFAULT_CAMERA,
      altitude: legacy ? DEFAULT_CAMERA_ALTITUDE : null,
    };
  }
  if (!isObject(camera)) {
    throw invalidStoryboard(`scenes[${sceneIndex}].camera must be an object when provided.`);
  }

  assertNumericDraftFields(camera, CAMERA_NUMERIC_FIELDS, `scenes[${sceneIndex}].camera`);
  return {
    ...camera,
    lat: Object.prototype.hasOwnProperty.call(camera, 'lat') ? camera.lat : null,
    lng: Object.prototype.hasOwnProperty.call(camera, 'lng') ? camera.lng : null,
    altitude: Object.prototype.hasOwnProperty.call(camera, 'altitude')
      ? camera.altitude
      : (legacy ? DEFAULT_CAMERA_ALTITUDE : null),
    zoom: Object.prototype.hasOwnProperty.call(camera, 'zoom') ? camera.zoom : DEFAULT_CAMERA.zoom,
    bearing: Object.prototype.hasOwnProperty.call(camera, 'bearing') ? camera.bearing : DEFAULT_CAMERA.bearing,
    tilt: Object.prototype.hasOwnProperty.call(camera, 'tilt') ? camera.tilt : DEFAULT_CAMERA.tilt,
  };
}

function cloneScene(scene, sceneIndex, legacy) {
  if (!isObject(scene)) {
    throw invalidStoryboard(`scenes[${sceneIndex}] must be an object.`);
  }
  if (typeof scene.id !== 'string' || scene.id.trim().length === 0) {
    throw invalidStoryboard(`scenes[${sceneIndex}].id must be a non-empty string.`);
  }
  if (typeof scene.title !== 'string') {
    throw invalidStoryboard(`scenes[${sceneIndex}].title must be a string.`);
  }
  if (typeof scene.caption !== 'string') {
    throw invalidStoryboard(`scenes[${sceneIndex}].caption must be a string.`);
  }

  assertNumericDraftFields(scene, ['duration'], `scenes[${sceneIndex}]`);
  if (Object.prototype.hasOwnProperty.call(scene, 'captionTiming')) {
    if (scene.captionTiming !== null && !isObject(scene.captionTiming)) {
      throw invalidStoryboard(`scenes[${sceneIndex}].captionTiming must be an object or null.`);
    }
    if (isObject(scene.captionTiming)) {
      assertNumericDraftFields(scene.captionTiming, ['start', 'end'], `scenes[${sceneIndex}].captionTiming`);
    }
  }

  return {
    ...scene,
    duration: Object.prototype.hasOwnProperty.call(scene, 'duration') ? scene.duration : null,
    camera: cloneCamera(scene.camera, sceneIndex, legacy),
    ...(Object.prototype.hasOwnProperty.call(scene, 'captionTiming') && isObject(scene.captionTiming)
      ? { captionTiming: { ...scene.captionTiming } }
      : {}),
  };
}

function parsedSchemaVersion(value) {
  if (value === undefined) return LEGACY_SCHEMA_VERSION;
  if (value === LEGACY_SCHEMA_VERSION || value === STORYBOARD_SCHEMA_VERSION) return value;
  throw invalidStoryboard(`Unsupported storyboard schemaVersion: ${String(value)}.`, 'unsupported_schema_version');
}

/** Return editable JSON without validating or repairing the current draft. */
export function serializeStoryboard(tour) {
  return JSON.stringify({ ...tour, schemaVersion: STORYBOARD_SCHEMA_VERSION }, (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw invalidStoryboard(`Cannot save non-finite number in ${key || 'tour'} as JSON.`);
    }
    return value;
  });
}

/** Parse and repair only the safe structural defaults needed by the editor. */
export function deserializeStoryboard(text) {
  if (typeof text !== 'string') {
    throw invalidStoryboard('Storyboard JSON input must be a string.', 'invalid_json');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidStoryboard(`Invalid storyboard JSON: ${error.message}`, 'invalid_json');
  }

  if (!isObject(parsed)) {
    throw invalidStoryboard('Storyboard must be a JSON object.');
  }
  const version = parsedSchemaVersion(parsed.schemaVersion);
  if (typeof parsed.title !== 'string') {
    throw invalidStoryboard('Storyboard title must be a string.');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'subtitle') && typeof parsed.subtitle !== 'string') {
    throw invalidStoryboard('Storyboard subtitle must be a string when provided.');
  }
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw invalidStoryboard('Storyboard scenes must be a non-empty array.');
  }

  const seenIds = new Set();
  const legacy = version === LEGACY_SCHEMA_VERSION;
  const scenes = parsed.scenes.map((scene, sceneIndex) => {
    const cloned = cloneScene(scene, sceneIndex, legacy);
    if (seenIds.has(cloned.id)) {
      throw invalidStoryboard(`Duplicate scene id: ${cloned.id}.`);
    }
    seenIds.add(cloned.id);
    return cloned;
  });

  return {
    ...parsed,
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    title: parsed.title,
    subtitle: parsed.subtitle === undefined ? '' : parsed.subtitle,
    scenes,
  };
}

function exportError(issues) {
  const error = new Error(`Cannot export storyboard: ${issues.map((issue) => issue.message).join(' ')}`);
  error.issues = issues;
  return error;
}

function assertExportable(tour) {
  const issues = validateTour(tour);
  if (issues.length > 0) throw exportError(issues);

  // The model validates each duration; also guard an overflowing cumulative total.
  if (totalDurationSeconds(tour.scenes) === null) {
    throw exportError([{
      code: 'invalid_total_duration',
      field: 'scenes',
      message: 'Total scene duration must be finite.',
    }]);
  }
}

function escapeXml(text) {
  // XML 1.0 permits tab, LF, CR, and valid Unicode code points. Replace everything
  // else, including unpaired UTF-16 surrogates, before escaping markup characters.
  return text
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Export instant camera cuts and exact scene holds, with altitude in metres AGL. */
export function exportKml(tour) {
  assertExportable(tour);
  const name = escapeXml(tour.title);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
    '  <Document>',
    `    <name>${name}</name>`,
    '    <gx:Tour>',
    `      <name>${name}</name>`,
    '      <gx:Playlist>',
  ];

  for (const scene of tour.scenes) {
    const { camera } = scene;
    lines.push(
      '        <gx:FlyTo>',
      '          <gx:duration>0</gx:duration>',
      '          <gx:flyToMode>smooth</gx:flyToMode>',
      '          <Camera>',
      `            <longitude>${camera.lng}</longitude>`,
      `            <latitude>${camera.lat}</latitude>`,
      `            <altitude>${camera.altitude}</altitude>`,
      `            <heading>${camera.bearing ?? 0}</heading>`,
      `            <tilt>${camera.tilt ?? 0}</tilt>`,
      '            <roll>0</roll>',
      '            <altitudeMode>relativeToGround</altitudeMode>',
      '          </Camera>',
      '        </gx:FlyTo>',
      '        <gx:Wait>',
      `          <gx:duration>${scene.duration}</gx:duration>`,
      '        </gx:Wait>',
    );
  }

  lines.push('      </gx:Playlist>', '    </gx:Tour>');
  for (const scene of tour.scenes) {
    lines.push(
      '    <Placemark>',
      `      <name>${escapeXml(scene.title)}</name>`,
      `      <description>${escapeXml(scene.caption)}</description>`,
      '    </Placemark>',
    );
  }
  lines.push('  </Document>', '</kml>');
  return `${lines.join('\n')}\n`;
}

function captionText(text) {
  // A blank (even whitespace-only) line ends a WebVTT cue. Remove such lines,
  // leaving ordinary line breaks and the contents of all nonblank lines intact.
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function timestamp(milliseconds) {
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  const fraction = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`;
}

function captionExportIssue(code, message, scene, sceneIndex) {
  return { code, field: 'captionTiming', message, sceneId: scene.id, sceneIndex };
}

/** Export captions against the same cumulative, travel-free timeline as KML. */
export function exportWebVtt(tour) {
  assertExportable(tour);
  const cues = [];
  let elapsed = 0;
  let previousEnd = 0;

  for (let sceneIndex = 0; sceneIndex < tour.scenes.length; sceneIndex += 1) {
    const scene = tour.scenes[sceneIndex];
    const text = captionText(scene.caption);
    if (text.length > 0) {
      const interval = captionInterval(scene, elapsed);
      const start = interval === null ? NaN : Math.round(interval.start * 1000);
      const end = interval === null ? NaN : Math.round(interval.end * 1000);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
        throw exportError([captionExportIssue(
          'invalid_caption_timestamp',
          'Caption timestamps must fit in safely representable milliseconds.',
          scene,
          sceneIndex,
        )]);
      }
      if (end <= start) {
        throw exportError([captionExportIssue(
          'caption_precision_loss',
          'Caption must remain longer than zero after rounding to milliseconds.',
          scene,
          sceneIndex,
        )]);
      }
      if (start < previousEnd) {
        throw exportError([captionExportIssue(
          'caption_overlap',
          'Caption intervals must not overlap after rounding to milliseconds.',
          scene,
          sceneIndex,
        )]);
      }

      cues.push(`${cues.length + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text}`);
      previousEnd = end;
    }
    elapsed += scene.duration;
  }

  return cues.length > 0 ? `WEBVTT\n\n${cues.join('\n\n')}\n\n` : 'WEBVTT\n\n';
}
