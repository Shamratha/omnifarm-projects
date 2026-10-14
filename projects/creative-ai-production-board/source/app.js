import { formatSeconds, formatCueTime, buildManifest, checkExportSafety, validateCut, resolveCueAssetId, reflowScenes } from './validation.js';
import { ASSETS, CREDITS, CUTS } from './board-data.js';

const state = {
  activeView: 'board',
  activeCut: 'quiet',
  selectedSceneId: 's03',
  draggedSceneId: null,
  showChecks: false,
  exportSettings: { distribution: 'internal-review', includeUncleared: false, allowUnresolved: false, embedRightsLabels: true },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const getCut = () => CUTS[state.activeCut];
const getScenes = () => getCut().scenes;
const getSelectedScene = () => getScenes().find((scene) => scene.id === state.selectedSceneId) || getScenes()[0];
const getAsset = (id) => ASSETS.find((asset) => asset.id === id);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const sceneIssues = (validation, scene) => validation.issues.filter((issue) => issue.sceneIds.includes(scene.id));
const productionIssues = (validation) => validation.issues.filter((issue) => issue.severity === 'error' && issue.sceneIds.length === 0);
const issueCounts = (validation) => ({
  errors: validation.issues.filter((issue) => issue.severity === 'error').length,
  warnings: validation.issues.filter((issue) => issue.severity === 'warning').length,
});
const checkStatus = (issues) => issues.some((issue) => issue.severity === 'error') ? 'error' : issues.length ? 'watch' : 'match';

function renderIssues(issues, emptyMessage = 'Checks passed. No blocking issues.') {
  if (!issues.length) return `<p class="checks-empty">✓ ${escapeHTML(emptyMessage)}</p>`;
  return `<ul class="issue-list">${issues.map((issue) => `<li class="issue ${issue.severity}" data-code="${escapeHTML(issue.code)}"><span class="issue-level">${issue.severity === 'error' ? 'blocking' : 'review'} / ${escapeHTML(issue.code.replaceAll('-', ' '))}</span><p>${escapeHTML(issue.message)}</p></li>`).join('')}</ul>`;
}

function renderValidationSummary(validation) {
  const { errors, warnings } = issueCounts(validation);
  return `<div class="validation-summary ${validation.ok ? 'ready' : 'blocked'}"><strong>${validation.ok ? '✓' : '!'} ${errors} blocking · ${warnings} review ${warnings === 1 ? 'note' : 'notes'}</strong><span>${validation.ok ? (warnings ? 'Review notes travel with the manifest.' : 'Timing, cues, assets and rights checks passed.') : 'Export blocked. Resolve the issues below.'}</span></div>`;
}

function assetArt(asset, size = 'medium') {
  if (!asset) return `<div class="asset-art missing ${size}" aria-label="Missing asset">!</div>`;
  const symbols = asset.type === 'AUDIO' ? ')))' : asset.tone === 'amber' ? '◒' : asset.tone === 'blue' ? '◌' : asset.tone === 'green' ? '⌁' : '✦';
  const visual = asset.image ? `<img src="${asset.image}" alt="" />` : `<span class="audio-symbol">${symbols}</span><i></i><b></b>`;
  return `<div class="asset-art ${asset.tone} ${size}" aria-hidden="true">${visual}</div>`;
}

function renderAssetRail() {
  $('#asset-list').innerHTML = ASSETS.map((asset) => `
    <button class="asset-row" data-asset="${asset.id}">
      ${assetArt(asset, 'tiny')}
      <span class="asset-row-copy"><strong>${asset.name}</strong><small>${asset.type} · ${asset.rightsLabel}</small></span>
      <span class="asset-status ${asset.rightsStatus}"></span>
    </button>
  `).join('');
  $$('.asset-row').forEach((button) => button.addEventListener('click', () => {
    const asset = getAsset(button.dataset.asset);
    showToast(`${asset.name} is bundled locally`, 'info');
  }));
}

function renderBoard() {
  const cut = getCut();
  const selected = getSelectedScene();
  const validation = getValidation();
  const total = validation.duration > 0 ? validation.duration : Math.max(1, ...cut.scenes.map((scene) => Number.isFinite(scene.end) ? scene.end : 0));
  $('#board-view').innerHTML = `
    <div class="canvas-heading">
      <div><div class="eyebrow compact"><span class="eyebrow-line"></span> sequence / ${cut.scenes.length} scenes</div><h2>Cut the quiet into a <em>signal.</em></h2></div>
      <div class="canvas-heading-meta"><span class="mono">${cut.label.toUpperCase()}</span><strong>${formatSeconds(total)}</strong></div>
    </div>
    <div class="timeline-wrap">
      <div class="timeline-ruler">${[0, 20, 40, 60, 80, 100].map((value) => `<span style="left:${value}%">${formatSeconds(Math.round((total * value) / 100))}</span>`).join('')}</div>
      <div class="timeline-track"><div class="timeline-progress" style="width:${Math.min(100, (selected?.end / total || 0) * 100)}%"></div><span class="playhead" style="left:${(selected?.start / total || 0) * 100}%"></span></div>
    </div>
    ${renderValidationSummary(validation)}
    <div class="scene-list" aria-label="Scenes in active cut">
      ${cut.scenes.map((scene, index) => renderSceneCard(scene, index, total, validation)).join('')}
    </div>
    <div class="board-footnote"><span class="footnote-icon">↕</span> Drag cards to reorder the cut <span class="separator">/</span> every move is saved to this local board</div>
  `;
  bindSceneEvents();
}

function renderSceneCard(scene, index, total, validation) {
  const asset = getAsset(scene.assetId);
  const selected = scene.id === state.selectedSceneId;
  const issues = sceneIssues(validation, scene);
  const status = checkStatus(issues);
  const productionBlocked = productionIssues(validation).length > 0;
  const width = ((scene.end - scene.start) / total) * 100;
  return `
    <article class="scene-card ${selected ? 'selected' : ''}" draggable="true" data-scene="${scene.id}">
      <div class="scene-number">${scene.number}<span></span></div>
      <div class="scene-thumb ${scene.color}">${assetArt(asset, 'large')}<span class="frame-label">${asset ? 'STORYBOARD' : 'MISSING FRAME'}</span><button class="play-button" aria-label="Preview ${scene.title}">▶</button></div>
      <div class="scene-copy"><div class="scene-topline"><span>${formatSeconds(scene.start)} — ${formatSeconds(scene.end)}</span><span class="continuity-chip ${productionBlocked && status === 'match' ? 'error' : status}" title="${escapeHTML([...issues, ...productionIssues(validation)].map((issue) => issue.message).join('\n'))}">${productionBlocked && status === 'match' ? '! production blocked' : status === 'match' ? '✓ scene checks passed' : status === 'error' ? '! blocking issues' : '◐ review notes'}</span></div><h3>${scene.title}</h3><p>${scene.description}</p><div class="scene-tags"><span class="tag">${escapeHTML(asset?.name || `Missing: ${scene.assetId}`)}</span><span class="tag audio-tag">◖ ${scene.silent === true ? 'Intentional silence' : escapeHTML(scene.cueLabel || 'Missing cue label')}</span></div></div>
      <div class="scene-controls"><button class="move-button" data-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Move scene up">↑</button><button class="move-button" data-move="down" ${index === getScenes().length - 1 ? 'disabled' : ''} aria-label="Move scene down">↓</button></div>
      <div class="scene-duration" style="--duration:${width}%"><span>${formatSeconds(scene.end - scene.start)}</span></div>
    </article>
  `;
}

function bindSceneEvents() {
  $$('.scene-card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      state.selectedSceneId = card.dataset.scene;
      renderBoard();
      renderInspector();
    });
    card.addEventListener('dragstart', () => { state.draggedSceneId = card.dataset.scene; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { state.draggedSceneId = null; card.classList.remove('dragging'); $$('.scene-card').forEach((item) => item.classList.remove('drop-target')); });
    card.addEventListener('dragover', (event) => { event.preventDefault(); if (state.draggedSceneId !== card.dataset.scene) card.classList.add('drop-target'); });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (event) => { event.preventDefault(); reorderScenes(state.draggedSceneId, card.dataset.scene); });
    card.querySelector('.play-button').addEventListener('click', (event) => { event.stopPropagation(); showToast(`Preview queued locally: ${getSceneById(card.dataset.scene).title}`, 'info'); });
    card.querySelectorAll('.move-button').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); moveScene(card.dataset.scene, button.dataset.move === 'up' ? -1 : 1); }));
  });
}

function getSceneById(id) { return getScenes().find((scene) => scene.id === id); }

function moveScene(id, direction) {
  const scenes = getScenes();
  const index = scenes.findIndex((scene) => scene.id === id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= scenes.length) return;
  if (getValidation().invalidTimings.length) return showToast('Fix invalid scene durations before reordering', 'error');
  [scenes[index], scenes[nextIndex]] = [scenes[nextIndex], scenes[index]];
  normalizeTimings(scenes);
  state.selectedSceneId = id;
  saveAndRender('Scene order saved');
}

function reorderScenes(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  const scenes = getScenes();
  const sourceIndex = scenes.findIndex((scene) => scene.id === sourceId);
  const targetIndex = scenes.findIndex((scene) => scene.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  if (getValidation().invalidTimings.length) return showToast('Fix invalid scene durations before reordering', 'error');
  const [source] = scenes.splice(sourceIndex, 1);
  scenes.splice(targetIndex, 0, source);
  normalizeTimings(scenes);
  state.selectedSceneId = sourceId;
  saveAndRender('Scene order saved');
}

function normalizeTimings(scenes) {
  const retimed = reflowScenes(scenes);
  scenes.splice(0, scenes.length, ...retimed);
  getCut().duration = scenes.at(-1)?.end ?? 0;
}

function renderInspector() {
  const scene = getSelectedScene();
  if (!scene) { $('#inspector').innerHTML = '<p class="checks-empty">No scenes in this cut.</p>'; return; }
  const asset = getAsset(scene.assetId);
  const validation = getValidation();
  const issues = sceneIssues(validation, scene);
  const cueAsset = getAsset(resolveCueAssetId(scene));
  const status = checkStatus(issues);
  const productionLevelIssues = productionIssues(validation);
  $('#inspector').innerHTML = `
    <div class="inspector-heading"><div><div class="section-label"><span>scene inspector</span><span class="mono">${scene.number} / ${getScenes().length}</span></div><h2>${scene.title}</h2></div><button class="close-inspector" aria-label="Close inspector">×</button></div>
    <div class="inspector-preview ${scene.color}">${assetArt(asset, 'inspector')}<div class="preview-overlay"><span>${formatSeconds(scene.start)} — ${formatSeconds(scene.end)}</span><button class="play-button" aria-label="Preview storyboard">▶</button></div></div>
    <div class="inspector-section"><span class="inspector-label">direction note</span><p class="direction-note">${scene.description}</p></div>
    <div class="inspector-section"><div class="inspector-label-row"><span class="inspector-label">audio cue</span><span class="cue-state">${scene.silent === true ? 'silent' : cueAsset?.type === 'AUDIO' ? 'linked metadata' : 'missing cue'}</span></div><div class="cue-card"><span class="waveform">▂▅▃▇▅▃▆▂▅▇▃▅▂▆</span><div><strong>${scene.silent === true ? 'Intentional silence' : escapeHTML(scene.cueLabel || 'No cue label')}</strong><small>${escapeHTML(scene.cueTime ?? formatCueTime(scene.start))} · ${escapeHTML(cueAsset?.meta || 'No linked audio cue')}</small></div></div></div>
    <div class="inspector-section"><div class="inspector-label-row"><span class="inspector-label">computed checks</span><span class="continuity-chip ${productionLevelIssues.length && status === 'match' ? 'error' : status}">${productionLevelIssues.length && status === 'match' ? 'blocked' : status === 'match' ? 'pass' : status === 'error' ? 'blocked' : 'review'}</span></div>${renderIssues([...issues, ...productionLevelIssues], productionLevelIssues.length ? 'Scene checks passed, but production-level issues block export.' : 'Timing, cue and rights checks passed.')}</div>
    <div class="inspector-section asset-detail"><div class="inspector-label-row"><span class="inspector-label">source asset</span><span class="asset-status ${asset?.rightsStatus || 'missing'}"></span></div><div class="asset-detail-row">${assetArt(asset, 'tiny')}<div><strong>${escapeHTML(asset?.name || `Missing: ${scene.assetId}`)}</strong><small>${escapeHTML(asset?.rightsLabel || 'Missing rights label')}</small></div></div></div>
    <button class="full-width-button" id="inspect-rights">Open rights record <span>↗</span></button>
    <form id="timing-form" class="timing-form"><div class="inspector-label">edit timing / seconds</div><div class="timing-grid"><label>Start<input name="start" type="number" step="any" min="0" required value="${Number.isFinite(scene.start) ? scene.start : ''}"></label><label>End<input name="end" type="number" step="any" min="0" required value="${Number.isFinite(scene.end) ? scene.end : ''}"></label></div><label>Audio cue<select name="cueAssetId"><option value="">Missing / not linked</option>${ASSETS.filter((item) => item.type === 'AUDIO').map((item) => `<option value="${item.id}" ${resolveCueAssetId(scene) === item.id ? 'selected' : ''}>${item.name}</option>`).join('')}<option value="silent" ${scene.silent === true ? 'selected' : ''}>Intentional silence</option></select></label><label>Cue entry · MM:SS (optional)<input name="cueTime" value="${escapeHTML(scene.cueTime ?? '')}" placeholder="Use scene start"></label><button type="submit" class="full-width-button">Apply & check timing <span>→</span></button><p>Gaps are review notes. Overlaps and missing cues block export. Timing edits do not ripple other scenes.</p></form>
  `;
  $('#inspector').querySelector('.close-inspector').addEventListener('click', () => showToast('Inspector stays pinned to the selected scene', 'info'));
  $('#inspect-rights').addEventListener('click', () => switchView('rights'));
  $('#inspector').querySelector('.play-button').addEventListener('click', () => showToast(`Preview queued locally: ${scene.title}`, 'info'));
  $('#timing-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    scene.start = Number(fields.get('start'));
    scene.end = Number(fields.get('end'));
    const cue = fields.get('cueAssetId');
    scene.silent = cue === 'silent';
    delete scene.cue;
    delete scene.cueAssetId;
    delete scene.cueTime;
    if (!scene.silent) {
      scene.cueAssetId = cue;
      if (fields.get('cueTime').trim()) scene.cueTime = fields.get('cueTime').trim();
    }
    saveAndRender('Timing updated · checks refreshed');
  });
}

function renderCompare() {
  const quiet = CUTS.quiet;
  const pulse = CUTS.pulse;
  $('#compare-view').innerHTML = `
    <div class="canvas-heading"><div><div class="eyebrow compact"><span class="eyebrow-line"></span> editorial compare</div><h2>Two ways to hear the <em>same story.</em></h2></div><div class="canvas-heading-meta"><span class="mono">DELTA</span><strong>${formatSeconds(Math.abs(quiet.duration - pulse.duration))}</strong></div></div>
    <div class="compare-intro"><p>Keep the quiet breathing room, or sharpen the pulse for a faster room-04 screening. Both cuts use the same bundled source assets.</p><span class="compare-note">No generative calls · local only</span></div>
    <div class="compare-grid">${renderCutColumn('A', quiet, true)}${renderCutColumn('B', pulse, false)}</div>
    <div class="compare-footer"><span class="footnote-icon">↔</span> Select a cut above to make it active. Scene order can be edited from Board.</div>
  `;
  $$('.choose-cut').forEach((button) => button.addEventListener('click', () => { setCut(button.dataset.cut); switchView('board'); }));
}

function renderCutColumn(letter, cut, recommended) {
  const active = state.activeCut === (letter === 'A' ? 'quiet' : 'pulse');
  const validation = getValidation(cut);
  const timingCodes = new Set(['timing-overlap', 'timing-gap', 'scene-order', 'invalid-timing']);
  const timingIssues = validation.issues.filter((issue) => timingCodes.has(issue.code));
  return `<article class="cut-column ${active ? 'active' : ''}" data-cut="${letter === 'A' ? 'quiet' : 'pulse'}"><div class="cut-column-header"><div><span class="cut-letter">${letter}</span><div><span class="eyebrow compact">${recommended ? 'original' : 'alternate'}</span><h3>${cut.label}</h3></div></div><button class="choose-cut ${active ? 'chosen' : ''}" data-cut="${letter === 'A' ? 'quiet' : 'pulse'}">${active ? 'active cut' : 'use this cut'} <span>→</span></button></div><div class="cut-stats"><span><strong>${formatSeconds(cut.duration)}</strong> runtime</span><span><strong>${cut.scenes.length}</strong> scenes</span><span><strong>${timingIssues.length ? 'review' : 'pass'}</strong> timing</span></div><div class="mini-timeline">${cut.scenes.map((scene) => `<div class="mini-segment ${scene.color}" style="flex:${Math.max(0, scene.end - scene.start) || 1}" title="${scene.title}"></div>`).join('')}</div>${renderValidationSummary(validation)}${renderIssues(validation.issues)}<ol class="cut-scenes">${cut.scenes.map((scene) => {
    const status = checkStatus(sceneIssues(validation, scene));
    return `<li><span>${scene.number}</span><div><strong>${scene.title}</strong><small>${formatSeconds(scene.start)}–${formatSeconds(scene.end)} · ${scene.silent === true ? 'silent' : escapeHTML(scene.cueLabel || 'Missing cue')}</small></div><i class="${status}" aria-label="${status === 'match' ? 'Checks passed' : status === 'error' ? 'Blocking issue' : 'Review note'}">${status === 'match' ? '✓' : '!'}</i></li>`;
  }).join('')}</ol></article>`;
}

function renderRights() {
  const validation = getValidation();
  const usedAssetIds = [...new Set(getScenes().flatMap((scene) => [scene.assetId, ...(scene.silent === true ? [] : [resolveCueAssetId(scene)])]))];
  const rightsIssues = validation.issues.filter((issue) => ['rights-label', 'rights-clearance', 'editorial-rights', 'missing-frame', 'missing-cue', 'asset-type', 'duplicate-credit', 'invalid-credit'].includes(issue.code));
  const blockedRights = rightsIssues.some((issue) => issue.severity === 'error');
  $('#rights-view').innerHTML = `
    <div class="canvas-heading"><div><div class="eyebrow compact"><span class="eyebrow-line"></span> provenance / rights</div><h2>Every frame has a <em>paper trail.</em></h2></div><div class="canvas-heading-meta"><span class="mono">${usedAssetIds.length} USED</span><strong>${blockedRights ? 'BLOCKED' : rightsIssues.length ? 'REVIEW' : 'CLEAR'}</strong></div></div>
    <div class="rights-summary"><div class="rights-score"><span class="score-ring">${blockedRights ? '!' : '✓'}</span><div><strong>${blockedRights ? 'Rights checks block export' : rightsIssues.length ? 'Internal review only' : 'Rights checks passed'}</strong><p>Current scope: ${escapeHTML(state.exportSettings.distribution)}. Rights labels travel with every frame and audio cue.</p></div></div><div class="rights-legend"><span><i class="asset-status cleared"></i> cleared</span><span><i class="asset-status editorial"></i> editorial</span><span><i class="asset-status ai-assisted"></i> AI-assisted</span></div></div>
    ${renderIssues(rightsIssues, 'No unresolved rights labels or clearance issues.')}
    <div class="rights-table-wrap"><div class="table-heading"><span>asset / cue</span><span>used in</span><span>label</span><span>status</span></div><div class="rights-table">${ASSETS.map((asset) => renderRightsRow(asset)).join('')}</div></div>
    <div class="credits-panel"><div class="section-label"><span>credits carried into export</span><span class="mono">${CREDITS.length}</span></div><div class="credits-list">${CREDITS.map((credit) => `<div><span class="credit-avatar">${credit.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><strong>${credit.name}</strong><span>${credit.role}</span><i>✓</i></div>`).join('')}</div></div>
  `;
}

function renderRightsRow(asset) {
  const usedIn = getScenes().filter((scene) => scene.assetId === asset.id || (scene.silent !== true && resolveCueAssetId(scene) === asset.id)).map((scene) => scene.number).join(', ') || '—';
  const cleared = ['cleared', 'editorial', 'ai-assisted'].includes(asset.rightsStatus) && asset.rightsLabel?.trim();
  return `<div class="rights-row"><div class="rights-asset">${assetArt(asset, 'tiny')}<div><strong>${asset.name}</strong><small>${asset.type} · ${asset.meta}</small></div></div><span class="used-scenes">${usedIn}</span><span class="rights-label ${asset.rightsLabel?.trim() ? '' : 'missing-label'}">${escapeHTML(asset.rightsLabel?.trim() || 'Missing rights label')}</span><span class="rights-status ${asset.rightsStatus}">${!cleared ? 'blocked' : asset.rightsStatus === 'cleared' ? 'cleared' : asset.rightsStatus === 'editorial' ? 'internal only' : 'AI-assisted'}</span></div>`;
}

function getValidation(cut = getCut()) {
  return validateCut({ cut, assets: ASSETS, credits: CREDITS, exportSettings: state.exportSettings });
}

function renderCurrentView() {
  renderBoard();
  renderCompare();
  renderRights();
  renderInspector();
  updateHealth();
  updateViewVisibility();
}

function updateViewVisibility() {
  $$('.view-panel').forEach((panel) => panel.classList.toggle('active-view', panel.id === `${state.activeView}-view`));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === state.activeView));
}

function updateHealth() {
  const validation = getValidation();
  const { errors, warnings } = issueCounts(validation);
  const score = validation.ok ? (warnings ? 92 : 100) : Math.max(24, 100 - (errors * 12));
  $('#health-score').textContent = score;
  $('#health-bar-fill').style.width = `${score}%`;
  $('#view-issues').textContent = errors ? `View ${errors} blocking issue${errors === 1 ? '' : 's'} →` : warnings ? `View ${warnings} review note${warnings === 1 ? '' : 's'} →` : 'View 0 blocking issues →';
}

function switchView(view) {
  state.activeView = view;
  updateViewVisibility();
  if (view === 'rights') renderRights();
  if (view === 'compare') renderCompare();
}

function setCut(cut) {
  state.activeCut = cut;
  state.selectedSceneId = (CUTS[cut].scenes[2] || CUTS[cut].scenes[0])?.id;
  $$('.cut-option').forEach((button) => button.classList.toggle('active', button.dataset.cut === cut));
  renderCurrentView();
  showToast(`${CUTS[cut].label} is now active`, 'success');
}

function saveAndRender(message) {
  $('#saved-time').textContent = 'just now';
  renderCurrentView();
  showToast(message, 'success');
}

function runChecks() {
  const validation = getValidation();
  state.showChecks = true;
  updateHealth();
  const grouped = [
    ['Timing continuity', ['timing-overlap', 'timing-gap', 'scene-order', 'invalid-timing']],
    ['Audio cues', ['missing-cue', 'cue-timing']],
    ['Assets', ['missing-frame', 'asset-type']],
    ['Rights labels & clearance', ['rights-label', 'rights-clearance', 'editorial-rights']],
    ['Credits & export settings', ['duplicate-credit', 'invalid-credit', 'unsafe-setting']],
  ];
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal checks-modal" role="dialog" aria-modal="true" aria-labelledby="checks-title"><div class="modal-header"><div><div class="eyebrow compact"><span class="eyebrow-line"></span> production checks / ${escapeHTML(getCut().label)}</div><h2 id="checks-title">Continuity <em>report.</em></h2></div><button class="modal-close" aria-label="Close">×</button></div>${renderValidationSummary(validation)}<div class="check-summary">${grouped.map(([label, codes]) => { const issues = validation.issues.filter((issue) => codes.includes(issue.code)); const blocking = issues.filter((issue) => issue.severity === 'error').length; return `<div class="check-summary-row ${blocking ? 'error' : issues.length ? 'warn' : 'pass'}"><span>${blocking ? '!' : issues.length ? '◐' : '✓'}</span><div><strong>${label}</strong><small>${blocking ? `${blocking} blocking issue${blocking === 1 ? '' : 's'}` : issues.length ? `${issues.length} review note${issues.length === 1 ? '' : 's'}` : 'No issues found'}</small>${issues.length ? renderIssues(issues) : ''}</div></div>`; }).join('')}</div><div class="modal-footer"><span class="mono">${validation.timingGaps.length} timing gap${validation.timingGaps.length === 1 ? '' : 's'} · ${validation.missingCues.length} missing cue${validation.missingCues.length === 1 ? '' : 's'}</span><button class="primary-button modal-close-action">back to ${state.activeView}</button></div></section></div>`;
  $('.modal-close').addEventListener('click', closeModal);
  $('.modal-close-action').addEventListener('click', closeModal);
  $('.modal-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
  renderInspector();
  showToast(validation.ok ? (validation.warnings.length ? 'Checks complete · 1 review note' : 'All production checks passed') : `${validation.errors.length} blocking checks need attention`, validation.ok ? 'success' : 'error');
}

function openExportModal() {
  const validation = getValidation();
  const safety = checkExportSafety(state.exportSettings, validation);
  const readyLabel = state.exportSettings.distribution === 'internal-review'
    ? 'Ready for internal-review export'
    : 'Ready for selected-scope manifest export';
  const statusDetail = safety.safe
    ? 'Active cut only. The JSON handoff preserves review notes and rights labels; export readiness is not public-delivery clearance.'
    : safety.blockers.join(' · ');
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop">
      <section class="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <div class="modal-header">
          <div><div class="eyebrow compact"><span class="eyebrow-line"></span> local handoff</div><h2 id="export-title">Export production <em>manifest.</em></h2></div>
          <button class="modal-close" aria-label="Close">×</button>
        </div>
        <p class="modal-copy">Download a JSON production handoff with scene timing, local asset references, audio cue metadata, credits, rights labels, and continuity checks. No media rendering or live model calls.</p>
        <p class="modal-copy export-scope">Active cut: <strong>${escapeHTML(getCut().label)}</strong>. Alternate-cut reports are diagnostic only, not approved for delivery.</p>
        <div class="export-status ${safety.safe ? 'safe' : 'unsafe'}">
          <span>${safety.safe ? '✓' : '!'}</span><div><strong>${safety.safe ? readyLabel : 'Export blocked'}</strong><small>${escapeHTML(statusDetail)}</small></div>
        </div>
        ${validation.editorialAssets.length ? '<p class="modal-copy delivery-limitation"><strong>Delivery limitation:</strong> editorial-only assets restrict this cut to internal review. Public delivery remains blocked.</p>' : ''}
        ${renderIssues(validation.issues, 'No active-cut blocking issues. Alternate-cut diagnostics are included separately in the manifest.')}
        <div class="settings-list">
          <label><span><strong>Distribution</strong><small>Editorial-only assets restrict this project to internal review.</small></span><select data-setting="distribution"><option value="internal-review" ${state.exportSettings.distribution === 'internal-review' ? 'selected' : ''}>Internal review</option><option value="public" ${state.exportSettings.distribution === 'public' ? 'selected' : ''}>Public delivery</option></select></label>
          <label><span><strong>Embed rights labels</strong><small>Required for every frame and audio cue reference.</small></span><input type="checkbox" data-setting="embedRightsLabels" ${state.exportSettings.embedRightsLabels ? 'checked' : ''}></label>
          <label><span><strong>Include uncleared assets</strong><small>Unsafe — blocks export in every distribution scope.</small></span><input type="checkbox" data-setting="includeUncleared" ${state.exportSettings.includeUncleared ? 'checked' : ''}></label>
          <label><span><strong>Allow unresolved checks</strong><small>Unsafe — blocking checks must be resolved before export.</small></span><input type="checkbox" data-setting="allowUnresolved" ${state.exportSettings.allowUnresolved ? 'checked' : ''}></label>
        </div>
        <div class="modal-footer"><span class="mono">${escapeHTML(getCut().label.toUpperCase())} · ${formatSeconds(validation.duration)}</span><button class="primary-button ${safety.safe ? '' : 'disabled'}" id="download-manifest" ${safety.safe ? '' : 'disabled'}>${safety.safe ? 'Download JSON manifest ↗' : 'Resolve export blockers'}</button></div>
      </section>
    </div>`;
  $('.modal-close').addEventListener('click', closeModal);
  $('.modal-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
  $$('.settings-list input').forEach((input) => input.addEventListener('change', () => { state.exportSettings[input.dataset.setting] = input.checked; openExportModal(); }));
  $('select[data-setting="distribution"]').addEventListener('change', (event) => { state.exportSettings.distribution = event.target.value; openExportModal(); });
  $('#download-manifest')?.addEventListener('click', downloadManifest);
}

function downloadManifest() {
  const validation = getValidation();
  let manifest;
  try {
    manifest = buildManifest({ project: 'The last signal', cutKey: state.activeCut, cut: getCut(), assets: ASSETS, credits: CREDITS, settings: state.exportSettings, alternateCuts: CUTS });
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'the-last-signal-production-manifest.json';
  link.click();
  URL.revokeObjectURL(link.href);
  closeModal();
  showToast(state.exportSettings.distribution === 'internal-review'
    ? 'Internal-review manifest downloaded · delivery limitations retained'
    : 'Manifest downloaded · rights labels and review notes retained', 'success');
}

function closeModal() { $('#modal-root').innerHTML = ''; }

function showToast(message, tone = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.innerHTML = `<span>${tone === 'error' ? '!' : tone === 'info' ? 'i' : '✓'}</span>${message}`;
  $('#toast-root').append(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 250); }, 3200);
}

function openHelp() {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal help-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><div class="eyebrow compact"><span class="eyebrow-line"></span> about the workspace</div><h2>Make a cut. <em>Keep a trail.</em></h2></div><button class="modal-close" aria-label="Close">×</button></div><div class="help-grid"><div><span class="help-number">01</span><h3>Arrange</h3><p>Drag scene cards or use the arrows to reorder the active cut. Timing is rebuilt locally after every move.</p></div><div><span class="help-number">02</span><h3>Compare</h3><p>Switch between Quiet Signal and Pulse Edit without changing the bundled source assets.</p></div><div><span class="help-number">03</span><h3>Prove</h3><p>Run continuity, timing, asset, credit, and rights checks before exporting a portable manifest.</p></div></div><div class="help-footer"><span class="local-badge"><i></i> no live generative model calls</span><button class="primary-button modal-close-action">back to board</button></div></section></div>`;
  $('.modal-close').addEventListener('click', closeModal);
  $('.modal-close-action').addEventListener('click', closeModal);
  $('.modal-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('.cut-option').forEach((button) => button.addEventListener('click', () => setCut(button.dataset.cut)));
$('#run-checks').addEventListener('click', runChecks);
$('#export-button').addEventListener('click', openExportModal);
$('#help-button').addEventListener('click', openHelp);
$('#view-issues').addEventListener('click', () => { runChecks(); switchView('rights'); });
document.addEventListener('keydown', (event) => {
  if (event.key === '?' && !event.target.matches('input, textarea')) openHelp();
  if (event.key === 'Escape') closeModal();
});

renderAssetRail();
renderCurrentView();
