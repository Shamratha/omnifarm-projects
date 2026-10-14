import { compareTiles, buildReport, buildComparisonSummary } from './engine.js';
import { FIXTURES, STUDIO_TODAY, STALE_DAYS, bandTile } from './fixtures.js';
import { buildReadableReport } from './report.js';

const state = { fixture: 'river-bend', band: 'infrared', threshold: .20, view: 'side-by-side' };
const $ = id => document.getElementById(id);
const number = value => value.toLocaleString('en-GB');
const percent = value => `${(value * 100).toFixed(1)}%`;
const dateLabel = iso => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso)).toUpperCase();
const options = () => ({ now: STUDIO_TODAY, maxAgeDays: STALE_DAYS });
function comparison() {
  const fixture = FIXTURES[state.fixture];
  const before = bandTile(fixture.before, state.band), after = bandTile(fixture.after, state.band);
  return { fixture, before, after, result: compareTiles(before, after, state.threshold, options()) };
}

function colorMix(a, b, weight) { return a.map((value, index) => Math.round(value + (b[index] - value) * weight)); }
function irColor(value) {
  const stops = [[18, 45, 60], [60, 82, 79], [160, 89, 67], [220, 143, 99], [240, 216, 175]];
  const position = Math.min(3.999, Math.max(0, value) * 4), index = Math.floor(position);
  return colorMix(stops[index], stops[index + 1], position - index);
}
function paint(canvas, tile, colorAt) {
  canvas.width = tile.width; canvas.height = tile.height;
  const ctx = canvas.getContext('2d'); const image = ctx.createImageData(tile.width, tile.height);
  for (let i = 0; i < tile.width * tile.height; i++) {
    image.data.set([...colorAt(i), 255], i * 4);
  }
  ctx.putImageData(image, 0, 0);
}
function maskedColor(tile, i, color) {
  if (tile.nodata[i]) return (i + Math.floor(i / tile.width)) % 2 ? [222, 220, 211] : [235, 231, 222];
  if (tile.cloud[i]) return colorMix(color, [225, 217, 201], .9);
  return color;
}
function maskCount(tile, mask) { return tile[mask].filter(Boolean).length; }
function freshnessCard(label, tile, stale, age) {
  return `<span class="freshness-label">${label}</span> <strong class="freshness-state ${stale ? 'is-stale' : ''}">${stale ? 'STALE' : 'FRESH'}</strong> <span class="freshness-detail">${dateLabel(tile.date)} · ${age.toFixed(1)} days old · policy ${STALE_DAYS} days</span>`;
}
function tileCard(tile, fixture, side, stale, age) {
  return `<article class="tile-card">
    <div class="tile-header"><span class="tile-kicker">${side.toUpperCase()}</span><span class="tile-date">${dateLabel(tile.date)}</span></div>
    <div class="tile-canvas">
      <canvas id="${side}Canvas" tabindex="0" aria-describedby="comparisonLegend viewLegend inspectionHelp ${side}Freshness" aria-label="${side} synthetic ${state.band} tile; ${Math.floor(age)} days old, ${stale ? 'stale' : 'fresh'}"></canvas>
      <span class="tile-badge">${state.band === 'infrared' ? 'IR · FALSE COLOR' : 'RGB · VISIBLE'}</span><span class="tile-crosshair" aria-hidden="true">+</span>
    </div>
    <div class="tile-caption"><span>${fixture.shortName}</span><span class="${stale ? 'is-stale' : ''}">${stale ? 'STALE · ' : ''}${Math.floor(age)} DAYS OLD</span></div>
    <div class="tile-mask-badges" aria-label="${side} mask counts">
      <span class="mask-badge cloud"><i aria-hidden="true"></i><span>Cloud</span> <b>${number(maskCount(tile, 'cloud'))} px</b></span>
      <span class="mask-badge nodata"><i aria-hidden="true"></i><span>Nodata</span> <b>${number(maskCount(tile, 'nodata'))} px</b></span>
    </div>
  </article>`;
}
function attachInspect(canvas, source, before, after, result) {
  let cursor = [Math.floor(before.width / 2), Math.floor(before.height / 2)];
  function inspect(x, y) {
    cursor = [x, y];
    const i = y * before.width + x;
    const mask = before.nodata[i] || after.nodata[i] ? 'NODATA · excluded' : before.cloud[i] || after.cloud[i] ? 'CLOUD · excluded' : result.changed[i] ? 'CHANGED' : 'BELOW THRESHOLD';
    $('pixelInfo').textContent = `(${x}, ${y}) · ${source} · before ${before.values[i].toFixed(3)} → after ${after.values[i].toFixed(3)} · Δ ${result.differences[i].toFixed(3)} · confidence ${percent(result.confidence[i])} · ${mask}`;
  }
  canvas.tabIndex = 0;
  canvas.onfocus = () => inspect(...cursor);
  canvas.onkeydown = event => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!step) return;
    event.preventDefault();
    inspect(Math.max(0, Math.min(before.width - 1, cursor[0] + step[0])), Math.max(0, Math.min(before.height - 1, cursor[1] + step[1])));
  };
  canvas.onpointermove = event => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(before.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * before.width)));
    const y = Math.min(before.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * before.height)));
    inspect(x, y);
  };
  canvas.onpointerleave = () => { $('pixelInfo').textContent = 'Hover a tile to inspect its value, masks, and confidence.'; };
}

function renderDifference(canvas, before, after, result) {
  paint(canvas, before, i => {
    if (!result.valid[i]) return before.nodata[i] || after.nodata[i] ? [235, 231, 222] : [217, 205, 183];
    const strength = Math.min(1, result.differences[i]);
    const color = [Math.round(39 + strength * 211), Math.round(71 + strength * 100), Math.round(68 - strength * 32)];
    return result.changed[i] ? color : colorMix(color, [226, 224, 214], .48);
  });
}
function renderConfidence(canvas, tile, other, result) {
  paint(canvas, tile, i => {
    if (!result.valid[i]) return tile.nodata[i] || other.nodata[i] ? [235, 231, 222] : [217, 205, 183];
    return colorMix([214, 113, 72], [118, 157, 126], result.confidence[i]);
  });
}
function renderMaskList(result) {
  $('maskList').innerHTML = `<div class="mask-row"><span class="mask-index cloud">Cloud</span><div><strong>Cloud</strong><p>Warm paper tint excludes pixels with low visual certainty in either timestamp.</p></div><span class="mask-count">${number(result.cloudCount)} px</span></div><div class="mask-row"><span class="mask-index nodata">Nodata</span><div><strong>No data border</strong><p>Outer border is nodata, not a detected change. It is removed before thresholding.</p></div><span class="mask-count">${number(result.nodataCount)} px</span></div><div class="mask-row"><span class="mask-index confidence">Low</span><div><strong>Low confidence</strong><p>Retained for review; ${number(result.lowConfidenceCount)} valid pixels are below 65% confidence.</p></div><span class="mask-count">${number(result.lowConfidenceCount)} px</span></div>`;
}
function renderContext(before, after, result) {
  const status = result.stale.before || result.stale.after ? ' Stale imagery is retained for transparency, not current observations.' : ' Both timestamps are inside the freshness policy window.';
  $('freshnessNotice').textContent = `Analysis clock · ${dateLabel(STUDIO_TODAY)} · Freshness policy: ${STALE_DAYS} days.${status}`;
  $('beforeFreshness').innerHTML = freshnessCard('BEFORE', before, result.stale.before, result.beforeAgeDays);
  $('afterFreshness').innerHTML = freshnessCard('AFTER', after, result.stale.after, result.afterAgeDays);
  $('beforeFreshness').classList.toggle('is-stale', result.stale.before); $('afterFreshness').classList.toggle('is-stale', result.stale.after);
  const viewCopy = {
    'side-by-side': [state.band === 'infrared' ? 'Infrared signal' : 'Visible-light signal', state.band === 'infrared' ? 'False-color band values · local synthetic signal' : 'RGB values · local synthetic signal'],
    difference: ['Absolute difference', 'Muted pixels are below threshold · warm colors are stronger signal'],
    masks: ['Mask classes', 'Cloud and nodata are excluded · low confidence remains reviewable'],
    confidence: ['Confidence scale', 'Minimum confidence across both timestamps · 0 low to 1 high']
  }[state.view];
  const scale = state.view === 'masks'
    ? '<div class="legend-items"><span class="mask-badge confidence"><i aria-hidden="true"></i>Low confidence · &lt; 65%</span><span class="mask-badge valid"><i aria-hidden="true"></i>Valid · ≥ 65%</span></div>'
    : state.view === 'side-by-side' && state.band === 'visible'
      ? '<span class="legend-scale-note">True-color scene · scoring uses normalized visible-band values</span>'
      : `<div class="legend-scale"><span class="legend-gradient ${state.view === 'side-by-side' ? 'infrared' : state.view}" aria-hidden="true"></span><span>0 · ${state.view === 'confidence' ? 'low' : 'low signal'}</span><span>1 · ${state.view === 'confidence' ? 'high' : 'high signal'}</span></div>`;
  const note = state.view === 'confidence' ? '<span class="legend-scale-note">Synthetic review signal, not a calibrated probability. Below 65% is retained.</span>' : '';
  $('viewLegend').innerHTML = `<strong>${viewCopy[0]}</strong><span>${viewCopy[1]}</span>${scale}${note}`;
}
function render() {
  const { fixture, before, after, result } = comparison();
  $('fixtureSelect').value = state.fixture;
  $('tilePair').innerHTML = tileCard(before, fixture, 'before', result.stale.before, result.beforeAgeDays) + tileCard(after, fixture, 'after', result.stale.after, result.afterAgeDays);
  const color = tile => i => maskedColor(tile, i, state.band === 'infrared' ? irColor(tile.values[i]) : tile.rgb[i]);
  paint($('beforeCanvas'), before, color(before)); paint($('afterCanvas'), after, color(after)); attachInspect($('beforeCanvas'), 'before', before, after, result); attachInspect($('afterCanvas'), 'after', before, after, result);
  renderDifference($('differenceCanvas'), before, after, result); renderConfidence($('confidenceCanvas'), after, before, result); renderMaskList(result);
  paint($('maskCanvas'), before, i => before.nodata[i] || after.nodata[i] ? [235, 231, 222] : before.cloud[i] || after.cloud[i] ? [217, 205, 183] : result.confidence[i] < .65 ? [216, 132, 87] : [170, 185, 161]);
  ['differenceCanvas', 'maskCanvas', 'confidenceCanvas'].forEach(id => { $(id).setAttribute('tabindex', '0'); $(id).setAttribute('aria-describedby', `comparisonLegend viewLegend inspectionHelp beforeFreshness afterFreshness`); attachInspect($(id), state.view, before, after, result); });
  ['tilePair', 'differenceWrap', 'maskWrap', 'confidenceWrap'].forEach(id => $(id).classList.add('is-hidden'));
  const viewId = { 'side-by-side': 'tilePair', difference: 'differenceWrap', masks: 'maskWrap', confidence: 'confidenceWrap' }[state.view]; $(viewId).classList.remove('is-hidden');
  renderContext(before, after, result);
  $('stageCoordinates').textContent = fixture.location; $('geometryGrid').textContent = `${fixture.before.width} × ${fixture.before.height} px`; $('geometryCrs').textContent = fixture.before.crs; $('geometryPixel').textContent = fixture.pixelSize; $('thresholdValue').textContent = state.threshold.toFixed(2); $('analysisClock').textContent = `ANALYSIS CLOCK · ${dateLabel(STUDIO_TODAY)}`; $('alignmentStatus').textContent = `Aligned · ${fixture.before.width} × ${fixture.before.height}`;
  const total = fixture.before.width * fixture.before.height;
  const summary = buildComparisonSummary(result, state.threshold);
  $('changedPixels').textContent = `${number(result.changedCount)} / ${number(total)}`;
  $('changedPercent').textContent = result.validCount ? percent(result.changedCount / total) : 'N/A';
  $('changedBar').style.width = `${result.changedCount / total * 100}%`;
  $('changeSummary').textContent = summary.headline;
  $('changeInterpretation').textContent = summary.interpretation;
  $('validCoverage').textContent = percent(result.coverage);
  $('coverageDetail').textContent = `${number(result.validCount)} of ${number(total)} pixels survived both masks and finite-value checks`;
  $('meanConfidence').textContent = result.meanConfidence === null ? '—' : percent(result.meanConfidence);
  $('freshnessStatus').textContent = result.stale.after ? 'STALE' : 'FRESH';
  $('freshnessStatus').classList.toggle('is-stale', result.stale.after);
  $('freshnessDetail').textContent = result.stale.after ? `${Math.floor(result.afterAgeDays)} days old · policy is ${STALE_DAYS}` : `after image · ${Math.floor(result.afterAgeDays)} days old`;
  $('freshnessDetail').classList.toggle('is-stale', result.stale.after);
  $('exportNote').textContent = `HTML · ${number(result.changedCount)} detections · readable + JSON embedded`;
}
const fixtureSelect = $('fixtureSelect'); fixtureSelect.innerHTML = Object.values(FIXTURES).map(fixture => `<option value="${fixture.key}">${fixture.name}</option>`).join('');
fixtureSelect.addEventListener('change', event => { state.fixture = event.target.value; render(); }); $('thresholdInput').addEventListener('input', event => { state.threshold = Number(event.target.value); render(); });
document.querySelectorAll('[data-band]').forEach(button => button.addEventListener('click', () => { state.band = button.dataset.band; document.querySelectorAll('[data-band]').forEach(item => item.classList.toggle('is-active', item === button)); render(); }));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { state.view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(item => { const active = item === button; item.classList.toggle('is-active', active); item.setAttribute('aria-selected', active); }); render(); }));
let exportTimer;
$('exportButton').addEventListener('click', () => {
  const { fixture, before, after } = comparison();
  const report = buildReport(before, after, state.threshold, { ...options(), fixtureName: fixture.name, band: state.band });
  const blob = new Blob([buildReadableReport(report)], { type: 'text/html' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = `fieldnote-${state.fixture}-${state.band}.html`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const label = $('exportButton').querySelector('span:first-child');
  $('exportButton').classList.add('did-export');
  label.textContent = 'Report exported';
  clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    $('exportButton').classList.remove('did-export');
    label.textContent = 'Export report';
  }, 1800);
});
$('helpButton').addEventListener('click', () => $('helpDialog').showModal()); $('closeHelp').addEventListener('click', () => $('helpDialog').close());
render();
