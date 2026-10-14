import { createInspectorDocument, validateDocument, summarizePipeline, exportManifest, compareRevisions, clone } from './src/pipeline.js';
import { renderPipelinePreview } from './src/preview.js';

const documentState = createInspectorDocument();
let selectedId = 'mountain';
let addedLayerNumber = 1;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const toast = (message) => { const node = $('#toast'); node.textContent = message; node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 2400); };
const iconFor = (type) => ({ raster: '▧', vector: '◈', adjustment: '◌', text: 'T' }[type] ?? '◌');
const thumbClass = (layer) => `thumb thumb-${layer.thumbnail ?? 'mountain'}`;
const currentLayer = () => documentState.layers.find((layer) => layer.id === selectedId) ?? documentState.layers[0];
const currentValidation = () => validateDocument(documentState);
const assetFor = (id) => documentState.assets.find((asset) => asset.id === id);

function renderLayers() {
  const list = $('#layerList');
  list.innerHTML = documentState.layers.map((layer) => {
    const missing = (layer.assetId && !assetFor(layer.assetId)) || (layer.mask?.assetId && !assetFor(layer.mask.assetId));
    const rowState = missing ? 'MISSING' : layer.mask?.enabled ? 'MASKED' : layer.type === 'adjustment' ? 'LIVE' : 'LINKED';
    return `<div class="layer-item accent-${escapeHtml(layer.accent ?? 'cyan')} ${layer.id === selectedId ? 'selected' : ''}" data-layer-id="${escapeHtml(layer.id)}"><button class="visibility ${layer.visible ? '' : 'off'}" data-action="visibility" aria-label="Toggle ${escapeHtml(layer.name)} visibility">${layer.visible ? '◉' : '◌'}</button><div class="${thumbClass(layer)}"></div><div class="layer-info"><div class="layer-name">${escapeHtml(layer.name)}</div><div class="layer-meta">${iconFor(layer.type)} &nbsp;${escapeHtml(layer.type.toUpperCase())} &nbsp;·&nbsp; ${escapeHtml(layer.blendMode ?? 'Normal')}</div></div><span class="layer-state ${missing ? 'warn' : ''}">${rowState}</span></div>`;
  }).join('');
  list.querySelectorAll('.layer-item').forEach((item) => item.addEventListener('click', (event) => {
    const layer = documentState.layers.find((candidate) => candidate.id === item.dataset.layerId);
    if (event.target.dataset.action === 'visibility') layer.visible = !layer.visible;
    else selectedId = layer.id;
    render();
  }));
}

function renderInspector() {
  const layer = currentLayer();
  const asset = layer.assetId ? assetFor(layer.assetId) : null;
  const maskAsset = layer.mask?.assetId ? assetFor(layer.mask.assetId) : null;
  const assetMissing = Boolean(layer.assetId && !asset);
  const hasDestructiveEdit = summarizePipeline(documentState).destructiveEdits.edits.some((edit) => edit.subjectId === layer.id);
  $('#selectedLayerName').textContent = layer.name;
  $('#selectedLayerType').innerHTML = `${escapeHtml(layer.type.toUpperCase())} OBJECT <span>•</span> ${assetMissing ? 'BROKEN REFERENCE' : hasDestructiveEdit ? 'DESTRUCTIVE HISTORY' : 'NON-DESTRUCTIVE'}`;
  $('#opacityRange').value = Math.round((layer.opacity ?? 1) * 100);
  $('#opacityValue').textContent = `${$('#opacityRange').value}%`;
  $('#blendMode').value = layer.blendMode ?? 'Normal';
  $('.selected-thumb').className = `selected-thumb ${thumbClass(layer)}`;
  $('#previewStatus').textContent = 'Local fixture preview · unresolved assets skipped';

  $('#maskSection').innerHTML = layer.mask ? `<div class="section-title">MASK <span class="pill ${maskAsset ? 'cyan-pill' : 'amber-pill'}">${maskAsset ? 'ACTIVE' : 'MISSING'}</span><span>⌃</span></div><div class="mask-card"><div class="mask-preview"></div><div><b>${escapeHtml(maskAsset?.name ?? layer.mask.assetId)}</b><span>GRAYSCALE · 1600 × 1000</span><span class="mask-state ${maskAsset ? '' : 'missing-state'}"><i class="${maskAsset ? 'green-dot' : 'amber-dot'}"></i> ${maskAsset ? 'LINKED' : 'UNRESOLVED'}</span></div><button class="more-button">•••</button></div><label class="switch-line"><span>Invert mask</span><input type="checkbox" id="invertMask" ${layer.mask.invert ? 'checked' : ''} /><span class="switch"></span></label>` : `<div class="section-title">MASK <span class="pill neutral-pill">NONE</span><span>⌃</span></div><div class="empty-control">No mask attached to this layer.</div>`;
  $('#parametersSection').innerHTML = `<div class="section-title">ADJUSTMENT PARAMETERS <span>⌃</span></div><div class="param-row"><label>FEATHER</label><div class="value-input"><input id="featherInput" value="${escapeHtml(layer.mask?.feather ?? layer.params?.feather ?? 0)}" ${layer.mask ? '' : 'disabled'} /><span>PX</span></div></div><div class="param-row"><label>EDGE SHIFT</label><div class="value-input"><input id="edgeShiftInput" value="${escapeHtml(layer.mask?.edgeShift ?? layer.params?.edgeShift ?? 0)}" ${layer.mask ? '' : 'disabled'} /><span>PX</span></div></div>`;
  $('#sourceSection').innerHTML = `<div class="section-title">SOURCE ASSET <span>⌃</span></div>${asset || assetMissing ? `<div class="source-row"><span class="file-icon">▧</span><div><b>${escapeHtml(asset?.name ?? layer.assetId)}</b><span>${asset ? `${escapeHtml(asset.size)} · ${escapeHtml(asset.kind.toUpperCase())}` : 'Reference is not present locally'}</span></div><span class="linked ${assetMissing ? 'missing-state' : ''}">${asset ? 'LINKED' : 'MISSING'}</span></div>` : '<div class="empty-control">No external asset; generated by pipeline parameters.</div>'}${asset ? `<div class="source-row"><span class="profile-icon">◉</span><div><b>${escapeHtml(asset.profile)}</b><span>Embedded color profile</span></div><span class="linked">OK</span></div>` : ''}`;
  bindInspectorControls();
}

function bindInspectorControls() {
  $('#invertMask')?.addEventListener('change', (event) => { const layer = currentLayer(); if (layer.mask) { layer.mask.invert = event.target.checked; toast(`Mask ${event.target.checked ? 'inverted' : 'restored'} · revision marked locally`); renderCompare(); renderPreview(); } });
  $('#featherInput')?.addEventListener('change', (event) => { const layer = currentLayer(); if (layer.mask) { layer.mask.feather = Number(event.target.value) || 0; toast(`Mask feather set to ${layer.mask.feather}px`); renderCompare(); renderPreview(); } });
  $('#edgeShiftInput')?.addEventListener('change', (event) => { const layer = currentLayer(); if (layer.mask) { layer.mask.edgeShift = Number(event.target.value) || 0; toast(`Mask edge shift set to ${layer.mask.edgeShift}px`); renderCompare(); renderPreview(); } });
}

function renderValidation() {
  const validation = currentValidation();
  const summary = summarizePipeline(documentState, { validation });
  const broken = validation.issues.length;
  const referencedAssetIds = new Set(documentState.layers.flatMap((layer) => [layer.assetId, layer.mask?.assetId]).filter(Boolean));
  const presentReferences = [...referencedAssetIds].filter((id) => assetFor(id)).length;
  $('#validationPill').textContent = broken ? `${broken} ISSUE${broken === 1 ? '' : 'S'}` : summary.destructiveEdits.count ? 'REVIEW' : 'PASSING';
  $('#validationPill').className = `pill ${broken || summary.destructiveEdits.count ? 'amber-pill' : 'green-pill'}`;
  $('#brokenRefLabel').textContent = `${summary.brokenReferences.count} broken reference${summary.brokenReferences.count === 1 ? '' : 's'}`;
  const referenceStatus = $('#brokenRefLabel').parentElement;
  referenceStatus.classList.toggle('warning', summary.brokenReferences.count > 0);
  referenceStatus.querySelector('b').textContent = summary.brokenReferences.count ? 'FIX' : 'OK';
  const editStatus = $('#destructiveSummary').parentElement.nextElementSibling;
  editStatus.classList.toggle('warning', summary.destructiveEdits.count > 0);
  editStatus.innerHTML = `<span class="${summary.destructiveEdits.count ? 'amber-dot' : 'green-dot'}"></span><span>${summary.destructiveEdits.count ? 'Destructive edits recorded' : 'No destructive edits recorded'}</span><b>${summary.destructiveEdits.count ? 'REVIEW' : 'OK'}</b>`;
  $('#refCount').textContent = `${presentReferences} / ${referencedAssetIds.size}`;
  $('#referenceSummary').innerHTML = `<span class="mini-dot ${broken ? 'amber' : 'green'}"></span> ${broken ? 'REFERENCE CHECK' : 'ALL REFERENCES OK'} <span class="ref-count" id="refCount">${presentReferences} / ${referencedAssetIds.size}</span>`;
  $('#destructiveSummary').innerHTML = `<span class="summary-label">DESTRUCTIVE EDITS</span><strong>${summary.destructiveEdits.count}</strong><span class="summary-detail">${summary.destructiveEdits.count ? 'Review before publishing' : 'None recorded'}</span>`;
  $('#destructiveSummary').classList.toggle('warning', summary.destructiveEdits.count > 0);
  $('#brokenSummary').innerHTML = `<span class="summary-label">BROKEN REFERENCES</span><strong>${summary.brokenReferences.count}</strong><span class="summary-detail">${summary.brokenReferences.count ? 'Assets or links need attention' : 'All links resolve'}</span>`;
  $('#brokenSummary').classList.toggle('warning', summary.brokenReferences.count > 0);
  const editDetails = summary.destructiveEdits.edits.map((edit) => `<li><b>${escapeHtml(edit.type)}</b><span>${escapeHtml(edit.layerName)} · ${escapeHtml(edit.path)}</span></li>`).join('');
  const referenceDetails = summary.brokenReferences.references.map((reference) => `<li><b>${escapeHtml(reference.code)}</b><span>${escapeHtml(reference.layerName)} · ${escapeHtml(reference.details?.assetId ?? reference.details?.parentId ?? reference.path)}</span></li>`).join('');
  $('#summaryFindings').innerHTML = `<details ${summary.destructiveEdits.count ? 'open' : ''}><summary>Recorded destructive edits (${summary.destructiveEdits.count})</summary>${editDetails ? `<ul>${editDetails}</ul>` : '<p>No destructive operations recorded in this document.</p>'}</details><details ${summary.brokenReferences.count ? 'open' : ''}><summary>Broken reference findings (${summary.brokenReferences.count})</summary>${referenceDetails ? `<ul>${referenceDetails}</ul>` : '<p>No broken references detected.</p>'}</details>`;
}

function renderPreview() {
  const caption = documentState.layers.find((layer) => layer.id === 'caption');
  const captionNode = $('.art-caption');
  captionNode.classList.toggle('preview-hidden', caption?.visible === false);
  captionNode.setAttribute('aria-hidden', caption?.visible === false ? 'true' : 'false');
  captionNode.style.opacity = String(caption?.opacity ?? 1);
  captionNode.style.mixBlendMode = { Normal: 'normal', 'Soft light': 'soft-light', Overlay: 'overlay', Multiply: 'multiply' }[caption?.blendMode] ?? 'normal';
  $('#artboard').dataset.visibleLayers = documentState.layers.filter((layer) => layer.visible !== false).map((layer) => layer.id).join(',');
  renderPipelinePreview(documentState, $('#pipelinePreview')).catch((error) => { $('#previewStatus').textContent = error.message; });
}

function renderCompare() {
  const result = compareRevisions(previousRevision, documentState);
  const changes = result.changes;
  const iconForChange = (change) => ({ 'property-changed': ['cyan', '✣', 'Property updated'], 'layer-reordered': ['orange', '↕', 'Layer reordered'], 'profile-changed': ['violet', '◌', 'Profile converted'], 'layer-added': ['green', '+', 'Layer added'], 'layer-removed': ['red', '−', 'Layer removed'] }[change.type] ?? ['cyan', '•', change.type]);
  const summary = summarizePipeline(documentState);
  $('#compareTab').innerHTML = `<div class="compare-header"><div><span class="eyebrow">REVISION DIFF</span><h2>${escapeHtml(result.fromRevision)} <span>→</span> ${escapeHtml(result.toRevision)}</h2></div><span class="pill ${changes.length ? 'amber-pill' : 'green-pill'}">${changes.length} CHANGE${changes.length === 1 ? '' : 'S'}</span></div>${changes.length ? `<div class="diff-list">${changes.map((change) => { const [tone, icon, label] = iconForChange(change); return `<div class="diff-item"><span class="diff-icon ${tone}">${icon}</span><div><b>${label}</b><span>${escapeHtml(change.subjectId ?? change.path)}</span></div><em>${change.destructive ? 'DESTRUCTIVE' : 'NON-DESTRUCTIVE'}</em></div>`; }).join('')}</div>` : '<div class="empty-compare">No changes detected between these revisions.</div>'}<div class="compare-summary"><div><span>DESTRUCTIVE CHANGES</span><strong>${summary.destructiveEdits.count}</strong></div><div><span>BROKEN REFERENCES</span><strong>${summary.brokenReferences.count}</strong></div><p>${summary.destructiveEdits.count || summary.brokenReferences.count ? 'Review pipeline findings before publishing.' : 'No destructive edits or broken references detected.'}</p></div>`;
}

function render() { renderLayers(); renderInspector(); renderValidation(); renderCompare(); renderPreview(); $('#layerCount').textContent = `${String(documentState.layers.length).padStart(2, '0')} LAYERS`; }

$('#opacityRange').addEventListener('input', (event) => { currentLayer().opacity = Number(event.target.value) / 100; $('#opacityValue').textContent = `${event.target.value}%`; renderLayers(); renderCompare(); renderPreview(); });
$('#blendMode').addEventListener('change', (event) => { currentLayer().blendMode = event.target.value; renderLayers(); renderCompare(); renderPreview(); });
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab)); $('#inspectorTab').classList.toggle('hidden', tab.dataset.tab !== 'inspector'); $('#compareTab').classList.toggle('hidden', tab.dataset.tab !== 'compare'); }));
const downloadManifest = () => { const blob = new Blob([exportManifest(documentState)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${documentState.id}-${documentState.revision.id}-edit-manifest.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); toast('Reproducible edit manifest exported'); };
$('#exportButton').addEventListener('click', downloadManifest); $('#manifestButton').addEventListener('click', downloadManifest);
$('#addLayerButton').addEventListener('click', () => { const id = `adjustment-${addedLayerNumber}`; addedLayerNumber += 1; documentState.layers.splice(1, 0, { id, name: 'New adjustment', type: 'adjustment', visible: true, opacity: 1, blendMode: 'Normal', assetId: null, params: {}, accent: 'cyan' }); selectedId = id; toast('Adjustment layer added'); render(); });

const previousRevision = clone(documentState);
previousRevision.revision = { id: 'rev-013', number: 13 };
previousRevision.layers.find((layer) => layer.id === 'grade').opacity = 1;
previousRevision.layers.find((layer) => layer.id === 'mountain').mask.enabled = false;
previousRevision.layers.splice(4, 0, previousRevision.layers.splice(3, 1)[0]);

render();
window.pipelineInspector = { document: documentState, validate: currentValidation, compare: () => compareRevisions(previousRevision, documentState), manifestSummary: () => summarizePipeline(documentState), exportManifest: downloadManifest, render };
