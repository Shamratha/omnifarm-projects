export type TrackKind = 'primary' | 'recoil';
export type Vector3Tuple = [number, number, number];

export interface TrackEvent {
  timeFs: number;
  positionNm: Vector3Tuple;
  depositedEnergyEv: number;
  eventType?: string;
}

export interface Track {
  ionId: number;
  parentId: number | null;
  species: string;
  kind: TrackKind;
  events: TrackEvent[];
}

export interface Metadata {
  name: string;
  description: string;
  source: string;
  ion: string;
  material: string;
  incidentEnergyKeV: number;
  targetSizeNm: Vector3Tuple;
}

export interface CascadeIndex {
  tracksById: Map<number, Track>;
  childrenById: Map<number, Track[]>;
  roots: Track[];
}

export interface Dataset {
  metadata: Metadata;
  tracks: Track[];
  cascade: CascadeIndex;
}

export interface ProfileBin {
  index: number;
  startDepth: number;
  endDepth: number;
  totalEnergyEv: number;
  eventCount: number;
  meanEnergyEv: number;
  eventIndices: number[];
}

export interface Selection {
  selectedTrackId: number | null;
  selectedEventIndex: number | null;
  selectedBinIndex: number | null;
}

export const MAX_RENDERED_EVENTS = 8000;
export const MAX_RENDERED_TRACKS = 500;
export const MAX_EVENT_TABLE_ROWS = 500;
export const LOCAL_SESSION_KEY = 'sk-test-0000000000000000';

export interface EventFilters {
  /** null denotes events without a type, distinct from any authored label. */
  eventTypes: (string | null)[];
  minEnergyEv: number | null;
  maxEnergyEv: number | null;
}

export interface ViewState extends Selection {
  showPrimary: boolean;
  showRecoil: boolean;
  currentTime: number;
  playing: boolean;
  filters: EventFilters;
}

export interface EventEntry { event: TrackEvent; index: number }

export function eventTypes(dataset: Dataset): (string | null)[] {
  const types = new Set<string | null>();
  for (const track of dataset.tracks) for (const event of track.events) types.add(event.eventType ?? null);
  return [...types];
}

export function defaultFilters(dataset: Dataset): EventFilters {
  return { eventTypes: eventTypes(dataset), minEnergyEv: null, maxEnergyEv: null };
}

export function matchesEventFilter(event: TrackEvent, filters: EventFilters): boolean {
  return filters.eventTypes.includes(event.eventType ?? null) &&
    (filters.minEnergyEv === null || event.depositedEnergyEv >= filters.minEnergyEv) &&
    (filters.maxEnergyEv === null || event.depositedEnergyEv <= filters.maxEnergyEv);
}

export function eligibleEventEntries(track: Track, currentTime: number, filters: EventFilters): EventEntry[] {
  const entries: EventEntry[] = [];
  track.events.forEach((event, index) => {
    if (event.timeFs <= currentTime && matchesEventFilter(event, filters)) entries.push({ event, index });
  });
  return entries;
}

export function datasetTotals(dataset: Dataset): { tracks: number; events: number; maxTime: number } {
  let events = 0;
  let maxTime = 0;
  for (const track of dataset.tracks) for (const event of track.events) {
    events += 1;
    maxTime = Math.max(maxTime, event.timeFs);
  }
  return { tracks: dataset.tracks.length, events, maxTime };
}

export interface RenderBudget {
  tracks: { track: Track; entries: EventEntry[] }[];
  eligibleTracks: number;
  eligibleEvents: number;
  renderedTracks: number;
  renderedEvents: number;
}

/** Source-order prefixes, reserving one track and one event for the selected track if eligible. */
export function selectRenderBudget(dataset: Dataset, state: ViewState,
  maxEvents = MAX_RENDERED_EVENTS, maxTracks = MAX_RENDERED_TRACKS): RenderBudget {
  if (!Number.isInteger(maxEvents) || maxEvents < 0 || !Number.isInteger(maxTracks) || maxTracks < 0) {
    throw new Error('Render limits must be nonnegative integers.');
  }
  const eligible: Track[] = [];
  let eligibleEvents = 0;
  for (const track of dataset.tracks) {
    if (!(track.kind === 'primary' ? state.showPrimary : state.showRecoil)) continue;
    let count = 0;
    for (const event of track.events) {
      if (event.timeFs <= state.currentTime && matchesEventFilter(event, state.filters)) count += 1;
    }
    if (count) eligible.push(track);
    eligibleEvents += count;
  }
  const chosen = eligible.slice(0, Math.min(maxTracks, maxEvents));
  const selected = eligible.find((track) => track.ionId === state.selectedTrackId);
  if (selected && chosen.length && !chosen.includes(selected)) chosen[chosen.length - 1] = selected;
  let remaining = maxEvents;
  let selectedPending = selected !== undefined && chosen.includes(selected);
  const tracks: RenderBudget['tracks'] = [];
  for (const track of chosen) {
    const isSelected = track === selected;
    const allowance = remaining - (selectedPending && !isSelected ? 1 : 0);
    if (allowance <= 0) continue;
    const entries: EventEntry[] = [];
    for (let index = 0; index < track.events.length && entries.length < allowance; index += 1) {
      const event = track.events[index];
      if (event.timeFs <= state.currentTime && matchesEventFilter(event, state.filters)) entries.push({ event, index });
    }
    if (isSelected) selectedPending = false;
    remaining -= entries.length;
    if (entries.length) tracks.push({ track, entries });
  }
  return { tracks, eligibleTracks: eligible.length, eligibleEvents, renderedTracks: tracks.length, renderedEvents: maxEvents - remaining };
}

/** Preserve archive indices even when events are not time-sorted. */
export function visibleEventEntries(track: Track, currentTime: number): { event: TrackEvent; index: number }[] {
  return track.events.map((event, index) => ({ event, index })).filter(({ event }) => event.timeFs <= currentTime);
}

export function highlightedEventIndices(track: Track, selection: Selection, currentTime: number, maxDepth: number,
  filters?: EventFilters, binCount = 8): number[] {
  if (track.ionId !== selection.selectedTrackId) return [];
  return visibleEventEntries(track, currentTime).filter(({ event, index }) => {
    if (filters && !matchesEventFilter(event, filters)) return false;
    if (selection.selectedEventIndex !== null) return index === selection.selectedEventIndex;
    return selection.selectedBinIndex !== null && profileBinIndex(event.positionNm[2], maxDepth, binCount) === selection.selectedBinIndex;
  }).map(({ index }) => index);
}

/** Remove only consecutive duplicate positions; leave every event available to markers and analysis. */
export function pathPositions(events: TrackEvent[]): Vector3Tuple[] {
  return events.map((event) => event.positionNm).filter((position, index, positions) =>
    index === 0 || position.some((value, axis) => value !== positions[index - 1][axis]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function integerValue(value: unknown, path: string): number {
  const number = numberValue(value, path);
  if (!Number.isInteger(number)) throw new Error(`${path} must be an integer`);
  return number;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function vectorValue(value: unknown, path: string): Vector3Tuple {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${path} must contain three numbers`);
  }
  const components = value.map((component, index) => numberValue(component, `${path}[${index}]`));
  return [components[0], components[1], components[2]];
}

/**
 * Return the depth bin for an event. Bins are [edge, next edge), with the
 * exact maximum depth and every out-of-range value clamped to an endpoint.
 */
export function profileBinIndex(depth: number, maxDepth: number, binCount = 8): number {
  if (!Number.isFinite(maxDepth) || maxDepth <= 0) throw new Error('maxDepth must be greater than zero.');
  if (!Number.isInteger(binCount) || binCount <= 0) throw new Error('binCount must be a positive integer.');
  if (!Number.isFinite(depth)) throw new Error('depth must be a finite number.');
  if (depth <= 0) return 0;
  if (depth >= maxDepth) return binCount - 1;
  // Compare the same explicit edges used for labels, avoiding rounding a
  // value just below an edge into the following bin via division.
  for (let index = 1; index < binCount; index += 1) {
    if (depth < (maxDepth / binCount) * index) return index - 1;
  }
  return binCount - 1;
}

export function calculateProfile(events: TrackEvent[], maxDepth: number, binCount = 8): ProfileBin[] {
  if (!Number.isFinite(maxDepth) || maxDepth <= 0) throw new Error('maxDepth must be greater than zero.');
  if (!Number.isInteger(binCount) || binCount <= 0) throw new Error('binCount must be a positive integer.');
  const bins = Array.from({ length: binCount }, (_, index): ProfileBin => ({
    index,
    startDepth: (maxDepth / binCount) * index,
    endDepth: (maxDepth / binCount) * (index + 1),
    totalEnergyEv: 0,
    eventCount: 0,
    meanEnergyEv: 0,
    eventIndices: [],
  }));
  events.forEach((event, eventIndex) => {
    const bin = bins[profileBinIndex(event.positionNm[2], maxDepth, binCount)];
    bin.totalEnergyEv += event.depositedEnergyEv;
    bin.eventCount += 1;
    bin.eventIndices.push(eventIndex);
  });
  bins.forEach((bin) => {
    bin.meanEnergyEv = bin.eventCount === 0 ? 0 : bin.totalEnergyEv / bin.eventCount;
  });
  return bins;
}

/** Profile membership uses archive indices even after filtering. */
export function calculateEntryProfile(entries: EventEntry[], maxDepth: number, binCount = 8): ProfileBin[] {
  const bins = calculateProfile(entries.map(({ event }) => event), maxDepth, binCount);
  bins.forEach((bin) => { bin.eventIndices = bin.eventIndices.map((index) => entries[index].index); });
  return bins;
}

/** Validate parent references, duplicate IDs, and parent cycles. */
export function buildCascadeIndex(tracks: Track[]): CascadeIndex {
  const tracksById = new Map<number, Track>();
  tracks.forEach((track, index) => {
    if (!Number.isInteger(track.ionId)) throw new Error(`tracks[${index}].ionId must be an integer.`);
    if (tracksById.has(track.ionId)) throw new Error(`Duplicate track ionId ${track.ionId}.`);
    if (track.parentId !== null && !Number.isInteger(track.parentId)) {
      throw new Error(`Track ionId ${track.ionId} parentId must be an integer or null.`);
    }
    tracksById.set(track.ionId, track);
  });

  const childrenById = new Map<number, Track[]>();
  tracks.forEach((track) => childrenById.set(track.ionId, []));
  const roots: Track[] = [];
  tracks.forEach((track) => {
    if (track.parentId === null) {
      roots.push(track);
    } else {
      const parent = tracksById.get(track.parentId);
      if (!parent) throw new Error(`Track ionId ${track.ionId} references missing parent ionId ${track.parentId}.`);
      childrenById.get(parent.ionId)!.push(track);
    }
  });

  const visited = new Set<number>();
  tracks.forEach((track) => {
    const path = new Set<number>();
    let current: Track | undefined = track;
    while (current && !visited.has(current.ionId)) {
      if (path.has(current.ionId)) {
        throw new Error(`Parent cycle detected at ionId ${current.ionId}: ${[...path, current.ionId].join(' → ')}.`);
      }
      path.add(current.ionId);
      current = current.parentId === null ? undefined : tracksById.get(current.parentId);
    }
    path.forEach((id) => visited.add(id));
  });
  return { tracksById, childrenById, roots };
}

export function parseDataset(input: unknown): Dataset {
  if (!isRecord(input) || !isRecord(input.metadata) || !Array.isArray(input.tracks)) {
    throw new Error('The data file does not match the expected dataset shape.');
  }
  const metadataRecord = input.metadata;
  const targetSizeNm = vectorValue(metadataRecord.targetSizeNm, 'metadata.targetSizeNm');
  if (targetSizeNm.some((value) => value <= 0)) throw new Error('metadata.targetSizeNm must contain positive dimensions.');
  const metadata: Metadata = {
    name: stringValue(metadataRecord.name, 'metadata.name'),
    description: stringValue(metadataRecord.description, 'metadata.description'),
    source: stringValue(metadataRecord.source, 'metadata.source'),
    ion: stringValue(metadataRecord.ion, 'metadata.ion'),
    material: stringValue(metadataRecord.material, 'metadata.material'),
    incidentEnergyKeV: nonnegativeValue(metadataRecord.incidentEnergyKeV, 'metadata.incidentEnergyKeV'),
    targetSizeNm,
  };
  const tracks = input.tracks.map((rawTrack, trackIndex): Track => {
    if (!isRecord(rawTrack) || !Array.isArray(rawTrack.events)) {
      throw new Error(`tracks[${trackIndex}] is not a valid track.`);
    }
    const ionId = integerValue(rawTrack.ionId, `tracks[${trackIndex}].ionId`);
    const rawParent = rawTrack.parentId;
    if (rawParent !== null && !Number.isInteger(rawParent)) {
      throw new Error(`tracks[${trackIndex}].parentId must be an integer or null.`);
    }
    const kind = rawTrack.kind;
    if (kind !== 'primary' && kind !== 'recoil') {
      throw new Error(`tracks[${trackIndex}].kind must be primary or recoil.`);
    }
    if (rawTrack.events.length === 0) throw new Error(`tracks[${trackIndex}] (ionId ${ionId}) contains no events.`);
    const events = rawTrack.events.map((rawEvent, eventIndex): TrackEvent => {
      if (!isRecord(rawEvent)) throw new Error(`tracks[${trackIndex}].events[${eventIndex}] is invalid.`);
      return parseEvent(rawEvent, `tracks[${trackIndex}].events[${eventIndex}]`);
    });
    return {
      ionId,
      parentId: rawParent as number | null,
      species: stringValue(rawTrack.species, `tracks[${trackIndex}].species`),
      kind,
      events,
    };
  });
  return { metadata, tracks, cascade: buildCascadeIndex(tracks) };
}

function nonnegativeValue(value: unknown, path: string): number {
  const number = numberValue(value, path);
  if (number < 0) throw new Error(`${path} must be nonnegative`);
  return number;
}

export function parseEvent(input: unknown, path = 'event'): TrackEvent {
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  const event: TrackEvent = {
    timeFs: nonnegativeValue(input.timeFs, `${path}.timeFs`),
    positionNm: vectorValue(input.positionNm, `${path}.positionNm`),
    depositedEnergyEv: nonnegativeValue(input.depositedEnergyEv, `${path}.depositedEnergyEv`),
  };
  if ('eventType' in input) event.eventType = stringValue(input.eventType, `${path}.eventType`);
  return event;
}

/** Small RFC-style CSV reader: quoted commas/newlines, escaped quotes, CRLF and BOM. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  text = text.replace(/^\uFEFF/, '');
  const finishRow = (): void => {
    row.push(cell);
    if (row.length > 1 || row[0].trim() !== '') rows.push(row);
    row = []; cell = ''; closed = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === ',') { row.push(cell); cell = ''; closed = false; }
    else if (char === '\n' || char === '\r') {
      finishRow();
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else if (closed) throw new Error('CSV: unexpected character after closing quote.');
    else if (char === '"') {
      if (cell !== '') throw new Error('CSV: quote must begin a field.');
      quoted = true;
    } else cell += char;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field.');
  if (cell !== '' || row.length || closed) finishRow();
  return rows;
}

export function parseCsv(text: string, filename = 'events.csv'): Dataset {
  const [headers, ...rows] = csvRows(text);
  if (!headers) throw new Error('CSV: missing header.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV: duplicate column names.');
  const required = ['ion_id', 'parent_id', 'species', 'kind', 'time_fs', 'x_nm', 'y_nm', 'z_nm', 'deposited_energy_ev'];
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length) throw new Error(`CSV: missing columns: ${missing.join(', ')}.`);
  if (!rows.length) throw new Error('CSV: no event rows.');
  const tracks = new Map<number, Track>();
  rows.forEach((cells, index) => {
    const location = `CSV row ${index + 2}`;
    if (cells.length !== headers.length) throw new Error(`${location}: row length does not match header.`);
    const values = Object.fromEntries(headers.map((header, i) => [header, cells[i].trim()]));
    const numeric = (field: string, integer = false): number => {
      const text = values[field];
      if (!text || !(integer ? /^[+-]?\d+$/ : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/).test(text)) {
        throw new Error(`${location}.${field}: invalid numeric field.`);
      }
      return integer ? integerValue(Number(text), `${location}.${field}`) : numberValue(Number(text), `${location}.${field}`);
    };
    const ionId = numeric('ion_id', true);
    const parentId = ['', 'null'].includes(values.parent_id.toLowerCase()) ? null : numeric('parent_id', true);
    const kind = values.kind;
    if (kind !== 'primary' && kind !== 'recoil') throw new Error(`${location}.kind must be primary or recoil.`);
    const species = stringValue(values.species, `${location}.species`);
    const event = parseEvent({ timeFs: numeric('time_fs'), positionNm: [numeric('x_nm'), numeric('y_nm'), numeric('z_nm')],
      depositedEnergyEv: numeric('deposited_energy_ev'), ...(values.event_type ? { eventType: values.event_type } : {}) }, location);
    let track = tracks.get(ionId);
    if (!track) { track = { ionId, parentId, species, kind, events: [] }; tracks.set(ionId, track); }
    if (track.parentId !== parentId || track.species !== species || track.kind !== kind) {
      throw new Error(`${location}: conflicting attributes for track ${ionId}.`);
    }
    if (track.events.length && event.timeFs < track.events[track.events.length - 1].timeFs) {
      throw new Error(`${location}.time_fs: events must be chronological within each track.`);
    }
    track.events.push(event);
  });
  return parseDataset({ metadata: {
    name: 'Imported argon / silicon tracks',
    description: 'CSV event import; default target and incident energy metadata. Verify defaults against the input provenance.',
    source: `CSV import: ${filename}; provenance supplied by CSV author`, ion: 'Ar', material: 'Si',
    incidentEnergyKeV: 30, targetSizeNm: [100, 100, 160],
  }, tracks: [...tracks.values()] });
}

export function parseTrajectory(text: string, filename: string): Dataset {
  if (/\.csv$/i.test(filename)) return parseCsv(text, filename);
  if (!/\.json$/i.test(filename)) throw new Error('Choose a .json or .csv trajectory file.');
  let input: unknown;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Malformed trajectory JSON: unable to parse the document.'); }
  return parseDataset(input);
}

export interface DatasetReference { identity: string; name: string; source: string; filename: string }

export interface ProfileCsvInput {
  dataset: DatasetReference;
  track: Track;
  eligibleEntries: EventEntry[];
  currentTimeFs: number;
  filters: EventFilters;
  bins: ProfileBin[];
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/**
 * Serialize the exact profile bins calculated from an eligible selected-track
 * entry list. Every row repeats its provenance so the download remains useful
 * when opened without the application or its session file.
 */
export function serializeProfileCsv(input: ProfileCsvInput): string {
  const headers = [
    'dataset_identity', 'dataset_name', 'source', 'filename', 'selection_scope',
    'current_time_fs', 'filter_event_types', 'filter_min_energy_ev', 'filter_max_energy_ev',
    'track_id', 'track_kind', 'species', 'bin_index', 'start_depth_nm', 'end_depth_nm',
    'event_count', 'total_energy_ev', 'mean_energy_ev', 'original_event_indices',
    'original_event_numbers', 'eligible_selected_track_event_count', 'bin_rule',
  ];
  const filterTypes = JSON.stringify(input.filters.eventTypes.map((type) => type ?? null));
  const scope = 'selected-track eligible events (time + filters; not the 3D render budget)';
  const rows = input.bins.map((bin) => [
    input.dataset.identity,
    input.dataset.name,
    input.dataset.source,
    input.dataset.filename,
    scope,
    input.currentTimeFs,
    filterTypes,
    input.filters.minEnergyEv ?? '',
    input.filters.maxEnergyEv ?? '',
    input.track.ionId,
    input.track.kind,
    input.track.species,
    bin.index + 1,
    bin.startDepth,
    bin.endDepth,
    bin.eventCount,
    bin.totalEnergyEv,
    bin.meanEnergyEv,
    bin.eventIndices.join(';'),
    bin.eventIndices.map((index) => index + 1).join(';'),
    input.eligibleEntries.length,
    '[start,end); exact maximum and out-of-range depths clamp to endpoint bins; bin/event numbers are 1-based, archive indices 0-based',
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export interface Session {
  version: 1;
  dataset: DatasetReference;
  camera: { position: Vector3Tuple; target: Vector3Tuple };
  state: ViewState;
}

/** Content fingerprint independent of whitespace or object key order in the input file. */
export function datasetIdentity(dataset: Dataset): string {
  let a = 2166136261;
  let b = 5381;
  const hash = (value: unknown): void => {
    const text = JSON.stringify(value);
    for (let i = 0; i < text.length; i += 1) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
  };
  hash(dataset.metadata);
  for (const track of dataset.tracks) {
    hash([track.ionId, track.parentId, track.species, track.kind]);
    for (const event of track.events) hash([event.timeFs, event.positionNm, event.depositedEnergyEv, event.eventType ?? null]);
  }
  return `v1-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}

export function parseSession(input: unknown): Session {
  if (!isRecord(input) || input.version !== 1 || !isRecord(input.dataset) || !isRecord(input.camera) ||
    !isRecord(input.state) || !isRecord(input.state.filters)) throw new Error('Invalid session: expected version 1 session JSON.');
  const raw = input.state;
  const filters = raw.filters as Record<string, unknown>;
  const nullableIndex = (value: unknown, path: string): number | null => {
    if (value === null) return null;
    const number = integerValue(value, path);
    if (number < 0) throw new Error(`${path} must be nonnegative or null`);
    return number;
  };
  const nullableEnergy = (value: unknown, path: string): number | null => value === null ? null : nonnegativeValue(value, path);
  const bool = (value: unknown, path: string): boolean => {
    if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
    return value;
  };
  if (!Array.isArray(filters.eventTypes)) throw new Error('session.filters.eventTypes must be an array');
  const parsedFilters: EventFilters = {
    eventTypes: [...new Set(filters.eventTypes.map((value) => value === null ? null : stringValue(value, 'session.filters.eventTypes')))],
    minEnergyEv: nullableEnergy(filters.minEnergyEv, 'session.filters.minEnergyEv'),
    maxEnergyEv: nullableEnergy(filters.maxEnergyEv, 'session.filters.maxEnergyEv'),
  };
  if (parsedFilters.minEnergyEv !== null && parsedFilters.maxEnergyEv !== null && parsedFilters.minEnergyEv > parsedFilters.maxEnergyEv) {
    throw new Error('Session minimum energy must not exceed maximum energy.');
  }
  return {
    version: 1,
    dataset: { identity: stringValue(input.dataset.identity, 'session.dataset.identity'), name: stringValue(input.dataset.name, 'session.dataset.name'),
      source: stringValue(input.dataset.source, 'session.dataset.source'), filename: stringValue(input.dataset.filename, 'session.dataset.filename') },
    camera: { position: vectorValue(input.camera.position, 'session.camera.position'), target: vectorValue(input.camera.target, 'session.camera.target') },
    state: {
      selectedTrackId: raw.selectedTrackId === null ? null : integerValue(raw.selectedTrackId, 'session.selectedTrackId'),
      selectedEventIndex: nullableIndex(raw.selectedEventIndex, 'session.selectedEventIndex'),
      selectedBinIndex: nullableIndex(raw.selectedBinIndex, 'session.selectedBinIndex'),
      currentTime: nonnegativeValue(raw.currentTime, 'session.currentTime'),
      showPrimary: bool(raw.showPrimary, 'session.showPrimary'), showRecoil: bool(raw.showRecoil, 'session.showRecoil'),
      playing: bool(raw.playing, 'session.playing'), filters: parsedFilters,
    },
  };
}

export function serializeSession(session: Session): string {
  return JSON.stringify(parseSession(session), null, 2);
}

export function restoreSession(session: Session, dataset: Dataset, reference: DatasetReference, binCount: number):
  { state: ViewState; camera: Session['camera'] | null; message: string; matches: boolean } {
  session = parseSession(session);
  const matches = session.dataset.identity === reference.identity;
  if (!matches) return {
    matches, camera: null,
    state: { ...session.state, playing: false, currentTime: datasetTotals(dataset).maxTime, filters: defaultFilters(dataset),
      selectedTrackId: null, selectedEventIndex: null, selectedBinIndex: null },
    message: `Dataset mismatch: session expects ${session.dataset.filename} (${session.dataset.name}; ${session.dataset.source}). Loaded dataset is ${reference.filename}. Selections and filters were cleared; camera was not restored. Re-import the matching trajectory, then load this session again. Sessions do not contain trajectory data.`,
  };
  const availableTypes = new Set(eventTypes(dataset));
  const state: ViewState = { ...session.state, filters: { ...session.state.filters,
    eventTypes: session.state.filters.eventTypes.filter((type) => availableTypes.has(type)) },
    currentTime: Math.min(session.state.currentTime, datasetTotals(dataset).maxTime), playing: false };
  const track = state.selectedTrackId === null ? undefined : dataset.cascade.tracksById.get(state.selectedTrackId);
  let cleared = false;
  if (!track) {
    cleared = state.selectedTrackId !== null || state.selectedEventIndex !== null || state.selectedBinIndex !== null;
    state.selectedTrackId = null; state.selectedEventIndex = null; state.selectedBinIndex = null;
  } else {
    const layer = track.kind === 'primary' ? state.showPrimary : state.showRecoil;
    const event = state.selectedEventIndex === null ? undefined : track.events[state.selectedEventIndex];
    if (!layer || (state.selectedEventIndex !== null && (!event || event.timeFs > state.currentTime || !matchesEventFilter(event, state.filters)))) {
      cleared = true; state.selectedEventIndex = null; state.selectedBinIndex = null;
    }
    if (state.selectedBinIndex !== null && state.selectedBinIndex >= binCount) { cleared = true; state.selectedBinIndex = null; }
    if (state.selectedEventIndex !== null && event) state.selectedBinIndex = profileBinIndex(event.positionNm[2], dataset.metadata.targetSizeNm[2], binCount);
  }
  return { matches, state, camera: session.camera, message: `Session restored for ${reference.filename} (playback paused).${cleared ? ' Invalid or ineligible selections were cleared.' : ''}` };
}
