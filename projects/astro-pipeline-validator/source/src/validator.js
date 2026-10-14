/**
 * Local observation-pipeline validation.
 *
 * The validator deliberately operates on plain objects.  A bundle can be
 * assembled from FITS headers, a local observing log, and calibration-file
 * inventory without requiring a FITS reader or a network service.
 */

const FITS_STANDARD = 'FITS Standard 4.0 (keyword and HDU conventions)';
const FITS_TIME_STANDARD = 'FITS Standard 4.0 TIMESYS/MJD-OBS conventions';
const TIME_STANDARD = 'IAU/IERS UTC, TAI and GPS time-scale conventions';
const COORDINATE_STANDARD = 'IAU celestial-coordinate conventions and FITS WCS';
const PROFILE_NAME = 'Astro Pipeline Local Reduction Profile';
const PROFILE_VERSION = '1.0';
const PROFILE_STANDARD = `${PROFILE_NAME} v${PROFILE_VERSION}`;
const CALIBRATION_STANDARD = `${PROFILE_STANDARD} (local bias/dark/flat calibration requirements)`;
const DARK_TEMPERATURE_TOLERANCE_C = 1;
const MJD_TOLERANCE_SECONDS = 0.01;

const REQUIRED_METADATA = [
  'SIMPLE',
  'BITPIX',
  'NAXIS',
  'OBJECT',
  'DATE-OBS',
  'TIMESYS',
  'MJD-OBS',
  'OBSERVAT',
  'TELESCOP',
];

const ALLOWED_BITPIX = new Set([-64, -32, 8, 16, 32, 64]);

const UNIT_FACTORS = new Map([
  ['s', 1],
  ['sec', 1],
  ['secs', 1],
  ['second', 1],
  ['seconds', 1],
  ['ms', 1e-3],
  ['msec', 1e-3],
  ['msecs', 1e-3],
  ['millisecond', 1e-3],
  ['milliseconds', 1e-3],
  ['us', 1e-6],
  ['µs', 1e-6],
  ['usec', 1e-6],
  ['microsecond', 1e-6],
  ['microseconds', 1e-6],
  ['ns', 1e-9],
  ['nsec', 1e-9],
  ['nanosecond', 1e-9],
  ['nanoseconds', 1e-9],
  ['min', 60],
  ['mins', 60],
  ['minute', 60],
  ['minutes', 60],
  ['h', 3600],
  ['hr', 3600],
  ['hrs', 3600],
  ['hour', 3600],
  ['hours', 3600],
]);

const UNIT_NAMES = new Map([
  [1, 's'],
  [1e-3, 'ms'],
  [1e-6, 'us'],
  [1e-9, 'ns'],
  [60, 'min'],
  [3600, 'h'],
]);

// Effective TAI - UTC offsets at the instant immediately after each leap
// second.  The table is intentionally local and immutable: validation must
// work offline and reproducibly.  It is deliberately not a claim about
// future leap seconds; the report documents that the last known offset is
// retained after 2017.
const TAI_UTC_OFFSETS = [
  ['1972-01-01T00:00:00.000Z', 10],
  ['1972-07-01T00:00:00.000Z', 11],
  ['1973-01-01T00:00:00.000Z', 12],
  ['1974-01-01T00:00:00.000Z', 13],
  ['1975-01-01T00:00:00.000Z', 14],
  ['1976-01-01T00:00:00.000Z', 15],
  ['1977-01-01T00:00:00.000Z', 16],
  ['1978-01-01T00:00:00.000Z', 17],
  ['1979-01-01T00:00:00.000Z', 18],
  ['1980-01-01T00:00:00.000Z', 19],
  ['1981-07-01T00:00:00.000Z', 20],
  ['1982-07-01T00:00:00.000Z', 21],
  ['1983-07-01T00:00:00.000Z', 22],
  ['1985-07-01T00:00:00.000Z', 23],
  ['1988-01-01T00:00:00.000Z', 24],
  ['1990-01-01T00:00:00.000Z', 25],
  ['1991-01-01T00:00:00.000Z', 26],
  ['1992-07-01T00:00:00.000Z', 27],
  ['1993-07-01T00:00:00.000Z', 28],
  ['1994-07-01T00:00:00.000Z', 29],
  ['1996-01-01T00:00:00.000Z', 30],
  ['1997-07-01T00:00:00.000Z', 31],
  ['1999-01-01T00:00:00.000Z', 32],
  ['2006-01-01T00:00:00.000Z', 33],
  ['2009-01-01T00:00:00.000Z', 34],
  ['2012-07-01T00:00:00.000Z', 35],
  ['2015-07-01T00:00:00.000Z', 36],
  ['2017-01-01T00:00:00.000Z', 37],
].map(([effective, offset]) => ({ effectiveMs: Date.parse(effective), offset }));

const LEAP_SECOND_BOUNDARIES = [
  '1972-06-30T23:59:60Z',
  '1972-12-31T23:59:60Z',
  '1973-12-31T23:59:60Z',
  '1974-12-31T23:59:60Z',
  '1975-12-31T23:59:60Z',
  '1976-12-31T23:59:60Z',
  '1977-12-31T23:59:60Z',
  '1978-12-31T23:59:60Z',
  '1979-12-31T23:59:60Z',
  '1981-06-30T23:59:60Z',
  '1982-06-30T23:59:60Z',
  '1983-06-30T23:59:60Z',
  '1985-06-30T23:59:60Z',
  '1987-12-31T23:59:60Z',
  '1989-12-31T23:59:60Z',
  '1990-12-31T23:59:60Z',
  '1992-06-30T23:59:60Z',
  '1993-06-30T23:59:60Z',
  '1994-06-30T23:59:60Z',
  '1995-12-31T23:59:60Z',
  '1997-06-30T23:59:60Z',
  '1998-12-31T23:59:60Z',
  '2005-12-31T23:59:60Z',
  '2008-12-31T23:59:60Z',
  '2012-06-30T23:59:60Z',
  '2015-06-30T23:59:60Z',
  '2016-12-31T23:59:60Z',
].map((value) => {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T23:59:60Z$/);
  const date = `${match[1]}T23:59:59.000Z`;
  const boundaryMs = Date.parse(date) + 1000;
  const beforeOffset = taiMinusUtcAt(boundaryMs - 1);
  return {
    label: value,
    date: match[1],
    boundaryMs,
    beforeOffset,
    leapTaiMs: boundaryMs + beforeOffset * 1000,
  };
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTimeSystem(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toUpperCase().replace(/[-_\s]/g, '');
  if (normalized === 'UTC' || normalized === 'UT') return 'UTC';
  if (normalized === 'TAI') return 'TAI';
  if (normalized === 'GPS' || normalized === 'GPST') return 'GPS';
  return null;
}

function canonicalUnit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 's';
  const key = String(value).trim().toLowerCase().replace(/\s+/g, '');
  const factor = UNIT_FACTORS.get(key);
  return factor === undefined ? null : UNIT_NAMES.get(factor) ?? key;
}

function normalizeExposure(value, unit) {
  const amount = numberValue(value);
  const canonical = canonicalUnit(unit);
  const hasRawValue = hasValue(value);
  const rawUnit = unit ?? (hasRawValue ? 's' : undefined);
  if (amount === null || amount < 0 || canonical === null) {
    return {
      seconds: null,
      unit: canonical,
      rawValue: value,
      rawUnit,
      valid: false,
    };
  }
  const factor = UNIT_FACTORS.get(String(unit ?? 's').trim().toLowerCase().replace(/\s+/g, '')) ?? 1;
  return {
    seconds: amount * factor,
    unit: canonical,
    rawValue: value,
    rawUnit,
    valid: true,
  };
}

function taiMinusUtcAt(utcMs) {
  let offset = 0;
  for (const entry of TAI_UTC_OFFSETS) {
    if (utcMs >= entry.effectiveMs) offset = entry.offset;
    else break;
  }
  return offset;
}

function systemOffsetAtUtc(system, utcMs) {
  if (system === 'TAI') return taiMinusUtcAt(utcMs);
  if (system === 'GPS') {
    const gpsEpoch = Date.parse('1980-01-06T00:00:00.000Z');
    return utcMs < gpsEpoch ? 0 : Math.max(0, taiMinusUtcAt(utcMs) - 19);
  }
  return 0;
}

function isoUtc(utcMs) {
  return new Date(utcMs).toISOString();
}

function modifiedJulianDate(epochMs) {
  return 40587 + epochMs / 86400000;
}

function parseTimeValue(value, timeSystem = 'UTC') {
  const system = normalizeTimeSystem(timeSystem) ?? timeSystem;
  if (!['UTC', 'TAI', 'GPS'].includes(system)) {
    return { valid: false, error: 'unknown-time-system', system };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { valid: false, error: 'invalid-timestamp', system };
    const utcMs = value - systemOffsetAtUtc(system, value) * 1000;
    return {
      valid: true,
      system,
      utcMs,
      sourceMs: value,
      sourceMjd: modifiedJulianDate(value),
      leapSecond: false,
    };
  }

  if (value instanceof Date) {
    const sourceMs = value.getTime();
    if (!Number.isFinite(sourceMs)) return { valid: false, error: 'invalid-timestamp', system };
    let utcMs = sourceMs;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      utcMs = sourceMs - systemOffsetAtUtc(system, utcMs) * 1000;
    }
    return {
      valid: true,
      system,
      utcMs,
      sourceMs,
      sourceMjd: modifiedJulianDate(sourceMs),
      leapSecond: false,
    };
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: false, error: 'invalid-timestamp', system };
  }

  const input = value.trim();
  const isoMatch = input.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  const second = isoMatch ? Number(isoMatch[6]) : null;
  const fractionalMilliseconds = isoMatch
    ? Math.round(Number(`0.${isoMatch[7] ?? '0'}`) * 1000)
    : 0;

  if (isoMatch && second === 60) {
    if (system !== 'UTC') return { valid: false, error: 'leap-second-non-utc', system };
    const [, year, month, day, hour, minute, , , zone = 'Z'] = isoMatch;
    const offsetMatch = zone === 'Z' ? null : zone.match(/^([+-])(\d{2}):?(\d{2})$/);
    const offsetMinutes = offsetMatch
      ? (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * (offsetMatch[1] === '+' ? 1 : -1)
      : 0;
    const localSecondBeforeLeap = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      59,
      fractionalMilliseconds,
    );
    const utcMs = localSecondBeforeLeap + 1000 - offsetMinutes * 60000;
    const boundaryMs = utcMs - fractionalMilliseconds;
    const isKnownBoundary = LEAP_SECOND_BOUNDARIES.some((entry) => entry.boundaryMs === boundaryMs);
    if (!isKnownBoundary) return { valid: false, error: 'invalid-leap-second', system };
    return {
      valid: true,
      system,
      utcMs,
      sourceMs: utcMs,
      sourceMjd: modifiedJulianDate(utcMs),
      leapSecond: true,
      leapSecondLabel: input,
    };
  }

  if (isoMatch && (second < 0 || second > 59)) {
    return { valid: false, error: 'invalid-timestamp', system };
  }

  const sourceMs = Date.parse(input);
  if (!Number.isFinite(sourceMs)) return { valid: false, error: 'invalid-timestamp', system };
  let utcMs = sourceMs;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    utcMs = sourceMs - systemOffsetAtUtc(system, utcMs) * 1000;
  }
  return {
    valid: true,
    system,
    utcMs,
    sourceMs,
    sourceMjd: modifiedJulianDate(sourceMs),
    leapSecond: false,
  };
}

function slug(value) {
  return String(value ?? 'UNKNOWN')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'UNKNOWN';
}

function stableNumber(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function namesAreEquivalent(left, right, aliases = []) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b || a === b) return true;
  const normalizedAliases = new Set(aliases.map(normalizeName));
  return normalizedAliases.has(a) || normalizedAliases.has(b);
}

function getMetadata(bundle) {
  return isObject(bundle?.metadata) ? bundle.metadata : isObject(bundle?.header) ? bundle.header : {};
}

function getExposureLogs(bundle) {
  const logs = firstDefined(bundle?.exposureLogs, bundle?.exposures, []);
  return Array.isArray(logs) ? logs : [];
}

function getCalibrationFrames(bundle) {
  const source = firstDefined(bundle?.calibrationFrames, bundle?.calibrations, []);
  if (Array.isArray(source)) return source.map((frame, index) => ({ ...frame, sourceIndex: index }));
  if (!isObject(source)) return [];
  const frames = [];
  for (const [type, values] of Object.entries(source)) {
    if (!Array.isArray(values)) continue;
    values.forEach((frame, index) => {
      frames.push({ ...frame, type: frame?.type ?? type, sourceIndex: `${type}-${index}` });
    });
  }
  return frames;
}

function getTarget(bundle, metadata) {
  const target = isObject(bundle?.target) ? bundle.target : {};
  const coordinates = isObject(bundle?.targetCoordinates)
    ? bundle.targetCoordinates
    : isObject(target.coordinates)
      ? target.coordinates
      : {};
  return {
    name: firstDefined(target.name, target.target, metadata.TARGET, metadata.OBJECT),
    aliases: Array.isArray(target.aliases) ? target.aliases : [],
    ra: firstDefined(coordinates.raDeg, coordinates.ra, target.raDeg, target.ra, metadata.RA),
    dec: firstDefined(coordinates.decDeg, coordinates.dec, target.decDeg, target.dec, metadata.DEC),
  };
}

function parseCoordinate(value, axis) {
  const numeric = numberValue(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const parts = trimmed.match(/^([+-]?\d+(?:\.\d+)?)[hHdD:]\s*(\d+(?:\.\d+)?)(?:[:\s]+(\d+(?:\.\d+)?))?$/);
  if (!parts) return null;
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  const third = Number(parts[3] ?? 0);
  const sign = first < 0 || trimmed.startsWith('-') ? -1 : 1;
  const absolute = Math.abs(first) + second / 60 + third / 3600;
  const degrees = absolute * (/[hH]/.test(trimmed) || axis === 'ra' ? 15 : 1);
  return sign * degrees;
}

function weatherRecords(bundle, exposureLogs) {
  const records = [];
  const weather = bundle?.weather;
  if (Array.isArray(weather)) {
    weather.forEach((record, index) => records.push({ record, id: record?.id ?? `weather-${index}` }));
  } else if (isObject(weather)) {
    records.push({ record: weather, id: weather.id ?? 'bundle-weather' });
  }
  exposureLogs.forEach((log, index) => {
    if (isObject(log?.weather)) records.push({ record: log.weather, id: log.id ?? `exposure-${index}` });
  });
  return records;
}

function observationId(record, index) {
  return record?.id ?? record?.exposureId ?? `exposure-${index + 1}`;
}

function addFindingFactory(findings) {
  const ids = new Set();
  return (finding) => {
    if (ids.has(finding.id)) return finding.id;
    const complete = {
      id: finding.id,
      severity: finding.severity ?? 'warning',
      category: finding.category,
      title: finding.title,
      explanation: finding.explanation,
      evidence: finding.evidence ?? {},
      remediation: finding.remediation,
      standards: Array.isArray(finding.standards) ? finding.standards : [finding.standards].filter(Boolean),
    };
    ids.add(complete.id);
    findings.push(complete);
    return complete.id;
  };
}

function runCheck(checks, findings, id, category, title, callback) {
  const before = findings.length;
  callback();
  const checkFindings = findings.slice(before);
  const hasError = checkFindings.some((finding) => finding.severity === 'error');
  checks.push({
    id,
    category,
    title,
    status: hasError ? 'fail' : checkFindings.length > 0 ? 'warn' : 'pass',
    findingIds: checkFindings.map((finding) => finding.id),
  });
}

function normalizeBundle(bundle, metadata, exposureLogs, calibrationFrames, target) {
  const metadataSystem = normalizeTimeSystem(metadata.TIMESYS) ?? 'UTC';
  const normalizedExposureLogs = exposureLogs.map((log, index) => {
    const timeSystem = normalizeTimeSystem(firstDefined(log?.timeSystem, log?.TIMESYS, metadata.TIMESYS));
    const start = firstDefined(log?.start, log?.startTime, log?.timestamp, log?.dateObs, log?.['DATE-OBS']);
    const parsedTime = start === undefined ? { valid: false, error: 'missing-timestamp', system: timeSystem } : parseTimeValue(start, timeSystem ?? 'UTC');
    const exposure = normalizeExposure(
      firstDefined(log?.exposure, log?.exposureTime, log?.EXPTIME, metadata.EXPTIME),
      firstDefined(log?.exposureUnit, log?.unit, log?.EXPOSURE_UNIT, log?.EXPTIME_UNIT),
    );
    return {
      id: observationId(log, index),
      sourceIndex: index,
      timeSystem,
      startUtc: parsedTime.valid ? isoUtc(parsedTime.utcMs) : null,
      mjd: parsedTime.valid ? stableNumber(parsedTime.sourceMjd, 9) : null,
      leapSecond: parsedTime.valid ? parsedTime.leapSecond : false,
      timeError: parsedTime.valid ? null : parsedTime.error,
      exposureSeconds: exposure.seconds,
      exposureUnit: exposure.unit,
      rawExposure: exposure.rawValue,
      rawExposureUnit: exposure.rawUnit,
      exposureValid: exposure.valid,
      filter: firstDefined(log?.filter, log?.FILTER, log?.band, 'UNFILTERED'),
      airmass: numberValue(firstDefined(log?.airmass, log?.AIRMASS)),
      altitudeDeg: numberValue(firstDefined(log?.altitudeDeg, log?.altitude, log?.ALTITUDE)),
      weather: isObject(log?.weather) ? { ...log.weather } : null,
    };
  });

  const normalizedCalibrationFrames = calibrationFrames.map((frame, index) => {
    const exposure = normalizeExposure(
      firstDefined(frame?.exposure, frame?.exposureTime, frame?.EXPTIME),
      firstDefined(frame?.exposureUnit, frame?.unit, frame?.EXPOSURE_UNIT, frame?.EXPTIME_UNIT),
    );
    return {
      id: frame?.id ?? `calibration-${index + 1}`,
      sourceIndex: frame.sourceIndex ?? index,
      type: String(firstDefined(frame?.type, frame?.TYPE, '')).trim().toLowerCase(),
      exposureSeconds: exposure.seconds,
      exposureUnit: exposure.unit,
      rawExposure: exposure.rawValue,
      rawExposureUnit: exposure.rawUnit,
      exposureValid: exposure.valid,
      filter: firstDefined(frame?.filter, frame?.FILTER, 'UNFILTERED'),
      temperatureC: numberValue(firstDefined(frame?.temperatureC, frame?.temperature, frame?.TEMP)),
    };
  });

  const dateObs = firstDefined(metadata['DATE-OBS'], metadata.DATEOBS);
  const parsedMetadataTime = dateObs === undefined
    ? { valid: false, error: 'missing-timestamp', system: metadataSystem }
    : parseTimeValue(dateObs, metadataSystem);
  const metadataRa = parseCoordinate(target.ra, 'ra');
  const metadataDec = parseCoordinate(target.dec, 'dec');

  return {
    metadata: {
      ...metadata,
      timeSystem: metadataSystem,
      dateObsUtc: parsedMetadataTime.valid ? isoUtc(parsedMetadataTime.utcMs) : null,
      dateObsMjd: parsedMetadataTime.valid ? stableNumber(parsedMetadataTime.sourceMjd, 9) : null,
      dateObsLeapSecond: parsedMetadataTime.valid ? parsedMetadataTime.leapSecond : false,
    },
    target: {
      name: target.name,
      aliases: [...target.aliases],
      raDeg: metadataRa,
      decDeg: metadataDec,
    },
    exposureLogs: normalizedExposureLogs,
    calibrationFrames: normalizedCalibrationFrames,
    weather: weatherRecords(bundle, exposureLogs).map(({ record, id }) => ({
      id,
      temperatureC: numberValue(firstDefined(record?.temperatureC, record?.tempC, record?.temperature)),
      humidityPct: numberValue(firstDefined(record?.humidityPct, record?.humidity, record?.relativeHumidity)),
      windSpeedMps: numberValue(firstDefined(record?.windSpeedMps, record?.windSpeed)),
      pressureHpa: numberValue(firstDefined(record?.pressureHpa, record?.pressure)),
    })),
    timeSystems: [...new Set([
      metadataSystem,
      ...normalizedExposureLogs.map((entry) => entry.timeSystem),
    ].filter(Boolean))].sort(),
    exposureUnits: [...new Set([
      ...normalizedExposureLogs.filter((entry) => entry.exposureValid).map((entry) => entry.exposureUnit),
      ...normalizedCalibrationFrames.filter((entry) => entry.exposureValid).map((entry) => entry.exposureUnit),
    ].filter(Boolean))].sort(),
  };
}

function validateMetadata(bundle, metadata, normalized, addFinding) {
  const required = [...REQUIRED_METADATA];
  const naxis = numberValue(metadata.NAXIS);
  if (naxis !== null) {
    for (let axis = 1; axis <= Math.min(naxis, 2); axis += 1) required.push(`NAXIS${axis}`);
  }
  for (const key of required) {
    if (!hasValue(metadata[key])) {
      addFinding({
        id: `META-REQUIRED-${key}`,
        severity: 'error',
        category: 'metadata',
        title: `Missing required FITS-like field ${key}`,
        explanation: `${key} is required by the local observation profile so the image and its provenance can be interpreted deterministically.`,
        evidence: { field: key },
        remediation: `Populate ${key} in the FITS-like metadata before ingest.`,
        standards: [FITS_STANDARD],
      });
    }
  }

  if (hasValue(metadata.SIMPLE) && metadata.SIMPLE !== true && String(metadata.SIMPLE).toUpperCase() !== 'T') {
    addFinding({
      id: 'META-SIMPLE-INVALID',
      severity: 'error',
      category: 'metadata',
      title: 'SIMPLE does not identify a standard FITS primary HDU',
      explanation: 'The primary header does not declare the FITS primary HDU with SIMPLE = T.',
      evidence: { SIMPLE: metadata.SIMPLE },
      remediation: 'Write a standards-compliant primary HDU or explicitly exclude the file from FITS ingestion.',
      standards: [FITS_STANDARD],
    });
  }

  const bitpix = numberValue(metadata.BITPIX);
  if (bitpix !== null && !ALLOWED_BITPIX.has(bitpix)) {
    addFinding({
      id: 'META-BITPIX-INVALID',
      severity: 'error',
      category: 'metadata',
      title: 'BITPIX has an unsupported value',
      explanation: 'BITPIX must use one of the FITS-defined pixel representations.',
      evidence: { BITPIX: metadata.BITPIX, allowed: [...ALLOWED_BITPIX].sort((a, b) => a - b) },
      remediation: 'Correct BITPIX or convert the image to a supported FITS data representation.',
      standards: [FITS_STANDARD],
    });
  }
  if (naxis !== null && (!Number.isInteger(naxis) || naxis < 0)) {
    addFinding({
      id: 'META-NAXIS-INVALID',
      severity: 'error',
      category: 'metadata',
      title: 'NAXIS is not a valid non-negative integer',
      explanation: 'The number of image axes cannot be interpreted safely.',
      evidence: { NAXIS: metadata.NAXIS },
      remediation: 'Set NAXIS to the integer dimensionality of the FITS image.',
      standards: [FITS_STANDARD],
    });
  }

  const telescope = isObject(bundle.telescope) ? bundle.telescope : {};
  const telescopeName = firstDefined(metadata.TELESCOP, telescope.name);
  if (hasValue(metadata.TELESCOP) && hasValue(telescope.name) && normalizeName(metadata.TELESCOP) !== normalizeName(telescope.name)) {
    addFinding({
      id: 'META-TELESCOPE-NAME-MISMATCH',
      severity: 'error',
      category: 'metadata',
      title: 'TELESCOP disagrees with the telescope descriptor',
      explanation: 'The FITS-like telescope keyword and the bundle telescope descriptor identify different instruments.',
      evidence: { TELESCOP: metadata.TELESCOP, descriptor: telescope.name },
      remediation: 'Use one canonical telescope identifier in the header and observing-log metadata.',
      standards: [FITS_STANDARD],
    });
  }

  const observatory = metadata.OBSERVAT;
  const observatoryDescriptor = bundle.observatory?.name;
  const telescopeSite = firstDefined(metadata.TELESCOPE_SITE, telescope.observatory, telescope.site);
  if (hasValue(observatory) && hasValue(observatoryDescriptor) && normalizeName(observatory) !== normalizeName(observatoryDescriptor)) {
    addFinding({
      id: 'META-OBSERVATORY-DESCRIPTOR-MISMATCH',
      severity: 'error',
      category: 'metadata',
      title: 'OBSERVAT disagrees with the observatory descriptor',
      explanation: 'The FITS-like OBSERVAT keyword and the bundle observatory descriptor identify different sites.',
      evidence: { OBSERVAT: observatory, descriptor: observatoryDescriptor },
      remediation: 'Resolve the observing site provenance and update OBSERVAT and the observatory descriptor together.',
      standards: [FITS_STANDARD],
    });
  }
  if (hasValue(observatory) && hasValue(telescopeSite) && normalizeName(observatory) !== normalizeName(telescopeSite)) {
    addFinding({
      id: 'META-OBSERVAT-TELESCOP-MISMATCH',
      severity: 'error',
      category: 'metadata',
      title: 'OBSERVAT and TELESCOP site metadata are inconsistent',
      explanation: 'The observation site named by OBSERVAT does not match the site associated with TELESCOP.',
      evidence: { OBSERVAT: observatory, TELESCOP: telescopeName, telescopeSite },
      remediation: 'Resolve the instrument/site provenance and update OBSERVAT, TELESCOP, and the telescope descriptor together.',
      standards: [FITS_STANDARD],
    });
  }

  const targetNames = [metadata.OBJECT, metadata.TARGET, normalized.target.name].filter(hasValue);
  const aliases = normalized.target.aliases;
  const mismatch = targetNames.some((name, index) => targetNames.slice(index + 1).some((other) => !namesAreEquivalent(name, other, aliases)));
  if (mismatch) {
    addFinding({
      id: 'META-OBJECT-TARGET-MISMATCH',
      severity: 'error',
      category: 'metadata',
      title: 'OBJECT and target identifiers do not agree',
      explanation: 'The FITS OBJECT/TARGET fields and the bundle target descriptor refer to different target names.',
      evidence: { OBJECT: metadata.OBJECT, TARGET: metadata.TARGET, target: normalized.target.name, aliases },
      remediation: 'Resolve target aliases explicitly, or make OBJECT, TARGET, and the target descriptor identify the same object.',
      standards: [FITS_STANDARD, COORDINATE_STANDARD],
    });
  }
}

function validateCalibration(normalized, addFinding) {
  const science = normalized.exposureLogs.filter((entry) => entry.exposureValid);
  const frames = normalized.calibrationFrames;
  const bias = frames.filter((frame) => frame.type === 'bias');
  const dark = frames.filter((frame) => frame.type === 'dark' && frame.exposureValid);
  // Invalid exposure values must not satisfy a flat-field coverage claim. A
  // bias frame may legitimately omit EXPTIME, but darks/flats need a
  // deterministic exposure value for matching and downstream reduction.
  const flat = frames.filter((frame) => frame.type === 'flat' && frame.exposureValid);

  if (science.length > 0 && bias.length === 0) {
    addFinding({
      id: 'CAL-BIAS-MISSING',
      severity: 'error',
      category: 'calibration',
      title: 'No bias frame covers the science exposures',
      explanation: 'This local reduction profile requires a bias or validated zero-level reference for detector offset removal in science imaging sequences.',
      evidence: { scienceExposureCount: science.length, biasFrameCount: bias.length },
      remediation: 'Acquire or ingest a bias set for the detector configuration, or record a validated equivalent zero-level correction.',
      standards: [CALIBRATION_STANDARD],
    });
  }

  const scienceDurations = [...new Set(science.map((entry) => stableNumber(entry.exposureSeconds, 6)))].sort((a, b) => a - b);
  for (const duration of scienceDurations) {
    const covered = dark.some((frame) => Math.abs(frame.exposureSeconds - duration) <= Math.max(0.001, duration * 0.01));
    if (!covered) {
      addFinding({
        id: `CAL-DARK-COVERAGE-${slug(`${duration}s`)}`,
        severity: 'error',
        category: 'calibration',
        title: `No dark frame covers ${duration} seconds`,
        explanation: 'A dark frame with a matching integration time is not present for a science exposure duration.',
        evidence: { scienceExposureSeconds: duration, availableDarkExposureSeconds: dark.map((frame) => frame.exposureSeconds).sort((a, b) => a - b) },
        remediation: 'Add dark frames at this exposure time and detector temperature, or document a validated interpolation policy.',
        standards: [CALIBRATION_STANDARD],
      });
    }
  }

  const filters = [...new Set(science.map((entry) => String(entry.filter ?? 'UNFILTERED')))].sort();
  for (const filter of filters) {
    const covered = flat.some((frame) => String(frame.filter ?? 'UNFILTERED').toUpperCase() === filter.toUpperCase());
    if (!covered) {
      addFinding({
        id: `CAL-FLAT-COVERAGE-${slug(filter)}`,
        severity: 'error',
        category: 'calibration',
        title: `No flat frame covers filter ${filter}`,
        explanation: 'The science filter has no matching flat-field calibration in the local inventory.',
        evidence: { scienceFilter: filter, availableFlatFilters: flat.map((frame) => frame.filter).sort() },
        remediation: `Add a ${filter} flat set with the same detector configuration, or mark the sequence as intentionally unflat-fielded.`,
        standards: [CALIBRATION_STANDARD],
      });
    }
  }

  for (const frame of frames) {
    if (!['bias', 'dark', 'flat'].includes(frame.type)) {
      addFinding({
        id: `CAL-UNKNOWN-TYPE-${slug(frame.id)}`,
        severity: 'warning',
        category: 'calibration',
        title: `Unknown calibration frame type for ${frame.id}`,
        explanation: 'The frame cannot be included in bias, dark, or flat coverage calculations.',
        evidence: { frameId: frame.id, type: frame.type },
        remediation: 'Classify the frame as bias, dark, or flat, or remove it from the calibration inventory.',
        standards: [CALIBRATION_STANDARD],
      });
    }
  }
}

function addTimeFinding(addFinding, id, title, explanation, evidence, remediation, severity = 'error') {
  addFinding({ id, severity, category: 'time', title, explanation, evidence, remediation, standards: [TIME_STANDARD, FITS_TIME_STANDARD] });
}

function validateTime(bundle, metadata, normalized, addFinding) {
  const systems = new Set();
  const metadataSystem = normalizeTimeSystem(metadata.TIMESYS);
  if (hasValue(metadata.TIMESYS) && !metadataSystem) {
    addTimeFinding(
      addFinding,
      'TIME-SYSTEM-UNKNOWN-METADATA',
      'TIMESYS is not recognized',
      'The metadata time scale is not one of the supported UTC, TAI, or GPS systems.',
      { TIMESYS: metadata.TIMESYS },
      'Set TIMESYS to UTC, TAI, or GPS and retain the original source scale separately if needed.',
    );
  }
  if (metadataSystem) systems.add(metadataSystem);

  const timeRecords = [
    {
      id: 'metadata',
      timeSystem: metadataSystem,
      timeError: normalized.metadata.dateObsUtc ? null : 'invalid-timestamp',
      rawTimestamp: firstDefined(metadata['DATE-OBS'], metadata.DATEOBS),
      declaredSourceSystem: metadata.TIMESYS,
    },
    ...normalized.exposureLogs.map((entry) => {
      const source = bundle.exposureLogs?.[entry.sourceIndex] ?? bundle.exposures?.[entry.sourceIndex];
      return {
        ...entry,
        rawTimestamp: firstDefined(source?.start, source?.startTime, source?.timestamp, source?.dateObs, source?.['DATE-OBS']),
        declaredSourceSystem: firstDefined(source?.timeSystem, source?.TIMESYS, metadata.TIMESYS),
      };
    }),
  ];
  for (const record of timeRecords) {
    if (record.timeSystem) systems.add(record.timeSystem);
    if (record.timeError && record.timeError !== 'missing-timestamp') {
      const suffix = record.id === 'metadata' ? 'METADATA' : slug(record.id);
      const title = record.timeError === 'invalid-leap-second'
        ? 'Timestamp uses an invalid leap-second boundary'
        : record.timeError === 'leap-second-non-utc'
          ? 'Leap-second notation is only valid in UTC'
          : 'Timestamp cannot be normalized';
      let explanation = 'The timestamp could not be converted deterministically to the normalized UTC representation.';
      let remediation = 'Correct the timestamp and declare its source time system explicitly.';
      if (record.timeError === 'leap-second-non-utc') {
        explanation = `The declared ${record.timeSystem} source scale is continuous and does not use leap-second notation (:60). Only UTC may use :60 at a known UTC leap-second boundary.`;
        remediation = `If the source clock is ${record.timeSystem}, supply the corresponding ${record.timeSystem} timestamp with seconds 00–59 for the recorded instant. Declare UTC only if the timestamp was actually recorded in UTC, and verify its leap-second boundary.`;
      } else if (record.timeError === 'invalid-leap-second') {
        explanation = 'The declared UTC timestamp uses :60 outside a known UTC leap-second boundary in the local table through 2016-12-31.';
        remediation = 'Verify the recorded instant against the UTC leap-second table and correct the UTC date/time. Use :60 only at a known UTC leap-second boundary.';
      }
      addTimeFinding(
        addFinding,
        `TIME-TIMESTAMP-${suffix}`,
        title,
        explanation,
        { record: record.id, rawTimestamp: record.rawTimestamp, declaredSourceSystem: record.declaredSourceSystem, error: record.timeError },
        remediation,
      );
    }
  }

  if (systems.size > 1) {
    addTimeFinding(
      addFinding,
      'TIME-SYSTEM-MIXED',
      'UTC, TAI, or GPS records are mixed in one bundle',
      'Records use more than one time scale. Normalized UTC values are available, but the source-scale mixture must be explicit and reviewable.',
      { systems: [...systems].sort(), metadataTIMESYS: metadata.TIMESYS },
      'Convert all timestamps to one declared comparison scale before combining observations, and preserve each source scale in provenance.',
    );
  }

  const metadataMjd = numberValue(metadata['MJD-OBS']);
  if (metadataMjd !== null && normalized.metadata.dateObsMjd !== null) {
    const differenceSeconds = (metadataMjd - normalized.metadata.dateObsMjd) * 86400;
    const tolerance = normalized.metadata.dateObsLeapSecond ? 2 : 1;
    if (Math.abs(differenceSeconds) > tolerance) {
      addTimeFinding(
        addFinding,
        'TIME-MJD-MISMATCH-METADATA',
        'MJD-OBS does not match DATE-OBS',
        'The Modified Julian Date differs from the timestamp-derived value beyond the precision allowed for this local validator.',
        { MJD_OBS: metadataMjd, derivedMJD: stableNumber(normalized.metadata.dateObsMjd, 9), differenceSeconds: stableNumber(differenceSeconds, 3) },
        'Regenerate MJD-OBS from DATE-OBS in the declared TIMESYS, taking leap-second handling into account.',
      );
    }
  }

  for (const entry of normalized.exposureLogs) {
    const source = bundle.exposureLogs?.[entry.sourceIndex] ?? bundle.exposures?.[entry.sourceIndex];
    const declaredMjd = numberValue(firstDefined(source?.mjd, source?.MJD));
    if (declaredMjd !== null && entry.mjd !== null) {
      const differenceSeconds = (declaredMjd - entry.mjd) * 86400;
      if (Math.abs(differenceSeconds) > (entry.leapSecond ? 2 : 1)) {
        addTimeFinding(
          addFinding,
          `TIME-MJD-MISMATCH-${slug(entry.id)}`,
          `MJD does not match timestamp for ${entry.id}`,
          'The exposure log MJD and timestamp disagree beyond the allowed precision.',
          { exposureId: entry.id, declaredMJD: declaredMjd, derivedMJD: stableNumber(entry.mjd, 9), differenceSeconds: stableNumber(differenceSeconds, 3) },
          'Regenerate the exposure MJD using the same source time system as the timestamp.',
        );
      }
    }
  }
}

function validateObservations(bundle, normalized, addFinding) {
  const ra = normalized.target.raDeg;
  const dec = normalized.target.decDeg;
  if (ra === null || dec === null) {
    addFinding({
      id: 'OBS-TARGET-COORDINATES-MISSING',
      severity: 'error',
      category: 'range',
      title: 'Target coordinates are missing or unparsable',
      explanation: 'A target coordinate pair is required to place observations on the sky.',
      evidence: { ra: bundle.target?.raDeg ?? bundle.target?.ra, dec: bundle.target?.decDeg ?? bundle.target?.dec },
      remediation: 'Provide numeric RA in degrees (or a parseable hour angle) and DEC in degrees.',
      standards: [COORDINATE_STANDARD],
    });
  } else {
    if (ra < 0 || ra >= 360) {
      addFinding({
        id: 'OBS-RA-OUT-OF-RANGE',
        severity: 'error',
        category: 'range',
        title: 'Target right ascension is out of range',
        explanation: 'Right ascension must be within the half-open degree interval [0, 360).',
        evidence: { raDeg: ra },
        remediation: 'Normalize RA into [0, 360) degrees and retain the original coordinate provenance.',
        standards: [COORDINATE_STANDARD],
      });
    }
    if (dec < -90 || dec > 90) {
      addFinding({
        id: 'OBS-DEC-OUT-OF-RANGE',
        severity: 'error',
        category: 'range',
        title: 'Target declination is out of range',
        explanation: 'Declination must be within the inclusive degree interval [-90, 90].',
        evidence: { decDeg: dec },
        remediation: 'Correct the target declination and verify the coordinate frame.',
        standards: [COORDINATE_STANDARD],
      });
    }
  }

  for (const entry of normalized.exposureLogs) {
    if (entry.airmass !== null) {
      if (entry.airmass < 1 || entry.airmass > 10) {
        addFinding({
          id: `OBS-AIRMASS-OUT-OF-RANGE-${slug(entry.id)}`,
          severity: 'error',
          category: 'range',
          title: `Airmass is physically out of range for ${entry.id}`,
          explanation: 'The local observation profile accepts airmass values from 1 through 10 for above-horizon observations.',
          evidence: { exposureId: entry.id, airmass: entry.airmass },
          remediation: 'Correct the airmass calculation or discard the observation if it was taken below the usable horizon.',
          standards: [COORDINATE_STANDARD],
        });
      } else if (entry.airmass > 5) {
        addFinding({
          id: `OBS-AIRMASS-HIGH-${slug(entry.id)}`,
          severity: 'warning',
          category: 'range',
          title: `Airmass is high for ${entry.id}`,
          explanation: 'Airmass above 5 is technically possible but normally indicates a low-quality near-horizon exposure.',
          evidence: { exposureId: entry.id, airmass: entry.airmass },
          remediation: 'Review the horizon mask and consider excluding or flagging this exposure in downstream science products.',
          standards: [COORDINATE_STANDARD],
        });
      }
    }
    if (entry.altitudeDeg !== null) {
      if (entry.altitudeDeg < -90 || entry.altitudeDeg > 90) {
        addFinding({
          id: `OBS-ALTITUDE-OUT-OF-RANGE-${slug(entry.id)}`,
          severity: 'error',
          category: 'range',
          title: `Altitude is outside the physical range for ${entry.id}`,
          explanation: 'Altitude must be between -90 and +90 degrees.',
          evidence: { exposureId: entry.id, altitudeDeg: entry.altitudeDeg },
          remediation: 'Correct the altitude calculation and verify the site coordinates and timestamp.',
          standards: [COORDINATE_STANDARD],
        });
      } else if (entry.altitudeDeg < 0) {
        addFinding({
          id: `OBS-ALTITUDE-BELOW-HORIZON-${slug(entry.id)}`,
          severity: 'error',
          category: 'range',
          title: `Observation ${entry.id} is below the horizon`,
          explanation: 'A negative altitude indicates that the target was below the geometric horizon at the logged observation time.',
          evidence: { exposureId: entry.id, altitudeDeg: entry.altitudeDeg },
          remediation: 'Verify the timestamp and site, then exclude or correct the below-horizon exposure.',
          standards: [COORDINATE_STANDARD],
        });
      }
    }
  }

  for (const weather of normalized.weather) {
    const fields = [
      ['humidityPct', 0, 100, 'humidity', 'Relative humidity must be within 0–100%.'],
      ['temperatureC', -90, 60, 'temperature', 'Temperature is outside a broad terrestrial observing range.'],
      ['windSpeedMps', 0, 100, 'wind', 'Wind speed must be a non-negative physical value below the local safety ceiling.'],
      ['pressureHpa', 300, 1100, 'pressure', 'Pressure is outside the broad range accepted for terrestrial observatory weather logs.'],
    ];
    for (const [field, minimum, maximum, name, explanation] of fields) {
      const value = weather[field];
      if (value !== null && (value < minimum || value > maximum)) {
        addFinding({
          id: `OBS-WEATHER-${name.toUpperCase()}-${slug(weather.id)}`,
          severity: 'error',
          category: 'range',
          title: `Weather ${name} is out of range`,
          explanation,
          evidence: { weatherId: weather.id, field, value, acceptedRange: [minimum, maximum] },
          remediation: 'Correct the weather units/value or quarantine the affected observation record.',
          standards: [COORDINATE_STANDARD],
        });
      }
    }
  }
}

function validateExposureUnits(normalized, addFinding) {
  const sourceEntries = [
    ...normalized.exposureLogs.map((entry) => ({ id: entry.id, unit: entry.exposureUnit, valid: entry.exposureValid, rawUnit: entry.rawExposureUnit })),
    ...normalized.calibrationFrames.map((entry) => ({ id: entry.id, unit: entry.exposureUnit, valid: entry.exposureValid, rawUnit: entry.rawExposureUnit })),
  ].filter((entry) => entry.valid || entry.rawUnit !== undefined);
  const units = [...new Set(sourceEntries.map((entry) => entry.unit ?? 'UNKNOWN'))].sort();

  for (const entry of sourceEntries) {
    if (!entry.valid) {
      addFinding({
        id: `EXPOSURE-UNIT-INVALID-${slug(entry.id)}`,
        severity: 'error',
        category: 'units',
        title: `Exposure value or unit is invalid for ${entry.id}`,
        explanation: 'The exposure cannot be converted deterministically to seconds.',
        evidence: { recordId: entry.id, rawUnit: entry.rawUnit, normalizedUnit: entry.unit },
        remediation: 'Provide a non-negative numeric exposure and a recognized unit such as s, ms, min, or h.',
        standards: [FITS_STANDARD],
      });
    }
  }
  if (units.length > 1) {
    addFinding({
      id: 'EXPOSURE-UNITS-MIXED',
      severity: 'error',
      category: 'units',
      title: 'Exposure records use mixed units',
      explanation: 'Exposure values are normalized for display, but the source bundle combines multiple units and could be misinterpreted by a consumer that assumes seconds.',
      evidence: {
        units,
        records: sourceEntries.map((entry) => ({ id: entry.id, unit: entry.unit, rawUnit: entry.rawUnit })),
      },
      remediation: 'Rewrite source exposure values with one declared unit, preferably seconds, before pipeline ingestion.',
      standards: [FITS_STANDARD],
    });
  }
}

/**
 * A realistic, mostly usable local bundle.  It intentionally contains a
 * handful of issues so a dashboard has useful data on first launch:
 * site/target metadata disagreements, no bias frame, mixed units, and mixed
 * UTC/TAI source timestamps.  The leap-second timestamp itself is valid.
 */
export const sampleBundle = {
  metadata: {
    SIMPLE: true,
    BITPIX: -32,
    NAXIS: 2,
    NAXIS1: 4096,
    NAXIS2: 4096,
    EXTEND: true,
    OBJECT: 'M31',
    TARGET: 'M42',
    'DATE-OBS': '2016-12-31T23:59:60Z',
    TIMESYS: 'UTC',
    'MJD-OBS': 57754.0,
    OBSERVAT: 'Cerro Paranal',
    TELESCOP: 'VLT-UT1',
    TELESCOPE_SITE: 'Mauna Kea',
    EXPTIME: 30,
  },
  observatory: {
    name: 'Cerro Paranal',
    latitudeDeg: -24.627,
    longitudeDeg: -70.404,
    elevationM: 2635,
  },
  telescope: {
    name: 'VLT-UT1',
    observatory: 'Mauna Kea',
    apertureM: 8.2,
  },
  target: {
    name: 'M31',
    aliases: ['Andromeda Galaxy', 'NGC 224'],
    coordinates: { raDeg: 10.6847, decDeg: 41.2688, frame: 'ICRS' },
  },
  exposureLogs: [
    {
      id: 'science-001',
      start: '2016-12-31T23:59:60Z',
      timeSystem: 'UTC',
      exposure: 30,
      exposureUnit: 's',
      filter: 'R',
      airmass: 1.34,
      altitudeDeg: 48.2,
      weather: { temperatureC: 12.1, humidityPct: 55, windSpeedMps: 4.2, pressureHpa: 743 },
    },
    {
      id: 'science-002',
      start: '2017-01-01T00:01:00Z',
      timeSystem: 'TAI',
      exposure: 30000,
      exposureUnit: 'ms',
      filter: 'R',
      airmass: 1.41,
      altitudeDeg: 46.8,
      weather: { temperatureC: 12.0, humidityPct: 56, windSpeedMps: 4.1, pressureHpa: 743 },
    },
  ],
  calibrationFrames: [
    { id: 'dark-30s', type: 'dark', exposure: 30, exposureUnit: 's', temperatureC: 12 },
    { id: 'flat-R-5s', type: 'flat', filter: 'R', exposure: 5, exposureUnit: 's', temperatureC: 12 },
  ],
  weather: {
    id: 'weather-001',
    temperatureC: 12.1,
    humidityPct: 55,
    windSpeedMps: 4.2,
    pressureHpa: 743,
  },
};

/**
 * Validate a local observation bundle without mutating the input.
 *
 * @param {object} bundle FITS-like metadata and observation records.
 * @returns {{summary: object, findings: object[], checks: object[], normalized: object}}
 */
export function validateBundle(bundle = {}) {
  const safeBundle = isObject(bundle) ? bundle : {};
  const metadata = getMetadata(safeBundle);
  const exposureLogs = getExposureLogs(safeBundle);
  const calibrationFrames = getCalibrationFrames(safeBundle);
  const target = getTarget(safeBundle, metadata);
  const normalized = normalizeBundle(safeBundle, metadata, exposureLogs, calibrationFrames, target);
  const findings = [];
  const checks = [];
  const addFinding = addFindingFactory(findings);

  runCheck(checks, findings, 'metadata-integrity', 'metadata', 'FITS-like metadata integrity', () => {
    validateMetadata(safeBundle, metadata, normalized, addFinding);
  });
  runCheck(checks, findings, 'calibration-coverage', 'calibration', 'Calibration frame coverage', () => {
    validateCalibration(normalized, addFinding);
  });
  runCheck(checks, findings, 'time-integrity', 'time', 'Time-scale and timestamp integrity', () => {
    validateTime(safeBundle, metadata, normalized, addFinding);
  });
  runCheck(checks, findings, 'observation-ranges', 'range', 'Observation and weather ranges', () => {
    validateObservations(safeBundle, normalized, addFinding);
  });
  runCheck(checks, findings, 'exposure-units', 'units', 'Exposure-unit normalization', () => {
    validateExposureUnits(normalized, addFinding);
  });

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const infos = findings.filter((finding) => finding.severity === 'info').length;
  const summary = {
    status: errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
    valid: errors === 0,
    totalFindings: findings.length,
    errors,
    warnings,
    infos,
    checksPassed: checks.filter((check) => check.status === 'pass').length,
    checksFailed: checks.filter((check) => check.status === 'fail').length,
    checksWarned: checks.filter((check) => check.status === 'warn').length,
    normalizedExposureCount: normalized.exposureLogs.length,
  };

  return { summary, findings, checks, normalized };
}

/**
 * Build the standards-oriented, JSON-safe report consumed by the dashboard
 * and by report exporters. Keeping this projection canonical prevents the UI
 * from explaining a different finding set than the saved report contains.
 */
export function createValidationReport(result) {
  const safeResult = result ?? { summary: {}, findings: [], checks: [], normalized: {} };
  const findings = Array.isArray(safeResult.findings) ? safeResult.findings : [];
  const checks = Array.isArray(safeResult.checks) ? safeResult.checks : [];
  const normalized = safeResult.normalized ?? {};
  const standards = [...new Set([
    FITS_STANDARD,
    FITS_TIME_STANDARD,
    TIME_STANDARD,
    COORDINATE_STANDARD,
    CALIBRATION_STANDARD,
    PROFILE_STANDARD,
    ...findings.flatMap((finding) => Array.isArray(finding.standards) ? finding.standards : []),
  ])].sort();

  return {
    reportType: 'astro-pipeline-validation',
    reportVersion: '1.0',
    profile: {
      name: PROFILE_NAME,
      version: PROFILE_VERSION,
      reference: PROFILE_STANDARD,
      scope: 'Local validation of FITS-like metadata and observation-pipeline provenance.',
      limitations: [
        'This report validates FITS-like metadata only; it does not certify binary HDUs, pixel data, checksums, or WCS matrix contents.',
        'Leap-second handling uses the local immutable UTC/TAI table through 2017-01-01 and assumes the retained offset thereafter.',
      ],
    },
    summary: safeResult.summary ?? {},
    checks,
    findings,
    normalized,
    standards,
  };
}

/**
 * Canonical view model for the quality dashboard. The dashboard and JSON
 * exporter intentionally share the same report projection so finding IDs,
 * explanations, evidence, remediation, and standards cannot drift apart.
 */
export function createDashboardModel(result) {
  const report = createValidationReport(result);
  return {
    reportType: report.reportType,
    reportVersion: report.reportVersion,
    profile: report.profile,
    summary: report.summary,
    checks: report.checks,
    findings: report.findings,
    normalized: report.normalized,
    standards: report.standards,
  };
}

/** Format the canonical report as deterministic JSON for local export. */
export function formatValidationJsonReport(result) {
  return JSON.stringify(createValidationReport(result), null, 2);
}

function markdownValue(value) {
  if (typeof value === 'string') return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  if (value === undefined) return '';
  return String(value);
}

/**
 * Format a validation result as a deterministic, standards-oriented report.
 */
export function formatValidationReport(result) {
  const report = createValidationReport(result);
  const summary = report.summary;
  const findings = report.findings;
  const checks = report.checks;
  const lines = [
    '# Observation Pipeline Validation Report',
    '',
    '## Summary',
    '',
    `- **Profile:** ${markdownValue(report.profile.reference)}`,
    `- **Report type:** ${markdownValue(report.reportType)} v${markdownValue(report.reportVersion)}`,
    `- **Status:** ${String(summary.status ?? 'unknown').toUpperCase()}`,
    `- **Valid:** ${summary.valid === true ? 'yes' : 'no'}`,
    `- **Findings:** ${summary.totalFindings ?? findings.length} (${summary.errors ?? 0} errors, ${summary.warnings ?? 0} warnings, ${summary.infos ?? 0} informational)`,
    `- **Checks:** ${summary.checksPassed ?? 0} passed, ${summary.checksFailed ?? 0} failed, ${summary.checksWarned ?? 0} warned`,
    `- **Normalized science exposures:** ${summary.normalizedExposureCount ?? 0}`,
    '',
    '## Checks',
    '',
    '| Check | Category | Status | Findings |',
    '| --- | --- | --- | ---: |',
  ];
  for (const check of checks) {
    lines.push(`| ${markdownValue(check.title)} | ${markdownValue(check.category)} | ${String(check.status ?? '').toUpperCase()} | ${(check.findingIds ?? []).length} |`);
  }
  if (checks.length === 0) lines.push('| No checks | — | — | 0 |');

  lines.push('', '## Findings', '');
  if (findings.length === 0) {
    lines.push('No findings. The bundle satisfies the active local validation profile.');
  } else {
    for (const finding of findings) {
      lines.push(
        `### ${String(finding.severity ?? 'warning').toUpperCase()}: ${markdownValue(finding.title)}`,
        '',
        `- **ID:** \`${finding.id}\``,
        `- **Category:** ${markdownValue(finding.category)}`,
        `- **Explanation:** ${markdownValue(finding.explanation)}`,
        `- **Remediation:** ${markdownValue(finding.remediation)}`,
        `- **Standards:** ${(finding.standards ?? []).map(markdownValue).join('; ')}`,
        '',
        '**Evidence**',
        '',
        '```json',
        JSON.stringify(finding.evidence ?? {}, null, 2),
        '```',
        '',
      );
    }
  }

  const normalized = report.normalized;
  lines.push(
    '## Normalization',
    '',
    `- Exposure units: ${Array.isArray(normalized.exposureUnits) && normalized.exposureUnits.length > 0 ? normalized.exposureUnits.join(', ') : 'none recorded'}. All valid exposure values expose ${'`exposureSeconds`'}.`,
    `- Time systems observed: ${Array.isArray(normalized.timeSystems) && normalized.timeSystems.length > 0 ? normalized.timeSystems.join(', ') : 'none recorded'}. Valid timestamps expose ${'`startUtc`'}.`,
    '- Leap seconds are accepted only at a known UTC boundary and are represented with an explicit `leapSecond` flag.',
    '',
    '## Scope and limitations',
    '',
    ...report.profile.limitations.map((limitation) => `- ${markdownValue(limitation)}`),
    '',
  );
  return lines.join('\n');
}

export {
  canonicalUnit,
  normalizeExposure,
  normalizeTimeSystem,
  parseCoordinate,
  parseTimeValue,
  modifiedJulianDate,
};
