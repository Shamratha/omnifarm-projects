import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildCascadeIndex,
  calculateProfile,
  calculateEntryProfile,
  datasetIdentity,
  datasetTotals,
  defaultFilters,
  eligibleEventEntries,
  highlightedEventIndices,
  parseCsv,
  parseSession,
  parseTrajectory,
  parseDataset,
  pathPositions,
  profileBinIndex,
  restoreSession,
  serializeSession,
  serializeProfileCsv,
  selectRenderBudget,
  visibleEventEntries,
} from './trackLogic.ts';

const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

const event = (depth = 20, timeFs = 0, depositedEnergyEv = 10) => ({
  timeFs, positionNm: [0, 0, depth], depositedEnergyEv,
});
const track = (ionId, parentId = null, events = [event()]) => ({
  ionId, parentId, species: 'Si', kind: parentId === null ? 'primary' : 'recoil', events,
});
const payload = (tracks) => ({
  metadata: {
    name: 'Test', description: 'Test cascade', source: 'Test', ion: 'Ar', material: 'Si',
    incidentEnergyKeV: 30, targetSizeNm: [100, 100, 160],
  },
  tracks,
});

test('eight bins include their lower edge and exclude their upper edge', () => {
  for (const maxDepth of [160, 1.7]) {
    assert.equal(profileBinIndex(0, maxDepth), 0);
    for (let bin = 1; bin < 8; bin += 1) {
      const edge = (maxDepth / 8) * bin;
      const delta = edge * Number.EPSILON;
      assert.equal(profileBinIndex(edge - delta, maxDepth), bin - 1);
      assert.equal(profileBinIndex(edge, maxDepth), bin);
      assert.equal(profileBinIndex(edge + delta, maxDepth), bin);
    }
  }
});

test('exact max and out-of-range depths clamp to endpoint bins', () => {
  assert.equal(profileBinIndex(-100, 160), 0);
  assert.equal(profileBinIndex(160, 160), 7);
  assert.equal(profileBinIndex(161, 160), 7);
  assert.equal(profileBinIndex(Number.MAX_VALUE, 160), 7);
});

test('profile calculation preserves event membership, counts, totals, and means', () => {
  const bins = calculateProfile([event(-5, 0, 10), event(0, 0, 20), event(20, 0, 40), event(160, 0, 60), event(200, 0, 80)], 160);
  assert.equal(bins.length, 8);
  assert.deepEqual(bins.map((bin) => bin.eventIndices), [[0, 1], [2], [], [], [], [], [], [3, 4]]);
  assert.deepEqual(bins[0], { index: 0, startDepth: 0, endDepth: 20, totalEnergyEv: 30, eventCount: 2, meanEnergyEv: 15, eventIndices: [0, 1] });
  assert.equal(bins[7].meanEnergyEv, 70);
  assert.equal(bins[2].meanEnergyEv, 0);
  assert.equal(bins.reduce((sum, bin) => sum + bin.totalEnergyEv, 0), 210);
  assert.ok(calculateProfile([], 160).every((bin) => bin.eventCount === 0 && bin.meanEnergyEv === 0));
});

test('invalid depth domains fail explicitly rather than producing invalid bins', () => {
  for (const depth of [0, -1, NaN, Infinity]) {
    assert.throws(() => calculateProfile([], depth), /maxDepth/);
  }
  assert.throws(() => profileBinIndex(NaN, 160), /finite/);
});

test('cascade index supports roots, siblings, and nested descendants regardless of input order', () => {
  const tracks = [track(4, 2), track(3, 1), track(2, 1), track(1), track(5)];
  const index = buildCascadeIndex(tracks);
  assert.equal(index.tracksById.get(4), tracks[0]);
  assert.deepEqual(index.roots.map((item) => item.ionId), [1, 5]);
  assert.deepEqual(index.childrenById.get(1).map((item) => item.ionId), [3, 2]);
  assert.deepEqual(index.childrenById.get(2).map((item) => item.ionId), [4]);
  assert.deepEqual(index.childrenById.get(4), []);
  assert.equal(index.tracksById.get(index.tracksById.get(4).parentId).ionId, 2);
  assert.equal(buildCascadeIndex([]).tracksById.size, 0);
});

test('browser parser rejects missing parents and duplicate IDs', () => {
  assert.throws(() => parseDataset(payload([track(2, 99)])), /missing parent ionId 99/);
  assert.throws(() => parseDataset(payload([track(1), track(1)])), /Duplicate track ionId 1/);
});

test('browser parser and standalone index reject non-integer IDs and parents', () => {
  for (const value of [1.5, '1', undefined, NaN, Infinity]) {
    assert.throws(() => parseDataset(payload([track(value)])), /ionId.*(integer|finite number)/);
    assert.throws(() => buildCascadeIndex([track(value)]), /ionId.*integer/);
    const invalidParent = { ...track(1), parentId: value };
    assert.throws(() => parseDataset(payload([invalidParent])), /parentId.*integer/);
    assert.throws(() => buildCascadeIndex([invalidParent]), /parentId.*integer/);
  }
});

test('browser parser rejects self, multi-track, and disconnected parent cycles', () => {
  for (const tracks of [[track(1, 1)], [track(1, 2), track(2, 3), track(3, 1)], [track(0), track(1, 2), track(2, 1)]]) {
    assert.throws(() => parseDataset(payload(tracks)), /Parent cycle detected/);
  }
});

test('deep valid cascades do not overflow the call stack', () => {
  const tracks = Array.from({ length: 12000 }, (_, index) => track(index, index === 11999 ? null : index + 1));
  assert.equal(buildCascadeIndex(tracks).tracksById.size, 12000);
});

test('browser parser returns a validated index and rejects empty tracks clearly', () => {
  const data = parseDataset(payload([track(1), track(2, 1)]));
  assert.equal(data.cascade.childrenById.get(1)[0], data.tracks[1]);
  assert.throws(() => parseDataset(payload([track(1, null, [])])), /ionId 1.*contains no events/);
  const input = payload([track(1)]);
  input.metadata.targetSizeNm[2] = 0;
  assert.throws(() => parseDataset(input), /positive dimensions/);
});

test('one event and coincident events remain available without zero-length line segments', () => {
  const single = track(1);
  const coincident = track(2, null, [event(20, 0, 10), event(20, 1, 20), event(20, 2, 30)]);
  for (const item of [single, coincident]) {
    assert.equal(pathPositions(item.events).length, 1);
    assert.equal(visibleEventEntries(item, 10).length, item.events.length);
    assert.equal(calculateProfile(item.events, 160)[1].eventCount, item.events.length);
  }
  assert.equal(calculateProfile(coincident.events, 160)[1].totalEnergyEv, 60);
  assert.deepEqual(pathPositions([event(20), event(20), event(40), event(40), event(20)]), [[0, 0, 20], [0, 0, 40], [0, 0, 20]]);
  assert.deepEqual(pathPositions([]), []);
  assert.deepEqual(visibleEventEntries(track(1, null, []), 10), []);
});

test('time slicing retains archive indices and profile excludes future events', () => {
  const item = track(1, null, [event(20, 0), event(40, 20), event(20, 10)]);
  const entries = visibleEventEntries(item, 10);
  assert.deepEqual(entries.map(({ index }) => index), [0, 2]);
  const profile = calculateProfile(entries.map(({ event }) => event), 160);
  assert.equal(profile[1].eventCount, 2);
  assert.equal(profile[2].eventCount, 0);
});

test('event selection highlights one event; bin selection highlights only visible members on that track', () => {
  const item = track(1, null, [event(20, 0), event(21, 10), event(40, 10), event(22, 20)]);
  const selection = { selectedTrackId: 1, selectedEventIndex: 1, selectedBinIndex: 1 };
  assert.deepEqual(highlightedEventIndices(item, selection, 10, 160), [1]);
  assert.deepEqual(highlightedEventIndices(item, selection, 0, 160), []);
  selection.selectedEventIndex = null;
  assert.deepEqual(highlightedEventIndices(item, selection, 10, 160), [0, 1]);
  assert.deepEqual(highlightedEventIndices(item, selection, 20, 160), [0, 1, 3]);
  selection.selectedBinIndex = 2;
  assert.deepEqual(highlightedEventIndices(item, selection, 10, 160), [2]);
  selection.selectedBinIndex = 7;
  assert.deepEqual(highlightedEventIndices(item, selection, 20, 160), []);
  selection.selectedTrackId = 99;
  assert.deepEqual(highlightedEventIndices(item, selection, 20, 160), []);
});

test('hand-checkable fixture preserves a nested cascade and zero-length track', () => {
  const data = parseDataset(readFixture('hand-checkable-cascade.json'));
  assert.deepEqual(data.cascade.roots.map((item) => item.ionId), [10]);
  assert.deepEqual(data.cascade.childrenById.get(10).map((item) => item.ionId), [11, 13]);
  assert.deepEqual(data.cascade.childrenById.get(11).map((item) => item.ionId), [12]);
  assert.deepEqual(pathPositions(data.cascade.tracksById.get(11).events), [[1, 0, 20]]);
  assert.equal(calculateProfile(data.tracks[0].events, 160)[1].totalEnergyEv, 20);
  assert.equal(calculateProfile(data.tracks[3].events, 160)[7].eventCount, 1);
});

test('hand-checkable invalid fixtures report missing parents and cycles', () => {
  assert.throws(() => parseDataset(readFixture('invalid-missing-parent.json')), /missing parent ionId 999/);
  assert.throws(() => parseDataset(readFixture('invalid-parent-cycle.json')), /Parent cycle detected/);
});

test('CSV parser mirrors importer columns, optional event types, and rejects empty or malformed input', () => {
  const csv = 'ion_id,parent_id,species,kind,time_fs,x_nm,y_nm,z_nm,deposited_energy_ev,event_type\n1,,Ar,primary,0,0,0,1,5,ionize\n1,,Ar,primary,2,0,0,2,8,\n2,1,Si,recoil,1,1,2,3,4,phonon\n';
  const data = parseCsv(csv, 'sample.csv');
  assert.deepEqual(data.tracks.map(({ ionId }) => ionId), [1, 2]);
  assert.equal(data.tracks[0].events[0].eventType, 'ionize');
  assert.equal(data.tracks[0].events[1].eventType, undefined);
  assert.throws(() => parseCsv('ion_id,parent_id\n', 'empty.csv'), /missing columns/);
  assert.throws(() => parseTrajectory('{oops', 'broken.json'), /Malformed/);
});

const csvHeader = 'ion_id,parent_id,species,kind,time_fs,x_nm,y_nm,z_nm,deposited_energy_ev,event_type';
test('CSV accepts BOM, quoted commas, escaped quotes and multiline type labels', () => {
  const data = parseCsv(`\uFEFF${csvHeader}\r\n2,1,Si,recoil,0,0,0,0,3,"a,""b""\nc"\r\n1,null,Ar,primary,0,0,0,0,1,\r\n`);
  assert.deepEqual(data.tracks.map(({ ionId }) => ionId), [2, 1]);
  assert.equal(data.tracks[0].events[0].eventType, 'a,"b"\nc');
  assert.equal(data.cascade.childrenById.get(1)[0].ionId, 2);
});

test('CSV rejects empty rows, numeric errors, conflicting attributes and malformed quoting', () => {
  for (const text of ['', ' \n', `${csvHeader}\n`]) assert.throws(() => parseCsv(text), /missing header|no event rows/);
  assert.throws(() => parseCsv(`${csvHeader},ion_id\n`), /duplicate/);
  assert.throws(() => parseCsv(`${csvHeader}\n1,,Ar,primary,0,0,0,0,1\n`), /row length/);
  for (const value of ['', 'NaN', 'Infinity', '0x10', '-1']) {
    assert.throws(() => parseCsv(`${csvHeader}\n1,,Ar,primary,0,0,0,0,${value},\n`), /numeric|nonnegative/);
  }
  assert.throws(() => parseCsv(`${csvHeader}\n1,,Ar,primary,0,0,0,0,1,"broken`), /unterminated/);
  assert.throws(() => parseCsv(`${csvHeader}\n1,,Ar,primary,0,0,0,0,1,"x"oops`), /closing quote/);
  assert.throws(() => parseCsv(`${csvHeader}\n1,,Ar,primary,1,0,0,0,1,\n1,,Si,primary,2,0,0,0,1,`), /conflicting/);
  assert.throws(() => parseCsv(`${csvHeader}\n1,,Ar,primary,1,0,0,0,1,\n1,,Ar,primary,0,0,0,0,1,`), /chronological/);
});

test('JSON events retain optional type and reject invalid types, energies and times', () => {
  assert.equal(parseTrajectory(JSON.stringify(payload([track(1, null, [{ ...event(), eventType: 'collision' }])])), 'typed.json').tracks[0].events[0].eventType, 'collision');
  for (const eventType of ['', '  ', null, 42]) assert.throws(() => parseDataset(payload([track(1, null, [{ ...event(), eventType }])])), /eventType/);
  for (const patch of [{ timeFs: -1 }, { depositedEnergyEv: -1 }, { positionNm: [0, 0, Infinity] }]) {
    assert.throws(() => parseDataset(payload([track(1, null, [{ ...event(), ...patch }])])), /nonnegative|finite/);
  }
  for (const value of ['null', '[]', '{}']) assert.throws(() => parseTrajectory(value, 'bad.json'), /shape/);
});

test('filters preserve source event indices and profiles use the eligible subset', () => {
  const data = parseDataset(payload([track(1, null, [event(20, 0, 2), { ...event(30, 1, 20), eventType: 'hit' }, { ...event(40, 2, 7), eventType: 'hit' }]) ]));
  const filters = { eventTypes: ['hit'], minEnergyEv: 5, maxEnergyEv: null };
  assert.deepEqual(eligibleEventEntries(data.tracks[0], 2, filters).map(({ index }) => index), [1, 2]);
  assert.deepEqual(calculateEntryProfile(eligibleEventEntries(data.tracks[0], 2, filters), 160)[1].eventIndices, [1]);
  assert.deepEqual(calculateEntryProfile(eligibleEventEntries(data.tracks[0], 2, filters), 160)[2].eventIndices, [2]);
  assert.deepEqual(eligibleEventEntries(data.tracks[0], 1, { ...filters, maxEnergyEv: 10 }), []);
  assert.deepEqual(eligibleEventEntries(data.tracks[0], 2, { eventTypes: [null], minEnergyEv: 2, maxEnergyEv: 2 }).map(({ index }) => index), [0]);
  assert.deepEqual(eligibleEventEntries(data.tracks[0], 2, { ...filters, eventTypes: [] }), []);
  const selection = { selectedTrackId: 1, selectedEventIndex: null, selectedBinIndex: 1 };
  assert.deepEqual(highlightedEventIndices(data.tracks[0], selection, 2, 160, filters), [1]);
  selection.selectedEventIndex = 0;
  assert.deepEqual(highlightedEventIndices(data.tracks[0], selection, 2, 160, filters), []);
});

test('profile CSV is self-describing, escaped, scoped to eligible entries, and retains empty bins', () => {
  const data = parseDataset(payload([track(7, null, [
    { ...event(20, 0, 2), eventType: 'hit' },
    { ...event(45, 1, 9), eventType: 'ignore' },
    { ...event(160, 2, 5), eventType: 'hit' },
  ])]));
  const selectedTrack = data.tracks[0];
  const filters = { eventTypes: ['hit'], minEnergyEv: 2, maxEnergyEv: 5 };
  const entries = eligibleEventEntries(selectedTrack, 2, filters);
  assert.deepEqual(entries.map(({ index }) => index), [0, 2]);
  const bins = calculateEntryProfile(entries, 160);
  const csv = serializeProfileCsv({
    dataset: { identity: 'id-1', name: 'Name, with "quotes"', source: 'Source\nline', filename: 'archive.json' },
    track: selectedTrack,
    eligibleEntries: entries,
    currentTimeFs: 2,
    filters,
    bins,
  });
  assert.match(csv, /dataset_identity/);
  assert.match(csv, /"Name, with ""quotes"""/);
  assert.match(csv, /selected-track eligible events/);
  assert.match(csv, /,"2","20","40","1","2","2","0","1","2",/);
  assert.match(csv, /,"8","140","160","1","5","5","2","3","2",/);
  assert.match(csv, /,"1","0","20","0","0","0","","","2",/);
  assert.equal((csv.match(/selected-track eligible events/g) ?? []).length, 8);
});

test('profile CSV aggregates unsorted archive members independently of event/bin selection and render caps', () => {
  const data = parseDataset(payload([track(1, null, [
    { ...event(20, 99, 100), eventType: 'hit' },
    { ...event(20, 1, 6), eventType: 'hit' },
    { ...event(21, 2, 10), eventType: 'hit' },
    { ...event(22, 3, 8), eventType: 'other' },
    { ...event(21, 4, 2), eventType: 'hit' },
  ])]));
  const filters = { eventTypes: ['hit'], minEnergyEv: 5, maxEnergyEv: 10 };
  const entries = eligibleEventEntries(data.tracks[0], 4, filters);
  const bins = calculateEntryProfile(entries, 160);
  const state = { selectedTrackId: 1, selectedEventIndex: 2, selectedBinIndex: 1, showPrimary: true, showRecoil: true, currentTime: 4, playing: false, filters };
  assert.equal(selectRenderBudget(data, state, 1, 1).renderedEvents, 1);
  const csv = serializeProfileCsv({ dataset: { identity: 'test', name: 'Test', source: 'archive', filename: 'test.json' }, track: data.tracks[0], eligibleEntries: entries, currentTimeFs: 4, filters, bins });
  assert.match(csv, /,"2","20","40","2","16","8","1;2","2;3","2",/);
  assert.deepEqual(bins[1].eventIndices, [1, 2]);
  assert.equal(bins.reduce((sum, bin) => sum + bin.eventCount, 0), 2);
});

test('render budget is deterministic, capped, and retains an eligible selected track', () => {
  const tracks = Array.from({ length: 4 }, (_, trackIndex) => track(trackIndex + 1, null, Array.from({ length: 3 }, (_, eventIndex) => event(10 + eventIndex, eventIndex, 1))));
  const data = parseDataset(payload(tracks));
  const state = { selectedTrackId: 4, selectedEventIndex: null, selectedBinIndex: null, showPrimary: true, showRecoil: true, currentTime: 10, playing: false, filters: defaultFilters(data) };
  const budget = selectRenderBudget(data, state, 3, 2);
  assert.equal(budget.eligibleTracks, 4);
  assert.equal(budget.eligibleEvents, 12);
  assert.equal(budget.renderedEvents, 3);
  assert.deepEqual(budget.tracks.map(({ track: item }) => item.ionId), [1, 4]);
  assert.deepEqual(budget.tracks.map(({ entries }) => entries.map(({ index }) => index)), [[0, 1], [0]]);
  assert.deepEqual(selectRenderBudget(data, state, 3, 2), budget);
  assert.equal(selectRenderBudget(data, { ...state, showPrimary: false }, 3, 2).eligibleEvents, 0);
  assert.equal(selectRenderBudget(data, { ...state, filters: { ...state.filters, minEnergyEv: 2 } }, 3, 2).renderedEvents, 0);
  assert.equal(selectRenderBudget(data, state, 0, 2).renderedTracks, 0);
  assert.equal(selectRenderBudget(data, state, 3, 0).renderedTracks, 0);
  assert.throws(() => selectRenderBudget(data, state, -1, 2), /limits/);
});

test('default budget bounds large archives while analysis retains uncapped events', () => {
  const data = parseDataset(payload(Array.from({ length: 600 }, (_, index) => track(index, null, Array.from({ length: 20 }, (_, i) => event(i, i, 1))))));
  const state = { selectedTrackId: 599, selectedEventIndex: null, selectedBinIndex: null, showPrimary: true, showRecoil: true, currentTime: 20, playing: false, filters: defaultFilters(data) };
  const budget = selectRenderBudget(data, state);
  assert.equal(budget.eligibleEvents, 12000);
  assert.ok(budget.renderedEvents <= 8000 && budget.renderedTracks <= 500);
  assert.ok(budget.tracks.some(({ track: item }) => item.ionId === 599));
  assert.equal(data.tracks.reduce((sum, item) => sum + item.events.length, 0), 12000);
});

test('checked large CSV imports, reports honest counts, filters, and restores its session', () => {
  const filename = 'synthetic-render-load.csv';
  const data = parseTrajectory(readFileSync(fixturePath(filename), 'utf8'), filename);
  assert.deepEqual(datasetTotals(data), { tracks: 320, events: 20480, maxTime: 254 });
  const state = { selectedTrackId: 320, selectedEventIndex: null, selectedBinIndex: null,
    showPrimary: true, showRecoil: true, currentTime: 254, playing: false, filters: defaultFilters(data) };
  const budget = selectRenderBudget(data, state);
  assert.equal(budget.eligibleTracks, 320);
  assert.equal(budget.eligibleEvents, 20480);
  assert.equal(budget.renderedEvents, 8000);
  assert.equal(budget.renderedEvents, budget.tracks.reduce((sum, item) => sum + item.entries.length, 0));
  assert.ok(budget.tracks.some(({ track: item }) => item.ionId === 320));
  const filtered = { ...state, filters: { eventTypes: ['collision'], minEnergyEv: 100, maxEnergyEv: 150 } };
  const expected = data.tracks.flatMap((item) => item.events).filter((item) =>
    item.eventType === 'collision' && item.depositedEnergyEv >= 100 && item.depositedEnergyEv <= 150).length;
  const filteredBudget = selectRenderBudget(data, filtered);
  assert.equal(filteredBudget.eligibleEvents, expected);
  assert.equal(filteredBudget.renderedEvents, expected);
  assert.equal(datasetTotals(data).events, 20480);
  const reference = { identity: datasetIdentity(data), name: data.metadata.name, source: data.metadata.source, filename };
  const session = parseSession(JSON.parse(serializeSession({ version: 1, dataset: reference,
    camera: { position: [245, -265, 215], target: [0, 0, 80] }, state: filtered })));
  const restored = restoreSession(session, data, reference, 8);
  assert.equal(restored.matches, true);
  assert.deepEqual(restored.camera, session.camera);
  assert.deepEqual(restored.state, filtered);
});

test('session serialization validates state and safely clears mismatched dataset selections', () => {
  const data = parseDataset(payload([track(1)]));
  const reference = { identity: datasetIdentity(data), name: data.metadata.name, source: data.metadata.source, filename: 'one.json' };
  const session = { version: 1, dataset: reference, camera: { position: [1, 2, 3], target: [4, 5, 6] }, state: {
    selectedTrackId: 1, selectedEventIndex: 0, selectedBinIndex: 1, showPrimary: true, showRecoil: false, currentTime: 0, playing: true,
    filters: defaultFilters(data),
  } };
  const roundTrip = parseSession(JSON.parse(serializeSession(session)));
  assert.deepEqual(roundTrip.camera.target, [4, 5, 6]);
  assert.equal(roundTrip.state.selectedTrackId, 1);
  const mismatch = restoreSession(roundTrip, data, { ...reference, identity: 'other', filename: 'other.json' }, 8);
  assert.equal(mismatch.camera, null);
  assert.equal(mismatch.state.selectedTrackId, null);
  assert.match(mismatch.message, /mismatch|Re-import/);
  assert.throws(() => parseSession({ ...session, state: { ...session.state, filters: { ...session.state.filters, minEnergyEv: 9, maxEnergyEv: 1 } } }), /minimum energy/);
  const restored = restoreSession(roundTrip, data, reference, 8);
  assert.equal(restored.state.selectedEventIndex, 0);
  assert.equal(restored.state.playing, false);
  assert.deepEqual(restored.camera, roundTrip.camera);
  assert.equal('tracks' in JSON.parse(serializeSession(session)), false);
  for (const badState of [{ selectedTrackId: 99 }, { selectedEventIndex: 99 }, { showPrimary: false }, { filters: { ...session.state.filters, eventTypes: [] } }]) {
    const result = restoreSession({ ...session, state: { ...session.state, ...badState } }, data, reference, 8);
    assert.equal(result.state.selectedEventIndex, null);
    assert.match(result.message, /cleared/);
  }
  assert.equal(restoreSession({ ...session, state: { ...session.state, selectedEventIndex: null, selectedBinIndex: 7 } }, data, reference, 4).state.selectedBinIndex, null);
  assert.equal(datasetIdentity(parseDataset(payload([track(1)]))), reference.identity);
  assert.notEqual(datasetIdentity(parseDataset(payload([track(1, null, [event(20, 0, 99)])]))), reference.identity);
  for (const invalid of [{ ...session, version: 2 }, { ...session, camera: { position: [NaN, 2, 3], target: [0, 0, 0] } }, { ...session, state: { ...session.state, selectedEventIndex: -1 } }]) {
    assert.throws(() => parseSession(invalid));
  }
});
