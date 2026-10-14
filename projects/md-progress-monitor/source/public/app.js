import { StreamParser, StreamProtocolError, buildReconnectUrl } from './stream-parser.mjs';
import { deriveFrames, retainedCsv, selectPlotFrames, summarizeMetrics } from './analytics.mjs';

const ui = {
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  endpointLabel: document.querySelector('#endpoint-label'),
  statusAnnouncer: document.querySelector('#status-announcer'),
  trajectoryName: document.querySelector('#trajectory-name'),
  trajectorySource: document.querySelector('#trajectory-source'),
  runState: document.querySelector('#run-state'),
  progressLabel: document.querySelector('#progress-label'),
  progressTrack: document.querySelector('#progress-track'),
  progressBar: document.querySelector('#progress-bar'),
  stepValue: document.querySelector('#step-value'),
  timeValue: document.querySelector('#time-value'),
  temperatureValue: document.querySelector('#temperature-value'),
  temperatureRange: document.querySelector('#temperature-range'),
  energyValue: document.querySelector('#energy-value'),
  energyRange: document.querySelector('#energy-range'),
  rmsdValue: document.querySelector('#rmsd-value'),
  rmsdFoot: document.querySelector('#rmsd-foot'),
  timestampValue: document.querySelector('#timestamp-value'),
  frameAge: document.querySelector('#frame-age'),
  moleculeTitle: document.querySelector('#molecule-title'),
  viewStateLabel: document.querySelector('#view-state-label'),
  moleculeEmpty: document.querySelector('#molecule-empty'),
  chartEmpty: document.querySelector('#chart-empty'),
  atomCount: document.querySelector('#atom-count'),
  returnLive: document.querySelector('#return-live'),
  chartWindow: document.querySelector('#chart-window'),
  producerStatus: document.querySelector('#producer-status'),
  pauseButton: document.querySelector('#pause-button'),
  resumeButton: document.querySelector('#resume-button'),
  restartButton: document.querySelector('#restart-button'),
  bufferCount: document.querySelector('#buffer-count'),
  bufferNote: document.querySelector('#buffer-note'),
  framesBody: document.querySelector('#frames-body'),
  framesScroll: document.querySelector('#frames-scroll'),
  moleculeCanvas: document.querySelector('#molecule-canvas'),
  metricsCanvas: document.querySelector('#metrics-canvas'),
  plotWindow: document.querySelector('#plot-window'),
  plotPoints: document.querySelector('#plot-points'),
  exportCsv: document.querySelector('#export-csv'),
  chartDisplay: document.querySelector('#chart-display'),
  summaryCount: document.querySelector('#summary-count'),
  summaryTemperature: document.querySelector('#summary-temperature'),
  summaryTemperatureDetail: document.querySelector('#summary-temperature-detail'),
  summaryEnergy: document.querySelector('#summary-energy'),
  summaryEnergyDetail: document.querySelector('#summary-energy-detail'),
  summaryRmsd: document.querySelector('#summary-rmsd'),
  summaryRmsdDetail: document.querySelector('#summary-rmsd-detail'),
  diagnosticsStatus: document.querySelector('#diagnostics-status'),
  diagnosticsGapCount: document.querySelector('#diagnostics-gap-count'),
  diagnosticsGapDetail: document.querySelector('#diagnostics-gap-detail'),
  diagnosticsDuplicateCount: document.querySelector('#diagnostics-duplicate-count'),
  diagnosticsDuplicateDetail: document.querySelector('#diagnostics-duplicate-detail'),
  diagnosticsResetCount: document.querySelector('#diagnostics-reset-count'),
  diagnosticsResetDetail: document.querySelector('#diagnostics-reset-detail'),
  diagnosticsExpiredCount: document.querySelector('#diagnostics-expired-count'),
  diagnosticsExpiredDetail: document.querySelector('#diagnostics-expired-detail'),
  diagnosticsRetainedCount: document.querySelector('#diagnostics-retained-count'),
  diagnosticsRetainedDetail: document.querySelector('#diagnostics-retained-detail'),
  diagnosticsBufferCount: document.querySelector('#diagnostics-buffer-count'),
  diagnosticsBufferDetail: document.querySelector('#diagnostics-buffer-detail'),
  diagnosticsDroppedCount: document.querySelector('#diagnostics-dropped-count'),
  diagnosticsDroppedDetail: document.querySelector('#diagnostics-dropped-detail'),
};

const state = {
  socket: null,
  reconnectTimer: null,
  reconnectDelay: 900,
  connected: false,
  connectionLabel: 'Connecting',
  metadata: null,
  frames: [],
  liveFrame: null,
  inspectedFrame: null,
  status: 'offline',
  currentIndex: -1,
  framesWithAnalytics: [],
  plotWindowSize: 0,
  plotMaxPoints: 200,
};

const streamParser = new StreamParser();

const atomColors = {
  C: '#cbd5df',
  O: '#ff718a',
  N: '#a78bfa',
  H: '#73d9ef',
};

function streamUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function setConnection(kind, label) {
  state.connectionLabel = label;
  ui.connectionDot.className = `connection-dot ${kind}`;
  if (ui.connectionLabel.textContent !== label) ui.connectionLabel.textContent = label;
  renderDiagnostics();
}

function announceStatus(message) {
  if (ui.statusAnnouncer.textContent !== message) ui.statusAnnouncer.textContent = message;
}

function connect() {
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
  const url = buildReconnectUrl(streamUrl(), streamParser.cursor());
  ui.endpointLabel.textContent = url;
  setConnection('', streamParser.hasCursor() ? 'Reconnecting' : 'Connecting');
  try {
    const socket = new WebSocket(url);
    state.socket = socket;
    socket.addEventListener('open', () => {
      state.connected = true;
      state.reconnectDelay = 900;
      setConnection('online', 'Connected');
      renderControls();
    });
    socket.addEventListener('message', (event) => {
      try {
        receive(event.data);
      } catch (error) {
        console.warn('Could not parse stream message', error);
        announceStatus('Diagnostic: could not process stream message.');
      }
    });
    socket.addEventListener('close', () => {
      state.connected = false;
      state.status = 'offline';
      setConnection('error', 'Disconnected');
      renderStatus();
      renderControls();
      scheduleReconnect();
    });
    socket.addEventListener('error', () => setConnection('error', 'Connection error'));
  } catch (error) {
    setConnection('error', 'Unavailable');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    connect();
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 7000);
  }, state.reconnectDelay);
}

function sendAction(action) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ action }));
  }
}

function receive(message) {
  let event;
  try {
    event = streamParser.ingest(message);
  } catch (error) {
    if (error instanceof StreamProtocolError) {
      console.warn(`Rejected stream message [${error.code}]: ${error.message}`);
      setConnection('error', 'Invalid stream');
      announceStatus(`Diagnostic: invalid stream message (${error.code}).`);
      return;
    }
    throw error;
  }

  state.metadata = streamParser.metadata;
  state.frames = streamParser.frames.slice();
  state.liveFrame = state.frames[state.frames.length - 1] || null;
  state.framesWithAnalytics = deriveFrames(state.frames, streamParser.referenceFrame);
  ui.exportCsv.disabled = state.framesWithAnalytics.length === 0;

  if (event.type === 'metadata') {
    const message = event.message;
    if (event.runChanged) {
      state.inspectedFrame = null;
      state.currentIndex = -1;
    }
    ui.trajectoryName.textContent = message.name;
    const playbackLabel = message.playback_mode === 'accelerated'
      ? `accelerated${message.repeat_count > 1 ? ` ×${message.repeat_count}` : ''}`
      : 'realtime playback';
    ui.trajectorySource.textContent = `${message.atom_count} particles · ${message.total_frames} frames · ${message.timestep_fs} fs timestep · ${playbackLabel}`;
    ui.atomCount.textContent = `${message.atom_count} particles`;
    ui.bufferNote.textContent = `Bounded to ${message.buffer_limit} frames`;
    ui.bufferCount.textContent = `0 / ${message.buffer_limit}`;
    renderAll();
  } else if (event.type === 'snapshot') {
    state.currentIndex = event.message.current_index ?? streamParser.latestSequence;
    if (event.reset || event.runChanged) state.inspectedFrame = null;
    if (state.inspectedFrame && !state.frames.some((frame) => frame.index === state.inspectedFrame.index)) {
      state.inspectedFrame = null;
    }
    if (event.message.reason && event.reset) {
      ui.bufferNote.textContent = `Reset: ${event.message.reason.replaceAll('_', ' ')}`;
      if (event.message.reason !== 'initial') {
        announceStatus(`Frame buffer reset: ${event.message.reason.replaceAll('_', ' ')}.`);
      }
    }
    renderAll();
  } else if (event.type === 'status') {
    state.status = event.message.status;
    state.currentIndex = event.message.current_index ?? streamParser.latestSequence;
    renderStatus();
    renderDiagnostics();
    renderControls();
  } else if (event.type === 'frame' && event.accepted) {
    state.currentIndex = event.frame.index;
    ui.exportCsv.disabled = false;
    renderAll();
  } else if (event.type === 'frame' && event.duplicate) {
    // A legacy stream may supply frame 0 for the first time as a replayed
    // duplicate. Recompute analytics without inserting or counting that frame.
    renderAll();
  } else if (event.type === 'error') {
    console.warn(event.message.message);
    announceStatus(`Diagnostic: ${event.message.message}`);
  }
}

function bufferLimit() {
  return state.metadata?.buffer_limit || 28;
}

function activeFrame() {
  return state.inspectedFrame || state.liveFrame;
}

function analyticalFrame(frame) {
  if (!frame) return null;
  // Inspection may pin a frame that has since left the recent buffer.
  return state.framesWithAnalytics.find((item) => item.sequence === frame.sequence)
    || deriveFrames([frame], streamParser.referenceFrame)[0];
}

function formatNumber(value, digits = 1) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function formatTime(value) {
  return `${formatNumber(value, value % 1 ? 1 : 0)} fs`;
}

function formatClock(timestamp) {
  if (!timestamp) return '—';
  const match = String(timestamp).match(/T(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/);
  return match ? `${match[1]}Z` : String(timestamp);
}

function renderAll() {
  updateInspectionUi();
  renderMetrics();
  renderSummary();
  renderFrames();
  renderDiagnostics();
  drawMolecule();
  drawChart();
  renderStatus();
}

function renderMetrics() {
  const frame = activeFrame();
  if (!frame) {
    ui.stepValue.textContent = '—';
    ui.timeValue.textContent = '0 fs in trajectory';
    ui.temperatureValue.innerHTML = '— <small>K</small>';
    ui.energyValue.innerHTML = '— <small>kJ/mol</small>';
    ui.timestampValue.textContent = '—';
    ui.frameAge.textContent = 'No frame received';
    ui.rmsdValue.innerHTML = '— <small>Å</small>';
    ui.rmsdFoot.textContent = streamParser.referenceFrame ? 'unaligned · vs. frame 0' : 'Waiting for reference';
    ui.temperatureRange.textContent = 'Waiting for data';
    ui.energyRange.textContent = 'Waiting for data';
    return;
  }
  const metricFrame = analyticalFrame(frame);
  ui.stepValue.textContent = frame.step.toLocaleString();
  ui.timeValue.textContent = `${formatTime(frame.time_fs)} in trajectory`;
  ui.temperatureValue.innerHTML = `${formatNumber(frame.temperature_K, 1)} <small>K</small>`;
  ui.energyValue.innerHTML = `${formatNumber(frame.potential_energy_kj_mol, 2)} <small>kJ/mol</small>`;
  ui.timestampValue.textContent = formatClock(frame.timestamp);
  ui.frameAge.textContent = state.inspectedFrame
    ? `Inspecting frame ${String(frame.index).padStart(2, '0')}`
    : `Live frame ${String(frame.index).padStart(2, '0')}`;
  ui.rmsdValue.innerHTML = metricFrame?.rmsd_angstrom === null || metricFrame?.rmsd_angstrom === undefined
    ? '— <small>Å</small>'
    : `${formatNumber(metricFrame.rmsd_angstrom, 3)} <small>Å</small>`;
  ui.rmsdFoot.textContent = streamParser.referenceFrame
    ? 'unaligned · all atoms · vs. frame 0'
    : 'Reference frame unavailable';

  const temperatures = state.framesWithAnalytics.map((item) => item.temperature_K);
  const energies = state.framesWithAnalytics.map((item) => item.potential_energy_kj_mol);
  ui.temperatureRange.textContent = temperatures.length
    ? `${formatNumber(Math.min(...temperatures), 1)} — ${formatNumber(Math.max(...temperatures), 1)} K window`
    : 'Waiting for data';
  ui.energyRange.textContent = energies.length
    ? `${formatNumber(Math.min(...energies), 2)} — ${formatNumber(Math.max(...energies), 2)} window`
    : 'Waiting for data';
}

function metricLabel(metric, digits) {
  return metric.mean === null ? '—' : formatNumber(metric.mean, digits);
}

function metricDetail(metric, digits, suffix = '') {
  return metric.count === 0
    ? 'No finite values'
    : `mean · min ${formatNumber(metric.min, digits)}${suffix} max ${formatNumber(metric.max, digits)}${suffix} · σ ${formatNumber(metric.stddev, digits)}${suffix}`;
}

function renderSummary() {
  const frames = state.framesWithAnalytics;
  const selected = selectPlotFrames(frames, {
    windowSize: state.plotWindowSize,
    maxPoints: state.plotMaxPoints,
  }).windowFrames;
  const summary = summarizeMetrics(selected);
  ui.summaryCount.title = 'Uses every retained frame in the selected plot window; not downsampled';
  ui.summaryCount.textContent = `${summary.count} frame${summary.count === 1 ? '' : 's'}`;
  ui.summaryTemperature.textContent = metricLabel(summary.temperature_K, 2);
  ui.summaryTemperatureDetail.textContent = metricDetail(summary.temperature_K, 2, ' K');
  ui.summaryEnergy.textContent = metricLabel(summary.potential_energy_kj_mol, 3);
  ui.summaryEnergyDetail.textContent = metricDetail(summary.potential_energy_kj_mol, 3);
  ui.summaryRmsd.textContent = metricLabel(summary.rmsd_angstrom, 3);
  ui.summaryRmsdDetail.textContent = metricDetail(summary.rmsd_angstrom, 3, ' Å');
}

function renderStatus() {
  const metadata = state.metadata;
  const total = metadata?.total_frames || 0;
  const completed = Math.max(0, state.currentIndex + 1);
  const progress = total ? Math.min(100, (completed / total) * 100) : 0;
  ui.progressLabel.textContent = `${completed} / ${total} frames`;
  ui.progressBar.style.width = `${progress}%`;
  ui.progressTrack.setAttribute('aria-valuenow', String(Math.round(progress)));
  ui.progressTrack.setAttribute('aria-valuetext', `${completed} of ${total} frames`);
  const status = state.status;
  const label = status === 'complete' ? 'COMPLETE' : status === 'paused' ? 'PAUSED' : status === 'running' ? 'STREAMING' : status === 'starting' ? 'STARTING' : 'OFFLINE';
  ui.runState.textContent = label;
  ui.runState.className = `state-pill state-${status === 'running' ? 'running' : status === 'paused' ? 'paused' : status === 'complete' ? 'complete' : 'idle'}`;
  if (ui.producerStatus.textContent !== label) ui.producerStatus.textContent = label;
}

function renderDiagnostics() {
  const diagnostics = streamParser.diagnostics;
  const formatCount = (value) => value.toLocaleString();
  const resetReason = diagnostics.lastResetReason?.replaceAll('_', ' ');
  const diagnosticStatus = `${state.connectionLabel}${diagnostics.status ? ` · producer ${diagnostics.status}` : ''}${resetReason ? ` · last reset: ${resetReason}` : ''}`;
  if (ui.diagnosticsStatus.textContent !== diagnosticStatus) ui.diagnosticsStatus.textContent = diagnosticStatus;
  ui.diagnosticsGapCount.textContent = formatCount(diagnostics.gapCount);
  ui.diagnosticsGapDetail.textContent = `${formatCount(diagnostics.missingSequenceCount)} missing sequence(s) across accepted jumps`;
  ui.diagnosticsDuplicateCount.textContent = formatCount(diagnostics.duplicateCount);
  ui.diagnosticsDuplicateDetail.textContent = diagnostics.duplicateCount
    ? 'Identical replay frames ignored' : 'No identical replay frames observed';
  ui.diagnosticsResetCount.textContent = formatCount(diagnostics.reconnectResetCount);
  ui.diagnosticsResetDetail.textContent = resetReason
    ? `Last reset: ${resetReason}` : 'No reconnect reset snapshots observed';
  ui.diagnosticsExpiredCount.textContent = formatCount(diagnostics.cursorExpiredCount);
  ui.diagnosticsExpiredDetail.textContent = diagnostics.cursorExpiredCount
    ? `${formatCount(diagnostics.observedDroppedBeforeReconnect)} sequence(s) observed unavailable before reconnect`
    : 'No expired cursor reset observed';
  ui.diagnosticsRetainedCount.textContent = formatCount(diagnostics.retainedFrames);
  ui.diagnosticsRetainedDetail.textContent = state.frames.length
    ? `Observed client window: ${state.frames[0].sequence}–${state.frames.at(-1).sequence}`
    : 'No frames currently retained by client';
  ui.diagnosticsBufferCount.textContent = `${formatCount(diagnostics.bufferUsage)} / ${diagnostics.bufferCapacity ?? '—'}`;
  ui.diagnosticsBufferDetail.textContent = diagnostics.bufferCapacity === null
    ? 'Waiting for buffer metadata' : `Usage ${diagnostics.bufferUsageSource}; producer capacity ${diagnostics.bufferCapacity}`;
  ui.diagnosticsDroppedCount.textContent = formatCount(diagnostics.estimatedDroppedFrames);
  ui.diagnosticsDroppedDetail.textContent = 'Largest inferred sequence-span excess this run; not packet loss';
}

function renderControls() {
  const focusedControl = document.activeElement;
  const canControl = state.connected && Boolean(state.metadata);
  ui.pauseButton.disabled = !canControl || state.status !== 'running';
  ui.resumeButton.disabled = !canControl || state.status !== 'paused';
  ui.restartButton.disabled = !canControl;
  if (focusedControl === ui.pauseButton && ui.pauseButton.disabled && !ui.resumeButton.disabled) {
    ui.resumeButton.focus({ preventScroll: true });
  } else if (focusedControl === ui.resumeButton && ui.resumeButton.disabled && !ui.pauseButton.disabled) {
    ui.pauseButton.focus({ preventScroll: true });
  }
}

function downloadRetainedCsv() {
  if (!state.framesWithAnalytics.length) return;
  const csv = retainedCsv(state.framesWithAnalytics, {
    runId: streamParser.runId || '',
    referenceSequence: streamParser.referenceFrame?.sequence ?? null,
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(state.metadata?.name || 'md-progress-retained').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'md-progress-retained'}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  announceStatus(`Exported ${state.framesWithAnalytics.length} retained frames as CSV.`);
  // Give the browser time to begin the download before releasing the Blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderFrames() {
  const frames = [...state.frames].sort((a, b) => b.index - a.index);
  const focusedIndex = document.activeElement?.closest('#frames-body tr[data-index]')?.dataset.index;
  ui.bufferCount.textContent = `${frames.length} / ${bufferLimit()}`;
  if (!frames.length) {
    ui.framesBody.innerHTML = '<tr class="empty-row"><td colspan="5">Waiting for frames…</td></tr>';
    if (focusedIndex !== undefined) ui.framesScroll.focus({ preventScroll: true });
    return;
  }
  ui.framesBody.innerHTML = frames.map((frame) => {
    const selected = state.inspectedFrame?.index === frame.index ? ' selected' : '';
    const live = state.liveFrame?.index === frame.index ? ' · live' : '';
    const selectedAttribute = state.inspectedFrame?.index === frame.index ? 'true' : 'false';
    const accessibleLabel = `Frame ${frame.index}, step ${Number(frame.step).toLocaleString()}, temperature ${formatNumber(frame.temperature_K, 1)} kelvin, energy ${formatNumber(frame.potential_energy_kj_mol, 2)}, time ${formatClock(frame.timestamp)}${live ? ', live frame' : ''}`;
    return `<tr class="${selected}" data-index="${frame.index}" tabindex="0" aria-selected="${selectedAttribute}" aria-label="${accessibleLabel}" aria-describedby="frames-help">
      <td>#${String(frame.index).padStart(2, '0')}${live ? `<span class="row-live">${live}</span>` : ''}</td>
      <td>${Number(frame.step).toLocaleString()}</td>
      <td>${formatNumber(frame.temperature_K, 1)} K</td>
      <td>${formatNumber(frame.potential_energy_kj_mol, 2)}</td>
      <td>${formatClock(frame.timestamp)}</td>
    </tr>`;
  }).join('');
  // The buffer is redrawn for every received frame. Keep keyboard focus on the
  // same frame, or its nearest retained neighbour if that frame was evicted.
  if (focusedIndex !== undefined) focusFrameRow(Number(focusedIndex));
}

function focusFrameRow(index) {
  const row = ui.framesBody.querySelector(`tr[data-index="${index}"]`)
    || ui.framesBody.querySelector('tr[data-index]:last-child');
  (row || ui.framesScroll).focus({ preventScroll: true });
}

function inspectFrame(index) {
  const frame = state.frames.find((item) => item.index === index);
  if (!frame) return;
  state.inspectedFrame = frame;
  renderAll();
  focusFrameRow(index);
  announceStatus(`Inspecting frame ${index}, step ${frame.step}.`);
}

function drawMolecule() {
  const canvas = ui.moleculeCanvas;
  const frame = activeFrame();
  const atoms = state.metadata?.atoms || [];
  ui.moleculeEmpty.hidden = Boolean(frame && atoms.length);
  if (!frame || !atoms.length) return;
  const context = resizeCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, canvas.width, canvas.height);

  const positions = frame.positions;
  const xs = positions.map((point) => point[0]);
  const ys = positions.map((point) => point[1]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const range = Math.max(maxX - minX, maxY - minY, 1.8);
  const scale = Math.min(width, height) * 0.68 / range;
  const centerX = width / 2 - ((minX + maxX) / 2) * scale;
  const centerY = height / 2 + ((minY + maxY) / 2) * scale;
  const project = (point) => ({ x: centerX + point[0] * scale, y: centerY - point[1] * scale, z: point[2] });
  const projected = positions.map(project);

  context.lineCap = 'round';
  for (let first = 0; first < positions.length; first += 1) {
    for (let second = first + 1; second < positions.length; second += 1) {
      const a = positions[first]; const b = positions[second];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const heavyBond = atoms[first].element !== 'H' && atoms[second].element !== 'H' && distance < 1.8;
      const hydrogenBond = (atoms[first].element === 'H' || atoms[second].element === 'H') && distance < 1.22;
      if (!heavyBond && !hydrogenBond) continue;
      const start = projected[first]; const end = projected[second];
      context.strokeStyle = 'rgba(119, 145, 166, .52)';
      context.lineWidth = Math.max(2, scale * .045);
      context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke();
    }
  }

  const drawOrder = projected.map((point, index) => ({ point, index })).sort((a, b) => a.point.z - b.point.z);
  for (const { point, index } of drawOrder) {
    const atom = atoms[index];
    const radius = atom.element === 'H' ? 9 : atom.element === 'O' ? 15 : 14;
    const color = atomColors[atom.element] || '#cbd5df';
    const gradient = context.createRadialGradient(point.x - radius * .35, point.y - radius * .42, 1, point.x, point.y, radius);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(.2, color);
    gradient.addColorStop(1, shade(color, -45));
    context.fillStyle = 'rgba(0, 0, 0, .35)';
    context.beginPath(); context.ellipse(point.x + 2, point.y + 4, radius * 1.08, radius * .65, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = gradient;
    context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
    if (atom.element !== 'H') {
      context.fillStyle = '#071019'; context.font = '600 9px Manrope, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(atom.element, point.x, point.y + .5);
    }
  }
}

function drawChart() {
  const canvas = ui.metricsCanvas;
  const context = resizeCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);
  const { windowFrames: frames, displayFrames } = selectPlotFrames(state.framesWithAnalytics, {
    windowSize: state.plotWindowSize,
    maxPoints: state.plotMaxPoints,
  });
  ui.chartEmpty.hidden = frames.length > 0;
  const windowLabel = state.plotWindowSize ? `Last ${state.plotWindowSize}` : 'All retained';
  ui.chartWindow.textContent = `${windowLabel} · ${frames.length} frames`;
  ui.chartDisplay.textContent = `${displayFrames.length} displayed / cap ${state.plotMaxPoints}`;
  if (!frames.length) return;
  // Independent unit-labeled axes avoid overlaying unlike quantities on a
  // temperature axis. The x coordinate always represents the original step.
  const left = 66; const right = Math.max(left + 1, width - 14);
  const firstStep = frames[0].step; const lastStep = frames.at(-1).step;
  const xAt = (frame) => lastStep === firstStep ? (left + right) / 2
    : left + (frame.step - firstStep) / (lastStep - firstStep) * (right - left);
  const laneHeight = (height - 30) / 3;
  const series = [
    { key: 'temperature_K', label: 'Temperature / K', color: '#ffb45c', digits: 1 },
    { key: 'potential_energy_kj_mol', label: 'Energy / kJ/mol', color: '#a78bfa', digits: 2 },
    { key: 'rmsd_angstrom', label: 'Unaligned RMSD / Å', color: '#ff718a', digits: 3 },
  ];
  context.font = '10px ui-monospace, monospace';
  context.textBaseline = 'alphabetic';
  series.forEach(({ key, label, color, digits }, lane) => {
    const top = lane * laneHeight + 24;
    const bottom = (lane + 1) * laneHeight - 9;
    context.textAlign = 'left'; context.fillStyle = color;
    context.fillText(label, left, top - 10);
    // Full-resolution extrema keep the scale stable when only display changes.
    const values = frames.map((frame) => frame[key]).filter(Number.isFinite);
    if (!values.length) {
      context.fillStyle = '#7d8b9e'; context.fillText('Frame 0 reference unavailable', left, top + 20);
      return;
    }
    const low = Math.min(...values); const high = Math.max(...values);
    const margin = Math.max((high - low) * .1, key === 'rmsd_angstrom' ? .001 : .05);
    const min = low - margin; const max = high + margin;
    const yAt = (value) => bottom - (value - min) / (max - min) * (bottom - top);
    for (let tick = 0; tick < 3; tick += 1) {
      const y = top + (bottom - top) * tick / 2;
      context.strokeStyle = 'rgba(105,126,148,.16)'; context.lineWidth = 1;
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
      context.fillStyle = '#7d8b9e'; context.textAlign = 'right';
      context.fillText(formatNumber(max - (max - min) * tick / 2, digits), left - 8, y + 3);
    }
    context.beginPath();
    let hasPrevious = false;
    displayFrames.forEach((frame) => {
      if (!Number.isFinite(frame[key])) { hasPrevious = false; return; }
      const x = xAt(frame); const y = yAt(frame[key]);
      if (hasPrevious) context.lineTo(x, y); else context.moveTo(x, y);
      hasPrevious = true;
    });
    context.strokeStyle = color; context.lineWidth = 1.8; context.stroke();
    displayFrames.forEach((frame) => {
      if (!Number.isFinite(frame[key])) return;
      context.fillStyle = color;
      context.beginPath(); context.arc(xAt(frame), yAt(frame[key]), 2, 0, Math.PI * 2); context.fill();
    });
  });
  context.fillStyle = '#7d8b9e'; context.textAlign = 'left';
  context.fillText(`step ${firstStep}`, left, height - 7);
  context.textAlign = 'right'; context.fillText(`step ${lastStep}`, right, height - 7);
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth; const height = canvas.clientHeight;
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio); canvas.height = Math.floor(height * ratio);
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function shade(hex, amount) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((index) => Math.max(0, Math.min(255, parseInt(value.slice(index, index + 2), 16) + amount)));
  return `rgb(${channels.join(',')})`;
}

ui.pauseButton.addEventListener('click', () => sendAction('pause'));
ui.resumeButton.addEventListener('click', () => sendAction('resume'));
ui.restartButton.addEventListener('click', () => {
  state.inspectedFrame = null;
  sendAction('restart');
});
ui.returnLive.addEventListener('click', () => {
  returnToLive();
});
ui.plotWindow.addEventListener('change', () => {
  state.plotWindowSize = Number(ui.plotWindow.value);
  renderAll();
});
ui.plotPoints.addEventListener('change', () => {
  state.plotMaxPoints = Number(ui.plotPoints.value);
  renderAll();
});
ui.exportCsv.addEventListener('click', downloadRetainedCsv);

ui.framesBody.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-index]');
  if (row) inspectFrame(Number(row.dataset.index));
});

ui.framesBody.addEventListener('keydown', (event) => {
  const row = event.target.closest('tr[data-index]');
  if (!row || !['Enter', ' '].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  if (!event.repeat && !event.isComposing) inspectFrame(Number(row.dataset.index));
});

function returnToLive() {
  const inspectedIndex = state.inspectedFrame?.index;
  const restoreFocus = document.activeElement === ui.returnLive;
  state.inspectedFrame = null;
  renderAll();
  if (restoreFocus) focusFrameRow(inspectedIndex);
  announceStatus('Returned to live frame.');
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.isContentEditable || target?.closest('input, select, textarea, button, a, summary, [role="textbox"], [role="button"], [role="combobox"]')) return;

  const shortcut = event.key.toLowerCase();
  if (shortcut === 'l') {
    event.preventDefault();
    returnToLive();
    return;
  }
  const button = {
    ' ': state.status === 'running' ? ui.pauseButton : state.status === 'paused' ? ui.resumeButton : null,
    r: ui.restartButton,
    e: ui.exportCsv,
  }[shortcut];
  if (!button || button.disabled || button.hidden) return;
  event.preventDefault();
  button.click();
});

function updateInspectionUi() {
  const inspecting = Boolean(state.inspectedFrame);
  ui.viewStateLabel.textContent = inspecting ? 'INSPECTING' : 'LIVE';
  ui.viewStateLabel.previousElementSibling.style.background = inspecting ? '#ffb45c' : '';
  ui.moleculeTitle.textContent = inspecting ? `Frame ${String(state.inspectedFrame.index).padStart(2, '0')} geometry` : 'Molecular view';
  ui.returnLive.hidden = !inspecting;
}

window.addEventListener('resize', () => { drawMolecule(); drawChart(); });
renderAll();
setConnection('', 'Connecting');
connect();
