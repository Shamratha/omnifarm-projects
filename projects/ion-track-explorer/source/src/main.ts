import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  calculateEntryProfile,
  datasetIdentity,
  datasetTotals,
  defaultFilters,
  eligibleEventEntries,
  eventTypes,
  highlightedEventIndices,
  LOCAL_SESSION_KEY,
  MAX_EVENT_TABLE_ROWS,
  MAX_RENDERED_EVENTS,
  MAX_RENDERED_TRACKS,
  matchesEventFilter,
  parseDataset,
  parseSession,
  parseTrajectory,
  pathPositions,
  profileBinIndex,
  restoreSession,
  serializeSession,
  selectRenderBudget,
  serializeProfileCsv,
  type Dataset,
  type DatasetReference,
  type EventFilters,
  type EventEntry,
  type RenderBudget,
  type Session,
  type Selection,
  type Track,
  type TrackEvent,
} from './trackLogic';
import './styles.css';

interface ExplorerState extends Selection {
  showPrimary: boolean;
  showRecoil: boolean;
  currentTime: number;
  playing: boolean;
  filters: EventFilters;
}

const $ = <T extends Element>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing UI element: ${selector}`);
  return node;
};

const app = $('#app');
const viewport = $<HTMLDivElement>('#scene-viewport');
const sceneLoading = $<HTMLDivElement>('#scene-loading');
const loadStatus = $('#load-status');
const datasetName = $('#dataset-name');
const datasetDescription = $('#dataset-description');
const datasetSource = $('#dataset-source');
const importStatus = $('#import-status');
const metaIon = $('#meta-ion');
const metaMaterial = $('#meta-material');
const metaEnergy = $('#meta-energy');
const metaVolume = $('#meta-volume');
const boxSize = $('#box-size');
const primaryCount = $('#primary-count');
const recoilCount = $('#recoil-count');
const visibleCount = $('#visible-count');
const filterCount = $('#filter-count');
const eventTypeFilters = $('#event-type-filters');
const minEnergy = $<HTMLInputElement>('#min-energy');
const maxEnergy = $<HTMLInputElement>('#max-energy');
const sessionStatus = $('#session-status');
const selectedMarker = $('#selected-marker');
const selectedDetail = $('#selected-detail');
const timeSlider = $<HTMLInputElement>('#time-slider');
const timeReadout = $('#time-readout');
const maxTimeLabel = $('#max-time-label');
const sceneTimeLabel = $('#scene-time-label');
const playToggle = $<HTMLButtonElement>('#play-toggle');
const playLabel = $('#play-label');
const profileTotal = $('#profile-total');
const profileMean = $('#profile-mean');
const profileChart = $('#profile-chart');
const trackList = $('#track-list');
const eventTable = $('#event-table-body');
const eventSummary = $('#event-summary');
const selectionSummary = $('#selection-summary');
const togglePrimary = $<HTMLButtonElement>('#toggle-primary');
const toggleRecoil = $<HTMLButtonElement>('#toggle-recoil');
const trajectoryFile = $<HTMLInputElement>('#trajectory-file');
const sessionFile = $<HTMLInputElement>('#session-file');
const exportFigureButton = $<HTMLButtonElement>('#export-figure');
const exportProfileCsvButton = $<HTMLButtonElement>('#export-profile-csv');

const state: ExplorerState = {
  showPrimary: true,
  showRecoil: true,
  currentTime: 0,
  playing: false,
  selectedTrackId: null,
  selectedEventIndex: null,
  selectedBinIndex: null,
  filters: { eventTypes: [], minEnergyEv: null, maxEnergyEv: null },
};

let dataset: Dataset | null = null;
let datasetReference: DatasetReference | null = null;
let datasetSourceName = 'Bundled default';
let loadGeneration = 0;
let geometryKey = '';
let renderedBudget: RenderBudget | null = null;
let tablePage = 0;
let profileBinCount = 0;
let profileData: { track: Track; entries: EventEntry[]; bins: ReturnType<typeof calculateEntryProfile> } | null = null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d1a24');
scene.fog = new THREE.Fog('#0d1a24', 300, 560);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
const defaultCameraPosition = new THREE.Vector3(245, -265, 215);
camera.position.copy(defaultCameraPosition);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.setAttribute('aria-label', 'Rotatable 3D target volume with ion tracks');
renderer.domElement.className = 'three-canvas';
viewport.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = !reducedMotion.matches;
controls.dampingFactor = 0.07;
controls.minDistance = 125;
controls.maxDistance = 560;
controls.target.set(0, 0, 78);
controls.update();

const targetLayer = new THREE.Group();
const trackLayer = new THREE.Group();
scene.add(targetLayer, trackLayer);

const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 3.5;
raycaster.params.Points.threshold = 2.5;
const pointer = new THREE.Vector2();

function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function formatEnergy(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} keV`;
  return `${formatNumber(value)} eV`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function trackIsVisible(track: Track): boolean {
  return track.kind === 'primary' ? state.showPrimary : state.showRecoil;
}

function eligibleEntries(track: Track): EventEntry[] {
  return eligibleEventEntries(track, state.currentTime, state.filters);
}

function visibleEvents(track: Track): TrackEvent[] {
  return eligibleEntries(track).map(({ event }) => event);
}

function selectedTrack(): Track | undefined {
  return state.selectedTrackId === null ? undefined : dataset?.cascade.tracksById.get(state.selectedTrackId);
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) material.forEach((item) => item.dispose());
  else material.dispose();
}

function disposeTrackObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Sprite) {
      child.material.map?.dispose();
      child.material.dispose();
    } else if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) {
      child.geometry.dispose();
      disposeMaterial(child.material);
    }
  });
}

function makeAxisLabel(text: string, color: string, scale = 16): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas text is unavailable.');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = '600 32px monospace';
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }));
  sprite.scale.set(scale * 2.7, scale, 1);
  sprite.renderOrder = 5;
  return sprite;
}

function addWorldAxes(width: number, height: number, depth: number): void {
  const axisOffset = 8;
  const axisOrigin = new THREE.Vector3(-width / 2 - axisOffset, -height / 2 - axisOffset, 0);
  const axes: Array<{ direction: THREE.Vector3; color: string; label: string; length: number; position: THREE.Vector3 }> = [
    { direction: new THREE.Vector3(1, 0, 0), color: '#e57c72', label: 'X (nm)', length: width, position: new THREE.Vector3(-width / 2, -height / 2 - axisOffset, 0) },
    { direction: new THREE.Vector3(0, 1, 0), color: '#45c9bb', label: 'Y (nm)', length: height, position: new THREE.Vector3(-width / 2 - axisOffset, -height / 2, 0) },
    { direction: new THREE.Vector3(0, 0, 1), color: '#f2b84b', label: 'Z (nm)', length: depth, position: axisOrigin },
  ];
  axes.forEach(({ direction, color, label, length, position }) => {
    const arrow = new THREE.ArrowHelper(direction, position, length, color, Math.min(8, length * 0.08), Math.min(4, length * 0.04));
    arrow.renderOrder = 4;
    (arrow.line.material as THREE.Material).depthTest = false;
    (arrow.cone.material as THREE.Material).depthTest = false;
    targetLayer.add(arrow);
    const labelSprite = makeAxisLabel(label, color, 11);
    labelSprite.position.copy(position).addScaledVector(direction, length + 11);
    targetLayer.add(labelSprite);
  });
  const tickGroup = new THREE.Group();
  const tickMaterial = new THREE.LineBasicMaterial({ color: '#9bb7b4', transparent: true, opacity: 0.7, depthTest: false });
  const addTicks = (axis: 'x' | 'y' | 'z', maximum: number, count: number): void => {
    for (let i = 0; i <= count; i += 1) {
      const value = (maximum / count) * i;
      let start: THREE.Vector3;
      let end: THREE.Vector3;
      let labelPosition: THREE.Vector3;
      if (axis === 'x') {
        const x = -width / 2 + value;
        start = new THREE.Vector3(x, -height / 2 - axisOffset - 3, 0);
        end = new THREE.Vector3(x, -height / 2 - axisOffset + 3, 0);
        labelPosition = new THREE.Vector3(x, -height / 2 - axisOffset - 12, 0);
      } else if (axis === 'y') {
        const y = -height / 2 + value;
        start = new THREE.Vector3(-width / 2 - axisOffset - 3, y, 0);
        end = new THREE.Vector3(-width / 2 - axisOffset + 3, y, 0);
        labelPosition = new THREE.Vector3(-width / 2 - axisOffset - 14, y, 0);
      } else {
        const z = value;
        start = new THREE.Vector3(-width / 2 - axisOffset - 3, -height / 2 - axisOffset, z);
        end = new THREE.Vector3(-width / 2 - axisOffset + 3, -height / 2 - axisOffset, z);
        labelPosition = new THREE.Vector3(-width / 2 - axisOffset - 15, -height / 2 - axisOffset, z);
      }
      tickGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), tickMaterial));
      const label = makeAxisLabel(formatNumber(axis === 'z' ? value : value - maximum / 2, 2), '#b9cfca', 7);
      label.position.copy(labelPosition);
      tickGroup.add(label);
    }
  };
  addTicks('x', width, 4);
  addTicks('y', height, 4);
  addTicks('z', depth, 4);
  targetLayer.add(tickGroup);
  const scaleLength = width / 4;
  const scaleY = -height / 2 - 34;
  const scaleStart = -width / 2;
  const scaleEnd = scaleStart + scaleLength;
  const ruler = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(scaleStart, scaleY, 0), new THREE.Vector3(scaleEnd, scaleY, 0),
    new THREE.Vector3(scaleStart, scaleY - 3, 0), new THREE.Vector3(scaleStart, scaleY + 3, 0),
    new THREE.Vector3(scaleEnd, scaleY - 3, 0), new THREE.Vector3(scaleEnd, scaleY + 3, 0),
  ]), new THREE.LineBasicMaterial({ color: '#fff4dc', depthTest: false }));
  const scaleLabel = makeAxisLabel(`${formatNumber(scaleLength, 2)} nm`, '#fff4dc', 9);
  scaleLabel.position.set((scaleStart + scaleEnd) / 2, scaleY - 10, 0);
  targetLayer.add(ruler, scaleLabel);
}

function rebuildTarget(): void {
  targetLayer.children.forEach(disposeTrackObject);
  targetLayer.clear();
  if (!dataset) return;
  const [width, height, depth] = dataset.metadata.targetSizeNm;
  const boxGeometry = new THREE.BoxGeometry(width, height, depth);
  const boxMaterial = new THREE.MeshBasicMaterial({ color: '#28b8b0', transparent: true, opacity: 0.025, side: THREE.DoubleSide });
  const box = new THREE.Mesh(boxGeometry, boxMaterial);
  box.position.set(0, 0, depth / 2);
  targetLayer.add(box);

  const edges = new THREE.EdgesGeometry(boxGeometry);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: '#49b9b0', transparent: true, opacity: 0.42 });
  const wireframe = new THREE.LineSegments(edges, edgeMaterial);
  wireframe.position.copy(box.position);
  targetLayer.add(wireframe);

  const grid = new THREE.GridHelper(width, 10, '#27635f', '#173c3c');
  grid.rotation.x = Math.PI / 2;
  grid.position.z = 0.2;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.38;
  targetLayer.add(grid);

  const guideBox = new THREE.BoxGeometry(width * 0.96, height * 0.96, depth * 0.96);
  const depthGuide = new THREE.LineSegments(
    new THREE.EdgesGeometry(guideBox),
    new THREE.LineBasicMaterial({ color: '#d69b3d', transparent: true, opacity: 0.09 }),
  );
  guideBox.dispose();
  depthGuide.position.set(0, 0, depth / 2);
  targetLayer.add(depthGuide);
  addWorldAxes(width, height, depth);
}

function rebuildTracks(budget: RenderBudget): void {
  // Time changes that reveal no new budgeted events need no geometry allocation.
  const key = JSON.stringify([datasetReference?.identity, state.selectedTrackId, state.selectedEventIndex,
    state.selectedBinIndex, budget.tracks.map(({ track, entries }) => [track.ionId, entries.map(({ index }) => index)])]);
  if (key === geometryKey) return;
  geometryKey = key;
  while (trackLayer.children.length > 0) {
    const child = trackLayer.children[0];
    trackLayer.remove(child);
    disposeTrackObject(child);
  }
  if (!dataset) return;

  budget.tracks.forEach(({ track, entries }) => {
    const events = entries.map(({ event }) => event);
    const group = new THREE.Group();
    const isPrimary = track.kind === 'primary';
    const isSelected = track.ionId === state.selectedTrackId;
    const color = isSelected ? '#fff4dc' : isPrimary ? '#f2b84b' : '#45c9bb';
    const points = events.map((event) => new THREE.Vector3(event.positionNm[0], event.positionNm[1], event.positionNm[2]));
    const linePoints = pathPositions(events).map((position) => new THREE.Vector3(...position));
    if (linePoints.length > 1) {
      const lineMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: isSelected ? 1 : isPrimary ? 0.9 : 0.72 });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePoints), lineMaterial);
      line.userData.trackId = track.ionId;
      group.add(line);
    }
    const pointGeometry = new THREE.BufferGeometry().setFromPoints(points);
    const pointMaterial = new THREE.PointsMaterial({ color, size: isSelected ? 7 : 4.6, sizeAttenuation: true, transparent: true, opacity: isSelected ? 1 : 0.8 });
    const eventPoints = new THREE.Points(pointGeometry, pointMaterial);
    eventPoints.userData.trackId = track.ionId;
    eventPoints.userData.eventIndices = entries.map(({ index }) => index);
    group.add(eventPoints);
    const highlighted = new Set(highlightedEventIndices(track, state, state.currentTime, dataset!.metadata.targetSizeNm[2], state.filters, profileBinCount));
    const focusPoints = points.filter((_, index) => highlighted.has(entries[index].index));
    if (focusPoints.length > 0) {
      const focus = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints(focusPoints),
        new THREE.PointsMaterial({ color: '#f2b84b', size: 12, sizeAttenuation: true, depthTest: false }),
      );
      focus.renderOrder = 1;
      // Pick the underlying event array so coincident markers keep stable indices.
      focus.raycast = () => {};
      group.add(focus);
    }
    group.userData.trackId = track.ionId;
    trackLayer.add(group);
  });
}

function renderMetadata(): void {
  if (!dataset) return;
  const { metadata, tracks } = dataset;
  const primaries = tracks.filter((track) => track.kind === 'primary').length;
  const recoils = tracks.filter((track) => track.kind === 'recoil').length;
  const { maxTime } = datasetTotals(dataset);
  datasetName.textContent = metadata.name;
  $('h1').textContent = metadata.name;
  datasetDescription.textContent = metadata.description;
  metaIon.textContent = metadata.ion;
  metaMaterial.textContent = metadata.material;
  metaEnergy.textContent = `${formatNumber(metadata.incidentEnergyKeV)} keV / ion`;
  metaVolume.textContent = `${metadata.targetSizeNm.map((value) => formatNumber(value)).join(' × ')} nm`;
  const [width, height, depth] = metadata.targetSizeNm;
  boxSize.textContent = `X ±${formatNumber(width / 2, 2)} · Y ±${formatNumber(height / 2, 2)} · Z 0–${formatNumber(depth, 2)} nm`;
  primaryCount.textContent = `${primaries} primaries`;
  recoilCount.textContent = `${recoils} recoils`;
  maxTimeLabel.textContent = `${formatNumber(maxTime)} fs`;
  timeSlider.max = String(maxTime);
  timeSlider.value = String(state.currentTime);
  loadStatus.textContent = 'DATA LOADED';
  datasetSource.textContent = `Source: ${datasetSourceName} · ${metadata.source}`;
  app.classList.add('is-ready');
}

function renderCounts(budget: RenderBudget): void {
  if (!dataset) return;
  const totals = datasetTotals(dataset);
  visibleCount.textContent = `${totals.tracks} loaded tracks`;
  filterCount.textContent = `${budget.eligibleEvents} eligible`;
  $('#render-counts').innerHTML = `<dl class="render-count-grid"><div><dt>Loaded</dt><dd>${formatNumber(totals.tracks)} tracks · ${formatNumber(totals.events)} events</dd></div><div><dt>Eligible</dt><dd>${formatNumber(budget.eligibleTracks)} tracks · ${formatNumber(budget.eligibleEvents)} events</dd></div><div><dt>Rendered</dt><dd>${formatNumber(budget.renderedTracks)} tracks · ${formatNumber(budget.renderedEvents)} events</dd></div></dl>`;
  $('#render-budget-note').textContent = `3D caps: ${formatNumber(MAX_RENDERED_TRACKS)} tracks / ${formatNumber(MAX_RENDERED_EVENTS)} events. Source-order prefixes; one event is reserved for the eligible selected track. Paths use only capped events. Eligibility includes filters, layers, and current time. Profile uses all eligible selected-track events.`;
}

function renderLayerButtons(): void {
  togglePrimary.setAttribute('aria-pressed', String(state.showPrimary));
  toggleRecoil.setAttribute('aria-pressed', String(state.showRecoil));
  togglePrimary.classList.toggle('is-off', !state.showPrimary);
  toggleRecoil.classList.toggle('is-off', !state.showRecoil);
}

function renderFilters(): void {
  if (!dataset) return;
  eventTypeFilters.innerHTML = eventTypes(dataset).map((type) => {
    const checked = state.filters.eventTypes.includes(type);
    const label = type === null ? 'Unlabelled (no eventType)' : `Type: ${type}`;
    const encoded = JSON.stringify(type);
    return `<label class="filter-toggle ${checked ? 'is-on' : ''}"><input type="checkbox" data-event-type="${escapeHtml(encoded)}" ${checked ? 'checked' : ''} /><span>${escapeHtml(label)}</span></label>`;
  }).join('');
  minEnergy.value = state.filters.minEnergyEv === null ? '' : String(state.filters.minEnergyEv);
  maxEnergy.value = state.filters.maxEnergyEv === null ? '' : String(state.filters.maxEnergyEv);
}

function updateFilter(name: 'minEnergyEv' | 'maxEnergyEv', value: string): void {
  const parsed = value.trim() === '' ? null : Number(value);
  const next = { ...state.filters, [name]: parsed };
  if ((parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) ||
    (next.minEnergyEv !== null && next.maxEnergyEv !== null && next.minEnergyEv > next.maxEnergyEv)) {
    $('#filter-status').textContent = 'Enter nonnegative energies with minimum no greater than maximum. The last valid filters remain applied.';
    return;
  }
  $('#filter-status').textContent = '';
  if (state.filters[name] === parsed) return;
  state.filters = next;
  tablePage = 0;
  refreshSelection();
}

function renderTime(): void {
  const maxTime = Number(timeSlider.max);
  const time = Math.min(Math.max(state.currentTime, 0), maxTime);
  state.currentTime = time;
  timeSlider.value = String(time);
  const label = `${formatNumber(time)} fs`;
  timeReadout.textContent = label;
  sceneTimeLabel.textContent = label;
  playToggle.setAttribute('aria-label', state.playing ? 'Pause timeline' : 'Play timeline');
  playLabel.textContent = state.playing ? 'Pause sequence' : 'Play sequence';
  playToggle.classList.toggle('is-playing', state.playing);
  playToggle.querySelector('.play-icon')!.textContent = state.playing ? 'Ⅱ' : '▶';
  refreshSelection();
}

function cascadeButton(track: Track): string {
  return `<button type="button" class="cascade-button" data-track-id="${track.ionId}">${escapeHtml(track.species)}-${track.ionId}</button>`;
}

function renderSelection(): void {
  const track = selectedTrack();
  selectedDetail.classList.toggle('empty-detail', !track);
  if (!track) {
    selectedMarker.className = 'selected-marker';
    selectedDetail.innerHTML = '<p>Select a beam or recoil path to inspect it.</p><p class="selection-empty-note">Event and bin details will appear here after selecting a track.</p>';
    profileTotal.textContent = '—';
    profileMean.textContent = '—';
    profileChart.innerHTML = '<div class="chart-empty">Select a visible track to calculate its profile.</div>';
    return;
  }
  const events = visibleEvents(track);
  const timeWindow = track.events.reduce<{ min: number; max: number } | null>((range, event) => {
    if (!range) return { min: event.timeFs, max: event.timeFs };
    return { min: Math.min(range.min, event.timeFs), max: Math.max(range.max, event.timeFs) };
  }, null);
  selectedMarker.className = `selected-marker ${track.kind}`;
  const parent = track.parentId === null ? undefined : dataset?.cascade.tracksById.get(track.parentId);
  const children = dataset?.cascade.childrenById.get(track.ionId) ?? [];
  const selectedEvent = state.selectedEventIndex === null ? undefined : track.events[state.selectedEventIndex];
  const selectedEntry = selectedEvent && state.selectedEventIndex !== null ? { event: selectedEvent, index: state.selectedEventIndex } : undefined;
  const renderedEntries = renderedBudget?.tracks.find(({ track: item }) => item.ionId === track.ionId)?.entries ?? [];
  const renderedIndices = new Set(renderedEntries.map(({ index }) => index));
  const selectedBin = state.selectedBinIndex === null ? undefined : profileData?.bins[state.selectedBinIndex];
  const eventDetail = selectedEntry ? `<div class="detail-callout"><p class="section-kicker">SELECTED EVENT</p><dl class="selected-stats detail-grid"><div><dt>ORIGINAL EVENT</dt><dd>#${selectedEntry.index + 1}</dd></div><div><dt>TIME</dt><dd>${formatNumber(selectedEntry.event.timeFs, 2)} fs</dd></div><div><dt>POSITION</dt><dd>${selectedEntry.event.positionNm.map((value) => `${formatNumber(value, 2)} nm`).join(' · ')}</dd></div><div><dt>DEPOSITED ENERGY</dt><dd>${formatNumber(selectedEntry.event.depositedEnergyEv, 2)} eV</dd></div><div><dt>EVENT TYPE</dt><dd>${escapeHtml(selectedEntry.event.eventType ?? 'Unlabelled')}</dd></div><div><dt>DEPTH BIN</dt><dd>${(profileBinIndex(selectedEntry.event.positionNm[2], dataset!.metadata.targetSizeNm[2], profileBinCount) + 1)} / ${profileBinCount}</dd></div><div><dt>3D RENDER BUDGET</dt><dd>${renderedIndices.has(selectedEntry.index) ? 'Included' : 'Outside budget'}</dd></div></dl></div>` : '';
  const highlightedIndices = new Set(track && dataset ? highlightedEventIndices(track, state, state.currentTime, dataset.metadata.targetSizeNm[2], state.filters, profileBinCount) : []);
  const binDetail = !selectedEntry && selectedBin ? `<div class="detail-callout"><p class="section-kicker">SELECTED DEPTH BIN #${selectedBin.index + 1}</p><dl class="selected-stats detail-grid"><div><dt>BIN RANGE</dt><dd>${formatNumber(selectedBin.startDepth, 2)}–${formatNumber(selectedBin.endDepth, 2)} nm</dd></div><div><dt>ELIGIBLE COUNT</dt><dd>${selectedBin.eventCount}</dd></div><div><dt>TOTAL ENERGY</dt><dd>${formatNumber(selectedBin.totalEnergyEv, 2)} eV</dd></div><div><dt>RENDERED HIGHLIGHTED</dt><dd>${renderedEntries.filter(({ index }) => highlightedIndices.has(index)).length}</dd></div></dl></div>` : '';
  const noSelectionDetail = !selectedEntry && !selectedBin ? '<p class="selection-empty-note">No event or depth bin selected. Select an event marker, table row, or profile bin for details.</p>' : '';
   selectedDetail.innerHTML = `<div class="selected-title"><span class="track-id">${track.kind === 'primary' ? 'BEAM' : 'RECOIL'} / ${escapeHtml(track.species)}-${track.ionId}</span><span class="track-state">${trackIsVisible(track) ? `${events.length}/${track.events.length} eligible` : 'Layer hidden'}</span></div><dl class="selected-stats"><div><dt>PARENT</dt><dd>${parent ? cascadeButton(parent) : 'ROOT'}</dd></div><div><dt>TIME WINDOW</dt><dd>${timeWindow ? `${formatNumber(timeWindow.min)}–${formatNumber(timeWindow.max)} fs` : 'No events'}</dd></div><div><dt>EVENTS</dt><dd>${track.events.length} loaded</dd></div></dl>${eventDetail}${binDetail}${noSelectionDetail}<div class="cascade-children"><p class="section-kicker">CHILD TRACKS · ${children.length}</p><div class="cascade-buttons">${children.length ? children.map(cascadeButton).join('') : '<span class="muted-copy">No child tracks</span>'}</div></div>`;
}

function renderEventTable(): void {
  const track = selectedTrack();
  const entries = track && trackIsVisible(track) ? eligibleEntries(track) : [];
  const pageCount = Math.max(1, Math.ceil(entries.length / MAX_EVENT_TABLE_ROWS));
  tablePage = Math.min(tablePage, pageCount - 1);
  const offset = tablePage * MAX_EVENT_TABLE_ROWS;
  const shownEntries = entries.slice(offset, offset + MAX_EVENT_TABLE_ROWS);
  $<HTMLButtonElement>('#table-previous').disabled = tablePage === 0;
  $<HTMLButtonElement>('#table-next').disabled = tablePage >= pageCount - 1;
  $('#table-page').textContent = `Page ${tablePage + 1} of ${pageCount}`;
  const rendered = renderedBudget?.tracks.find(({ track: item }) => item.ionId === track?.ionId)?.entries ?? [];
  const highlighted = new Set(track && dataset ? highlightedEventIndices(track, state, state.currentTime, dataset.metadata.targetSizeNm[2], state.filters, profileBinCount) : []);
  const renderedHighlighted = rendered.filter(({ index }) => highlighted.has(index)).length;
  eventSummary.textContent = `${track?.events.length ?? 0} loaded · ${entries.length} eligible · ${rendered.length} rendered`;
  $('#table-notice').textContent = entries.length > MAX_EVENT_TABLE_ROWS
    ? `Table truncated to ${MAX_EVENT_TABLE_ROWS} rows per page. Showing ${offset + 1}–${offset + shownEntries.length} of ${entries.length} eligible events; use Previous/Next to inspect the rest. Profile includes all eligible events.`
    : `Showing all ${entries.length} eligible events. Profile is not limited by the 3D render budget.`;
  selectionSummary.textContent = state.selectedEventIndex !== null
    ? `Original event #${state.selectedEventIndex + 1} selected · bin ${(state.selectedBinIndex ?? 0) + 1} · ${renderedHighlighted ? 'rendered in 3D' : 'outside 3D budget'}`
    : state.selectedBinIndex !== null ? `Bin ${state.selectedBinIndex + 1} selected · ${highlighted.size} eligible / ${renderedHighlighted} rendered highlights` : 'No event or bin selected';
  if (entries.length === 0) {
    const message = !track ? 'Select a track to inspect its events.' : !trackIsVisible(track) ? 'This track layer is hidden.' : 'No events match the current time and filters.';
    eventTable.innerHTML = `<tr><td colspan="6" class="list-empty">${message}</td></tr>`;
    return;
  }
  eventTable.innerHTML = shownEntries.map(({ event, index }) => {
    const active = highlighted.has(index);
    return `<tr data-event-index="${index}" class="event-row ${active ? 'is-selected' : ''}"><td><button type="button" class="event-select" data-event-index="${index}" aria-pressed="${active}" aria-label="Select event ${index + 1}">${index + 1}</button></td><td>${formatNumber(event.timeFs, 2)}</td><td>${event.positionNm.map((value) => formatNumber(value, 2)).join(', ')}</td><td>${formatNumber(event.depositedEnergyEv, 2)}</td><td>${escapeHtml(event.eventType ?? '—')}</td><td>${profileBinIndex(event.positionNm[2], dataset!.metadata.targetSizeNm[2], profileBinCount) + 1}</td></tr>`;
  }).join('');
}

function refreshSelection(): void {
  if (!dataset) return;
  const track = selectedTrack();
  if (track && (!trackIsVisible(track) || (state.selectedEventIndex !== null &&
    (!track.events[state.selectedEventIndex] || track.events[state.selectedEventIndex].timeFs > state.currentTime ||
      !matchesEventFilter(track.events[state.selectedEventIndex], state.filters))))) {
    state.selectedEventIndex = null;
    state.selectedBinIndex = null;
  }
  renderedBudget = selectRenderBudget(dataset, state);
  const entries = track && trackIsVisible(track) ? eligibleEntries(track) : [];
  profileData = track && trackIsVisible(track) ? { track, entries, bins: calculateEntryProfile(entries, dataset.metadata.targetSizeNm[2]) } : null;
  rebuildTracks(renderedBudget);
  renderCounts(renderedBudget);
  renderSelection();
  renderEventTable();
  renderProfile();
}

function renderProfile(): void {
  const track = selectedTrack();
  if (!track || !trackIsVisible(track)) {
    exportProfileCsvButton.disabled = true;
    profileTotal.textContent = '—';
    profileMean.textContent = '—';
    profileChart.innerHTML = '<div class="chart-empty">Select a visible track to calculate its profile.</div>';
    return;
  }
  const entries = profileData?.entries ?? [];
  const events = entries.map(({ event }) => event);
  if (events.length === 0 || !dataset) {
    exportProfileCsvButton.disabled = true;
    profileTotal.textContent = '0 eV';
    profileMean.textContent = '0 eV';
    profileChart.innerHTML = '<div class="chart-empty">No events match the current time and filters.</div>';
    return;
  }
  const maxDepth = dataset.metadata.targetSizeNm[2];
  const bins = profileData!.bins;
  exportProfileCsvButton.disabled = false;
  profileBinCount = bins.length;
  const binCount = bins.length;
  const totals = bins.map((bin) => bin.totalEnergyEv);
  const counts = bins.map((bin) => bin.eventCount);
  const means = bins.map((bin) => bin.meanEnergyEv);
  const totalEnergy = events.reduce((sum, event) => sum + event.depositedEnergyEv, 0);
  const meanEnergy = totalEnergy / events.length;
  profileTotal.textContent = formatEnergy(totalEnergy);
  profileMean.textContent = `${formatNumber(meanEnergy)} eV`;

  const width = 560;
  const height = 170;
  const left = 36;
  const right = 12;
  const top = 10;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(...totals, ...means, 1);
  const xFor = (index: number): number => left + (index / binCount) * plotWidth;
  const barWidth = plotWidth / binCount - 5;
  const bars = totals.map((value, index) => {
    const barHeight = (value / maxValue) * plotHeight;
    const active = state.selectedBinIndex === index;
    const label = `Bin ${index + 1}: ${formatNumber(bins[index].startDepth, 2)}–${formatNumber(bins[index].endDepth, 2)} nm, ${formatNumber(value)} eV total, ${counts[index]} events`;
    return `<g class="profile-bin ${active ? 'is-selected' : ''}" data-bin-index="${index}" role="button" tabindex="0" aria-pressed="${active}" aria-label="${label}"><title>${label}</title><rect class="profile-hit-area" x="${xFor(index)}" y="${top}" width="${plotWidth / binCount}" height="${plotHeight}" /><rect class="profile-bar" x="${(xFor(index) + 2.5).toFixed(2)}" y="${(top + plotHeight - Math.max(barHeight, 2)).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(barHeight, 2).toFixed(2)}" rx="2" /></g>`;
  }).join('');
  const linePoints = means.map((value, index) => `${(xFor(index) + barWidth / 2 + 2.5).toFixed(2)},${(top + plotHeight - (value / maxValue) * plotHeight).toFixed(2)}`).join(' ');
  const grid = [0, 0.5, 1].map((fraction) => {
    const y = top + plotHeight - fraction * plotHeight;
    return `<line class="profile-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" /><text class="profile-axis" x="${left - 7}" y="${y + 3}" text-anchor="end">${formatNumber(maxValue * fraction)}</text>`;
  }).join('');
  const labels = Array.from({ length: binCount + 1 }, (_, index) => `<text class="profile-axis" x="${xFor(index)}" y="${height - 8}" text-anchor="${index === 0 ? 'start' : index === binCount ? 'end' : 'middle'}">${formatNumber((maxDepth / binCount) * index)}</text>`).join('');
  profileChart.innerHTML = `<svg class="profile-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Deposited energy by depth bin for track ${track.ionId}">${grid}<line class="profile-axis-line" x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" />${bars}<polyline class="profile-mean-line" points="${linePoints}" />${labels}</svg>`;
}

function safeFilename(value: string, suffix: string): string {
  const base = value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'ion-track-figure';
  return `${base}-${suffix}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const link = document.createElement('a');
  if (!('download' in link) || typeof URL.createObjectURL !== 'function') throw new Error('Browser downloads are unavailable.');
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function formatFilterSummary(): string {
  if (!dataset) return 'No dataset';
  const types = state.filters.eventTypes.map((type) => type ?? 'unlabelled').join('|') || 'none';
  const energy = `${state.filters.minEnergyEv ?? 'none'}–${state.filters.maxEnergyEv ?? 'none'} eV`;
  return `types=${types}; energy=${energy}`;
}

function snapshotScene(width: number, height: number): HTMLCanvasElement {
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const previousTarget = renderer.getRenderTarget();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const pixels = new Uint8Array(width * height * 4);
  try {
    if (renderer.getContext().isContextLost()) throw new Error('The WebGL context is unavailable.');
    const snapshotCamera = camera.clone();
    snapshotCamera.aspect = width / height;
    snapshotCamera.updateProjectionMatrix();
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, width, height);
    renderer.clear();
    renderer.render(scene, snapshotCamera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport);
    target.dispose();
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas image export is unavailable.');
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const source = (height - y - 1) * width * 4;
    image.data.set(pixels.subarray(source, source + width * 4), y * width * 4);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function drawFigureProfile(context: CanvasRenderingContext2D, bins: ReturnType<typeof calculateEntryProfile>, x: number, y: number, width: number, height: number): void {
  const max = Math.max(...bins.map((bin) => Math.max(bin.totalEnergyEv, bin.meanEnergyEv)), 1);
  context.strokeStyle = '#557276';
  context.strokeRect(x, y, width, height);
  const barWidth = width / bins.length;
  bins.forEach((bin, index) => {
    const barHeight = (bin.totalEnergyEv / max) * (height - 24);
    context.fillStyle = state.selectedBinIndex === index ? '#f2b84b' : '#45c9bb';
    context.fillRect(x + index * barWidth + 3, y + height - barHeight, barWidth - 6, barHeight);
  });
  context.strokeStyle = '#f2b84b';
  context.lineWidth = 2;
  context.beginPath();
  bins.forEach((bin, index) => {
    const pointX = x + (index + 0.5) * barWidth;
    const pointY = y + height - (bin.meanEnergyEv / max) * (height - 24);
    if (index === 0) context.moveTo(pointX, pointY); else context.lineTo(pointX, pointY);
  });
  context.stroke();
  context.fillStyle = '#9bb7b4';
  context.font = '12px monospace';
  [0, 0.5, 1].forEach((fraction) => {
    const tickY = y + height - fraction * (height - 24);
    context.fillText(`${formatNumber(max * fraction, 2)}`, x - 70, tickY + 4);
  });
  bins.forEach((bin, index) => context.fillText(`${formatNumber(bin.startDepth, 2)}`, x + index * barWidth, y + height + 20));
  context.fillText(`${formatNumber(bins[bins.length - 1]?.endDepth ?? 0)}`, x + width - 25, y + height + 20);
  context.fillText('Depth Z (nm) · energy (eV); bars = total, amber line = mean/event', x, y + height + 45);
}

function wrappedCanvasLines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  // Character wrapping also handles imported identifiers with no whitespace.
  for (const character of text) {
    if (character === '\n' || (line && context.measureText(line + character).width > width)) {
      lines.push(line); line = '';
      if (character === '\n') continue;
    }
    line += character;
  }
  lines.push(line);
  return lines;
}

function exportFigure(): void {
  try {
    if (!dataset || !renderedBudget) throw new Error('Load a dataset before exporting a figure.');
    const track = selectedTrack();
    const entries = profileData?.entries ?? [];
    const bins = profileData?.bins ?? [];
    const totals = datasetTotals(dataset);
    const width = 1400;
    const output = document.createElement('canvas');
    output.width = width;
    const context = output.getContext('2d');
    if (!context) throw new Error('Canvas image export is unavailable.');
    context.font = '700 28px sans-serif';
    const titleLines = wrappedCanvasLines(context, `${dataset.metadata.name} — inspection figure`, 1340);
    context.font = '15px monospace';
    const sourceLines = wrappedCanvasLines(context, `Dataset: ${datasetReference?.filename ?? '—'} (${datasetReference?.identity ?? '—'})\nSource: ${dataset.metadata.source}`, 1340);
    const top = 35 + titleLines.length * 34 + sourceLines.length * 22 + 25;
    const renderedEntries = renderedBudget.tracks.find(({ track: item }) => item.ionId === track?.ionId)?.entries ?? [];
    const eventIndex = state.selectedEventIndex;
    const event = eventIndex === null ? undefined : track?.events[eventIndex];
    const bin = state.selectedBinIndex === null ? undefined : bins[state.selectedBinIndex];
    const detailLines = [
      `Time: ${formatNumber(state.currentTime, 2)} fs; ${state.playing ? 'playing (snapshot)' : 'paused'}`,
      `Loaded: ${totals.tracks} tracks / ${totals.events} events`,
      `Eligible: ${renderedBudget.eligibleTracks} tracks / ${renderedBudget.eligibleEvents} events`,
      `Rendered: ${renderedBudget.renderedTracks} tracks / ${renderedBudget.renderedEvents} events`,
      `CAPPED 3D: up to ${MAX_RENDERED_TRACKS} tracks / ${MAX_RENDERED_EVENTS} events; paths connect capped eligible records.`,
      `Layers: beam ${state.showPrimary ? 'on' : 'off'}, recoil ${state.showRecoil ? 'on' : 'off'}. Filters: ${formatFilterSummary()}`,
      `Coordinates: X ±${dataset.metadata.targetSizeNm[0] / 2}, Y ±${dataset.metadata.targetSizeNm[1] / 2}, Z 0–${dataset.metadata.targetSizeNm[2]} nm. World ruler: ${dataset.metadata.targetSizeNm[0] / 4} nm.`,
      track ? `Selected track: ${track.kind} ${track.species}-${track.ionId}; parent ${track.parentId ?? 'root'}; ${dataset.cascade.childrenById.get(track.ionId)?.length ?? 0} children; layer ${trackIsVisible(track) ? 'visible' : 'hidden'}.` : 'No track selected.',
      event ? `Original event #${eventIndex! + 1}: time ${event.timeFs} fs; X ${event.positionNm[0]}, Y ${event.positionNm[1]}, Z ${event.positionNm[2]} nm; energy ${event.depositedEnergyEv} eV; type ${event.eventType ?? 'unlabelled'}; bin ${(state.selectedBinIndex ?? 0) + 1}; ${renderedEntries.some(({ index }) => index === eventIndex) ? 'inside' : 'outside'} rendered budget.` : 'No event selected.',
       !event && bin ? `Bin #${bin.index + 1}: ${bin.startDepth}–${bin.endDepth} nm; ${bin.eventCount} eligible events; ${bin.totalEnergyEv} eV total; ${renderedEntries.filter(({ index }) => bin.eventIndices.includes(index)).length} rendered highlighted events.` : event ? (renderedEntries.some(({ index }) => index === eventIndex) ? 'Profile highlights the selected event’s bin; the selected event is highlighted in 3D.' : 'Profile highlights the selected event’s bin; the selected event is outside the current 3D render budget.') : 'No depth bin selected.',
      `Profile: all ${entries.length} eligible selected-track events; event/bin selection does not narrow profile totals.`,
    ];
    context.font = '15px monospace';
    const rightLines = detailLines.flatMap((line) => [...wrappedCanvasLines(context, line, 430), '']);
    const viewportBottom = top + Math.max(610, rightLines.length * 21);
    output.height = viewportBottom + 360;
    context.fillStyle = '#09121a';
    context.fillRect(0, 0, width, output.height);
    const sceneImage = snapshotScene(860, 610);
    context.drawImage(sceneImage, 30, top, 860, 610);
    context.fillStyle = '#fff4dc';
    context.font = '700 28px sans-serif';
    titleLines.forEach((line, index) => context.fillText(line, 30, 35 + index * 34));
    context.fillStyle = '#9bb7b4';
    context.font = '15px monospace';
    sourceLines.forEach((line, index) => context.fillText(line, 30, 35 + titleLines.length * 34 + index * 22));
    rightLines.forEach((line, index) => context.fillText(line, 930, top + 20 + index * 21));
    const legend = [
      ['#f2b84b', '— Beam / primary'], ['#45c9bb', '— Recoil / secondary'],
      ['#fff4dc', '— Selected track'], ['#9bb7b4', '● Event marker (track color)'],
      ['#f2b84b', '● Larger amber marker: selected event/bin'],
      ['#45c9bb', '▰ Profile bars: total eV; amber bar = selected bin'],
      ['#f2b84b', '— Profile line: mean eV/event'], ['#9bb7b4', 'Filters define eligibility; they are not colors.'],
    ];
    let legendY = viewportBottom + 45;
    context.font = '13px monospace';
    legend.forEach(([color, text]) => {
      context.fillStyle = color;
      wrappedCanvasLines(context, text, 430).forEach((line) => {
        context.fillText(line, 930, legendY); legendY += 23;
      });
    });
    context.fillStyle = '#e5ece8';
    context.font = '600 16px sans-serif';
    context.fillText('DEPTH PROFILE · ALL ELIGIBLE SELECTED-TRACK EVENTS', 30, viewportBottom + 35);
    context.font = '13px monospace';
    context.fillStyle = '#9bb7b4';
    const totalEnergy = bins.reduce((sum, item) => sum + item.totalEnergyEv, 0);
    context.fillText(`Total: ${formatNumber(totalEnergy, 2)} eV; mean/event: ${formatNumber(entries.length ? totalEnergy / entries.length : 0, 2)} eV`, 30, viewportBottom + 60);
    if (bins.length && entries.length) drawFigureProfile(context, bins, 105, viewportBottom + 85, 750, 180);
    else context.fillText('No eligible selected-track events.', 30, viewportBottom + 110);
    downloadBlob(outputToBlob(output, 'image/png'), safeFilename(dataset.metadata.name, 'figure.png'));
    sessionStatus.textContent = 'PNG figure exported with the current time, filters, capped 3D view, selection, legend, and profile.';
  } catch (error) {
    sessionStatus.textContent = error instanceof Error ? `Figure export unavailable: ${error.message}` : 'Figure export unavailable.';
  }
}

function outputToBlob(canvas: HTMLCanvasElement, type: string): Blob {
  const data = canvas.toDataURL(type);
  if (!data.startsWith(`data:${type};base64,`)) throw new Error('Canvas could not encode the PNG figure.');
  const bytes = atob(data.split(',')[1]);
  const buffer = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index);
  return new Blob([buffer], { type });
}

function exportProfileCsv(): void {
  try {
    if (!dataset || !datasetReference) throw new Error('Load a dataset before exporting a profile.');
    const profile = profileData;
    if (!profile || !trackIsVisible(profile.track)) throw new Error('Select a visible track with eligible events before exporting a profile.');
    const { track, entries, bins } = profile;
    if (!entries.length) throw new Error('No eligible selected-track events are available for profile export.');
    const csv = serializeProfileCsv({ dataset: datasetReference, track, eligibleEntries: entries, currentTimeFs: state.currentTime, filters: state.filters, bins });
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), safeFilename(dataset.metadata.name, 'profile.csv'));
    sessionStatus.textContent = `Profile CSV exported: ${bins.length} bins from ${entries.length} eligible selected-track events (not the 3D budget).`;
  } catch (error) {
    sessionStatus.textContent = error instanceof Error ? error.message : 'Profile CSV export unavailable.';
  }
}

function renderTrackList(): void {
  if (!dataset) return;
  trackList.innerHTML = dataset.tracks.map((track) => {
    const isSelected = track.ionId === state.selectedTrackId;
    const isHidden = !trackIsVisible(track);
    const start = track.events[0]?.timeFs;
    return `<button class="track-row ${isSelected ? 'is-selected' : ''} ${isHidden ? 'is-hidden' : ''}" type="button" data-track-id="${track.ionId}" aria-pressed="${isSelected}"><span class="track-color ${track.kind}"></span><span class="track-row-main"><strong>${track.kind === 'primary' ? 'Beam' : 'Recoil'} <em>${escapeHtml(track.species)}-${track.ionId}</em></strong><small>${track.events.length} events · ${start === undefined ? 'no events' : `starts ${formatNumber(start)} fs`}</small></span><span class="track-arrow" aria-hidden="true">↗</span></button>`;
  }).join('');
}

function selectTrack(id: number, eventIndex: number | null = null): void {
  const track = dataset?.cascade.tracksById.get(id);
  if (!track) return;
  const event = eventIndex === null ? undefined : track.events[eventIndex];
  if (eventIndex !== null && (!event || event.timeFs > state.currentTime || !matchesEventFilter(event, state.filters))) return;
  if (state.selectedTrackId !== id) tablePage = 0;
  state.selectedTrackId = id;
  state.selectedEventIndex = eventIndex;
  state.selectedBinIndex = event && dataset ? profileBinIndex(event.positionNm[2], dataset.metadata.targetSizeNm[2], profileBinCount) : null;
  if (track.kind === 'primary') state.showPrimary = true;
  else state.showRecoil = true;
  renderLayerButtons();
  renderTrackList();
  refreshSelection();
}

function selectBin(index: number): void {
  const track = selectedTrack();
  if (!track || !trackIsVisible(track) || !Number.isInteger(index) || index < 0 || index >= profileBinCount) return;
  state.selectedEventIndex = null;
  state.selectedBinIndex = index;
  refreshSelection();
}

function resetView(): void {
  camera.position.copy(defaultCameraPosition);
  controls.target.set(0, 0, dataset?.metadata.targetSizeNm[2] ? dataset.metadata.targetSizeNm[2] / 2 : 78);
  controls.update();
}

function moveCamera(horizontal = 0, vertical = 0, zoom = 1): void {
  // Consume any pending drag damping before applying an immediate button step.
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  const offset = camera.position.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta += horizontal;
  spherical.phi = Math.min(Math.PI - 0.15, Math.max(0.15, spherical.phi + vertical));
  spherical.radius = Math.min(controls.maxDistance, Math.max(controls.minDistance, spherical.radius * zoom));
  camera.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(controls.target));
  controls.update();
  controls.enableDamping = damping;
}

function currentReference(): DatasetReference {
  if (!dataset || !datasetReference) throw new Error('No dataset is loaded.');
  return datasetReference;
}

function makeSession(): Session {
  return { version: 1, dataset: currentReference(),
    camera: { position: camera.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number] },
    state: structuredClone(state) };
}

function saveSession(): void {
  try {
    if (!dataset) throw new Error('Load a dataset before saving a session.');
    const json = serializeSession(makeSession());
    let localSaved = true;
    try { localStorage.setItem(LOCAL_SESSION_KEY, json); }
    catch { localSaved = false; }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.download = `${dataset.metadata.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'ion-track-session'}.session.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    sessionStatus.textContent = `Session downloaded${localSaved ? ' and saved locally' : '; local storage was unavailable'}. It contains view state and dataset identity only.`;
  } catch (error) { sessionStatus.textContent = error instanceof Error ? error.message : 'Unable to save session.'; }
}

function applySession(session: Session): void {
  if (!dataset) throw new Error('Load the trajectory before restoring a session.');
  const restored = restoreSession(session, dataset, currentReference(), profileBinCount);
  Object.assign(state, restored.state);
  tablePage = 0;
  $('#filter-status').textContent = '';
  if (restored.camera) {
    // Flush pending orbit damping before applying the saved pose.
    controls.enableDamping = false;
    controls.update();
    camera.position.fromArray(restored.camera.position);
    controls.target.fromArray(restored.camera.target);
    controls.update();
    controls.enableDamping = !reducedMotion.matches;
  }
  renderFilters(); renderLayerButtons(); renderTrackList(); renderMetadata(); renderTime();
  sessionStatus.textContent = restored.message;
}

function loadSessionText(text: string): void {
  try { applySession(parseSession(JSON.parse(text))); }
  catch (error) { sessionStatus.textContent = error instanceof Error ? `Session error: ${error.message}` : 'Unable to load session.'; }
}

function installDataset(next: Dataset, filename: string, sourceLabel: string): void {
  const identity = datasetIdentity(next);
  dataset = next;
  datasetSourceName = sourceLabel;
  datasetReference = { identity, name: next.metadata.name, source: next.metadata.source, filename };
  state.filters = defaultFilters(next);
  state.currentTime = datasetTotals(next).maxTime;
  state.selectedTrackId = next.tracks.find((track) => track.kind === 'primary')?.ionId ?? next.tracks[0]?.ionId ?? null;
  state.selectedEventIndex = null;
  state.selectedBinIndex = null;
  state.playing = false;
  state.showPrimary = true;
  state.showRecoil = true;
  tablePage = 0;
  profileBinCount = calculateEntryProfile([], next.metadata.targetSizeNm[2]).length;
  profileData = null;
  geometryKey = '';
  $('#filter-status').textContent = '';
  importStatus.textContent = `${filename} loaded successfully.${sourceLabel === 'Bundled default' ? '' : ' Imported trajectories are held only in this page; re-import after a reload.'}`;
  sessionStatus.textContent = 'Sessions store view state and dataset identity, never trajectory data.';
  renderMetadata();
  rebuildTarget();
  renderFilters();
  renderLayerButtons();
  renderTrackList();
  renderTime();
  sceneLoading.classList.remove('has-error');
  sceneLoading.classList.add('is-hidden');
}

async function loadTrajectoryFile(file: File): Promise<void> {
  const generation = ++loadGeneration;
  try {
    const next = parseTrajectory(await file.text(), file.name);
    if (generation !== loadGeneration) return;
    installDataset(next, file.name, `Browser file: ${file.name}`);
  } catch (error) {
    if (generation !== loadGeneration) return;
    const message = error instanceof Error ? error.message : 'Unknown trajectory loading error.';
    importStatus.textContent = `Import error (${file.name}): ${message}${dataset ? ' The previous dataset is still loaded.' : ''}`;
  }
}

function resizeScene(): void {
  const width = Math.max(viewport.clientWidth, 1);
  const height = Math.max(viewport.clientHeight, 1);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function wireUi(): void {
  togglePrimary.addEventListener('click', () => {
    state.showPrimary = !state.showPrimary;
    renderLayerButtons();
    renderTrackList();
    refreshSelection();
  });
  toggleRecoil.addEventListener('click', () => {
    state.showRecoil = !state.showRecoil;
    renderLayerButtons();
    renderTrackList();
    refreshSelection();
  });
  timeSlider.addEventListener('input', () => {
    state.currentTime = Number(timeSlider.value);
    renderTime();
  });
  $<HTMLButtonElement>('#step-back').addEventListener('click', () => {
    state.currentTime -= 12;
    renderTime();
  });
  $<HTMLButtonElement>('#step-forward').addEventListener('click', () => {
    state.currentTime += 12;
    renderTime();
  });
  playToggle.addEventListener('click', () => {
    const maxTime = Number(timeSlider.max);
    if (!state.playing && state.currentTime >= maxTime) state.currentTime = 0;
    state.playing = !state.playing;
    renderTime();
  });
  $<HTMLButtonElement>('#reset-view').addEventListener('click', resetView);
  $('#camera-reset').addEventListener('click', resetView);
  $('#camera-left').addEventListener('click', () => moveCamera(-0.16));
  $('#camera-right').addEventListener('click', () => moveCamera(0.16));
  $('#camera-up').addEventListener('click', () => moveCamera(0, -0.12));
  $('#camera-down').addEventListener('click', () => moveCamera(0, 0.12));
  $('#camera-zoom-in').addEventListener('click', () => moveCamera(0, 0, 0.82));
  $('#camera-zoom-out').addEventListener('click', () => moveCamera(0, 0, 1.22));
  $('#import-data').addEventListener('click', () => trajectoryFile.click());
  trajectoryFile.addEventListener('change', () => { const file = trajectoryFile.files?.[0]; if (file) void loadTrajectoryFile(file); trajectoryFile.value = ''; });
  minEnergy.addEventListener('input', () => updateFilter('minEnergyEv', minEnergy.value));
  maxEnergy.addEventListener('input', () => updateFilter('maxEnergyEv', maxEnergy.value));
  eventTypeFilters.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.eventType || !dataset) return;
    const type = JSON.parse(input.dataset.eventType) as string | null;
    if (input.checked) state.filters.eventTypes.push(type);
    else state.filters.eventTypes = state.filters.eventTypes.filter((item) => item !== type);
    tablePage = 0;
    renderFilters(); refreshSelection();
    for (const candidate of eventTypeFilters.querySelectorAll<HTMLInputElement>('input')) {
      if (candidate.dataset.eventType === input.dataset.eventType) candidate.focus();
    }
  });
  $('#save-session').addEventListener('click', saveSession);
  exportFigureButton.addEventListener('click', exportFigure);
  exportProfileCsvButton.addEventListener('click', exportProfileCsv);
  $('#load-session').addEventListener('click', () => sessionFile.click());
  $('#restore-local-session').addEventListener('click', () => {
    try {
      const saved = localStorage.getItem(LOCAL_SESSION_KEY);
      if (!saved) sessionStatus.textContent = 'No local session is saved yet.';
      else loadSessionText(saved);
    } catch { sessionStatus.textContent = 'Local session storage is unavailable.'; }
  });
  sessionFile.addEventListener('change', () => {
    const file = sessionFile.files?.[0];
    if (file) void file.text().then(loadSessionText).catch(() => { sessionStatus.textContent = 'Unable to read the session file.'; });
    sessionFile.value = '';
  });
  $('#table-previous').addEventListener('click', () => { tablePage = Math.max(0, tablePage - 1); renderEventTable(); });
  $('#table-next').addEventListener('click', () => { tablePage += 1; renderEventTable(); });
  const navigateTrack = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-track-id]');
    if (button) selectTrack(Number(button.dataset.trackId));
  };
  trackList.addEventListener('click', navigateTrack);
  selectedDetail.addEventListener('click', navigateTrack);
  eventTable.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || state.selectedTrackId === null) return;
    const row = event.target.closest<HTMLElement>('[data-event-index]');
    if (!row) return;
    const index = Number(row.dataset.eventIndex);
    const keyboardFocus = document.activeElement === event.target;
    selectTrack(state.selectedTrackId, index);
    if (keyboardFocus) eventTable.querySelector<HTMLButtonElement>(`button[data-event-index="${index}"]`)?.focus();
  });
  const activateBin = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const bin = event.target.closest<SVGElement>('[data-bin-index]');
    if (!bin) return;
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const index = Number(bin.dataset.binIndex);
    selectBin(index);
    if (event instanceof KeyboardEvent) profileChart.querySelector<SVGElement>(`[data-bin-index="${index}"]`)?.focus();
  };
  profileChart.addEventListener('click', activateBin);
  profileChart.addEventListener('keydown', activateBin);
  let pointerDown: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (event) => {
    pointerDown = { x: event.clientX, y: event.clientY };
  });
  renderer.domElement.addEventListener('click', (event) => {
    if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(trackLayer.children, true);
    // Points win over their connecting line so clicking a marker selects an event.
    const hit = hits.find((candidate) => candidate.object instanceof THREE.Points) ?? hits[0];
    const id = hit?.object.userData.trackId;
    const eventIndex = hit?.index === undefined ? null : hit.object.userData.eventIndices?.[hit.index] ?? null;
    if (typeof id === 'number') selectTrack(id, eventIndex);
  });
}

async function loadData(): Promise<void> {
  const generation = ++loadGeneration;
  try {
    const response = await fetch('/data/silicon-cascade.json');
    if (!response.ok) throw new Error(`Data request failed with status ${response.status}.`);
    const payload: unknown = await response.json();
    if (generation !== loadGeneration) return;
    installDataset(parseDataset(payload), 'silicon-cascade.json', 'Bundled default');
  } catch (error) {
    if (generation !== loadGeneration) return;
    const message = error instanceof Error ? error.message : 'Unknown data loading error.';
    loadStatus.textContent = 'LOAD ERROR';
    datasetDescription.textContent = message;
    sceneLoading.innerHTML = `<strong>Unable to load track archive.</strong><span>${escapeHtml(message)}</span>`;
    sceneLoading.classList.add('has-error');
  }
}

wireUi();
resizeScene();
window.addEventListener('resize', resizeScene);
const resizeObserver = new ResizeObserver(resizeScene);
resizeObserver.observe(viewport);
loadData();

const clock = new THREE.Clock();
let playbackUiElapsed = 0;
function animate(): void {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (state.playing && dataset) {
    playbackUiElapsed += delta;
    // Keep WebGL orbit rendering at animation-frame speed; budget/UI updates at 10 Hz.
    if (playbackUiElapsed >= 0.1) {
      state.currentTime += playbackUiElapsed * 42;
      if (state.currentTime >= Number(timeSlider.max)) {
        state.currentTime = Number(timeSlider.max);
        state.playing = false;
      }
      playbackUiElapsed = 0;
      renderTime();
    }
  } else playbackUiElapsed = 0;
  controls.update();
  renderer.render(scene, camera);
}
animate();
