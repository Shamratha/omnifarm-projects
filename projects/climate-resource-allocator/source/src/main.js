import { scenario } from './data.js';
import { allocate } from './planner.js';
import { renderReport } from './report.js';
import { COPY, EQUITY, REPORT, PRIORITY, PHASE, STATUS, wording, escapeHtml as esc,
  formatNumber as number, formatPercent as percent, formatUtc, roadStatus,
  coverageStatus, renderLegend } from './presentation.js';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import './tokens.css';
import './styles.css';
import './report.css';

const baseline = { inventoryScale: 1, roadCapacityScale: 1, equityFloor: 0.4 };
const state = { ...baseline };
const app = document.querySelector('#app');
const getResource = (id) => scenario.resources.find((resource) => resource.id === id);
const getShelter = (id) => scenario.shelters.find((shelter) => shelter.id === id);
const getNode = (id) => scenario.nodes.find((node) => node.id === id);

function icon(name) {
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    sliders: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2"/>',
    alert: '<path d="M10.3 3.4 2.1 18a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3L13.7 3.4a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="17" r=".7"/>',
    route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h2a4 4 0 0 0 4-4V10a4 4 0 0 1 4-4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function heading(kicker, title, annotation = '') {
  return `<div class="panel-heading"><div><div class="section-kicker">${esc(kicker)}</div><h2>${esc(title)}</h2></div>${annotation}</div>`;
}

function renderShell() {
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">${esc(COPY.brandMark)}</div><div><strong>${COPY.brandLines.map(esc).join('<br>')}</strong><span>${esc(COPY.brandSubtitle)}</span></div></div>
      <div class="side-rule"></div>
      <nav class="nav" aria-label="${esc(COPY.primaryNavigation)}">
        <a class="nav-item active" href="#overview">${icon('grid')}<span>${esc(COPY.overview)}</span></a>
        <a class="nav-item" href="#plan">${icon('route')}<span>${esc(REPORT.title)}</span></a>
        <a class="nav-item" href="#alerts">${icon('alert')}<span>${esc(COPY.weather)} <b>${scenario.alerts.length}</b></span></a>
      </nav>
      <div class="sidebar-foot"><span class="status-dot"></span><span>${esc(COPY.localMode)}</span><small>${esc(COPY.noDispatch)}</small></div>
    </aside>
    <main class="main-content">
      <header class="topbar"><div><div class="eyebrow">${esc(scenario.region)} / ${esc(COPY.snapshot)}</div><h1>${esc(COPY.dashboardTitle)}</h1></div><div class="snapshot"><span class="live-dot"></span><span>${esc(COPY.asOf)} ${esc(formatUtc(scenario.asOf))}</span></div></header>
      <section id="overview" class="notice"><div class="notice-icon">${icon('alert')}</div><div><strong>${esc(COPY.prototype)}</strong><p>${esc(COPY.disclaimer)}</p></div><span class="notice-tag">${esc(COPY.localData)}</span></section>
      <div id="dashboard"></div>
    </main>
  </div>`;
}

function metric(label, value, unit, note, accent = false, progress = null) {
  return `<article class="metric-card${accent ? ' accent' : ''}"><div class="metric-label">${esc(label.toUpperCase())}</div><div class="metric-value">${esc(value)}${unit ? ` <small>${esc(unit)}</small>` : ''}</div><div class="metric-note muted">${note}</div>${progress === null ? '' : `<div class="progress"><span style="width:${progress * 100}%"></span></div>`}</article>`;
}

function renderMetrics(plan) {
  return `<section class="metric-grid">
    ${metric(COPY.totalCoverage, percent(plan.totals.coverage), '', `<span class="trend">${icon('check')}${esc(COPY.planCoverage)}</span> ${number(plan.totals.allocated)} / ${number(plan.totals.demand)} ${esc(REPORT.units)}`, true, plan.totals.coverage)}
    ${metric(COPY.unmet, number(plan.totals.unmet), REPORT.units, esc(wording.requestedShare(1 - plan.totals.coverage)))}
    ${metric(COPY.bottlenecks, number(plan.bottlenecks.length), COPY.roads, esc(plan.bottlenecks.length ? plan.bottlenecks.map((road) => road.name).join(' + ') : REPORT.empty.bottlenecks))}
    ${metric(COPY.usableInventory, number(plan.totals.available), REPORT.units, esc(wording.expiredExcluded(plan.totals.expired)))}
  </section>`;
}

function renderSlider(key, label, hint) {
  const isEquity = key === 'equityFloor';
  return `<label class="slider-control" for="${key}"><span class="slider-label"><strong>${esc(label)}</strong><output for="${key}">${isEquity ? percent(state[key]) : `${state[key].toFixed(1)}x`}</output></span><input id="${key}" aria-describedby="${key}-hint" type="range" min="0" max="${isEquity ? 1 : 2}" step="0.1" value="${state[key]}"><span class="slider-hint" id="${key}-hint">${esc(hint)}</span></label>`;
}

function renderControls() {
  return `<aside class="panel controls-panel">
    ${heading(COPY.controlsKicker, COPY.controlsTitle, icon('sliders'))}
    <p class="panel-intro">${esc(COPY.controlsIntro)}</p>
    ${renderSlider('inventoryScale', COPY.inventoryControl, COPY.inventoryHint)}
    ${renderSlider('roadCapacityScale', COPY.roadControl, COPY.roadHint)}
    ${renderSlider('equityFloor', EQUITY.floor, EQUITY.hint)}
    <div class="control-summary"><div><span>${esc(EQUITY.phase)}</span><strong>${esc(wording.perResource(state.equityFloor))}</strong></div><div><span>${esc(COPY.routePolicy)}</span><strong>${esc(COPY.shortest)}</strong></div><div><span>${esc(COPY.priorityOrder)}</span><strong>${esc(wording.priorityOrder())}</strong></div></div>
    <button class="reset-button" id="reset-controls">${esc(COPY.reset)}</button>
  </aside>`;
}

function renderMap(plan) {
  const roadSvg = plan.roads.map((road) => {
    const from = getNode(road.from); const to = getNode(road.to);
    const key = roadStatus(road);
    const description = `${road.name} · ${STATUS[key].label} · ${wording.roadUsage(road.used, road.capacity)} · ${road.minutes} ${COPY.minutes}`;
    return `<g><title>${esc(description)}</title><line class="road ${key}" data-road-id="${esc(road.id)}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/></g>`;
  }).join('');
  const nodeSvg = scenario.nodes.map((node) => {
    if (node.type === 'junction') return `<circle class="junction" cx="${node.x}" cy="${node.y}" r="1.6"/>`;
    if (node.type === 'depot') return `<g class="map-node depot" transform="translate(${node.x} ${node.y})"><title>${esc(node.name)}</title><rect x="-3" y="-3" width="6" height="6"/><text y="-7">${esc(node.name.split(' ')[0])}</text></g>`;
    const shelter = plan.shelters.find((item) => item.nodeId === node.id);
    const key = coverageStatus(shelter.coverage);
    const shape = key === 'full' ? '<circle r="3.2"/>' : key === 'partial' ? '<polygon points="0,-3.8 3.8,0 0,3.8 -3.8,0"/>' : '<rect x="-3" y="-3" width="6" height="6"/>';
    const description = `${shelter.name} · ${STATUS[key].label} · ${percent(shelter.coverage)} · ${STATUS[shelter.reachable ? 'reachable' : 'disconnected'].label}`;
    return `<g class="map-node shelter ${key}" transform="translate(${node.x} ${node.y})"><title>${esc(description)}</title>${shape}<text y="-6">${esc(shelter.name.split(' ')[0])}</text><text class="map-percent" y="7">${percent(shelter.coverage)}</text></g>`;
  }).join('');
  const closed = plan.roads.find((road) => road.closed);
  return `<div class="map-wrap"><svg viewBox="0 0 100 100" role="img" aria-label="${esc(COPY.mapDescription)}">${roadSvg}${nodeSvg}</svg>${closed ? `<div class="map-callout"><span class="callout-line"></span><div><strong>${esc(closed.name)}</strong><small>${esc(STATUS.closed.label)}</small></div></div>` : ''}</div>`;
}

function renderNetwork(plan) {
  return `<article class="panel map-panel">${heading(COPY.networkModel, COPY.networkTitle)}${renderMap(plan)}<div class="map-foot"><span>${esc(wording.shelters(plan.shelters.length))}</span><span>${esc(wording.openRoads(plan.roads.filter((road) => !road.closed).length))}</span><span>${esc(COPY.sharedCapacity)}</span></div>${renderLegend('routes')}${renderLegend('shelters')}</article>`;
}

function renderLedger(plan) {
  const rows = plan.allocations.map((allocation) => `<tr>
    <td><strong class="resource-name">${esc(getResource(allocation.resource).name)}</strong></td>
    <td>${esc(getShelter(allocation.shelterId).name)}</td><td>${esc(getNode(allocation.depotId).name)}</td>
    <td>${number(allocation.quantity)}</td><td><span class="route-code">${esc(allocation.roadIds.join(' → ') || COPY.direct)} · ${number(allocation.minutes)} ${esc(COPY.minutes)}</span></td>
    <td><span class="phase phase-${esc(allocation.phase)}">${esc(PHASE[allocation.phase])}</span></td>
  </tr>`).join('');
  return `<article class="panel ledger-panel">${heading(COPY.ledgerKicker, COPY.ledgerTitle, `<span class="muted-label">${esc(COPY.deterministic)}</span>`)}<div class="table-wrap"><table><thead><tr>${COPY.ledgerHeaders.map((label) => `<th scope="col">${esc(label.toUpperCase())}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="6"><div class="empty-state">${esc(REPORT.empty.shipments)}</div></td></tr>`}</tbody></table></div></article>`;
}

function renderInventory(plan) {
  const rows = plan.inventory.map((lot) => `<div class="inventory-row ${lot.expired ? 'expired' : ''}">
    <div class="inventory-symbol" aria-hidden="true">${esc(lot.resource[0].toUpperCase())}</div>
    <div class="inventory-main"><div><strong>${esc(getResource(lot.resource).name)}</strong><span>${esc(lot.id)}</span></div>
      <div class="inventory-bar"><i style="width:${lot.available ? lot.allocated / lot.available * 100 : 0}%"></i></div>
      <small>${lot.expired ? `${esc(STATUS.expired.label)} ${esc(formatUtc(lot.expiresAt))}` : esc(wording.remainingStock(lot.remaining, lot.available))}</small>
    </div><strong class="inventory-qty">${lot.expired ? esc(STATUS.expired.label) : number(lot.allocated)}</strong>
  </div>`).join('');
  return `<article class="panel inventory-panel">${heading(COPY.inventoryKicker, COPY.inventoryTitle, `<span class="muted-label">${esc(COPY.expiryAware)}</span>`)}<div class="inventory-list">${rows}</div></article>`;
}

function renderAlerts() {
  const rows = scenario.alerts.map((alert) => `<article class="alert-card ${esc(alert.severity)}"><div class="alert-head"><span class="severity-dot" aria-hidden="true"></span><span class="alert-severity">${esc((PRIORITY[alert.severity] || alert.severity).toUpperCase())}</span><span class="alert-area">${esc(alert.area)}</span></div><h3>${esc(alert.title)}</h3><p>${esc(alert.description)}</p></article>`).join('');
  return `<section id="alerts" class="panel alerts-panel">${heading(COPY.weatherKicker, COPY.weather, `<span class="muted-label">${esc(COPY.syntheticFeed)}</span>`)}<div class="report-alert-grid">${rows}</div></section>`;
}

function renderAudit(plan) {
  const rows = plan.decisions.map((decision, index) => `<div class="decision"><span>${String(index + 1).padStart(2, '0')}</span><p>${esc(decision)}</p></div>`).join('');
  return `<section class="panel decisions-panel">${heading(COPY.auditKicker, COPY.auditTitle, `<span class="muted-label">${esc(wording.decisions(plan.decisions.length))}</span>`)}<div class="decision-list">${rows}</div></section>`;
}

function renderDashboard() {
  const plan = allocate(scenario, state);
  const dashboard = document.querySelector('#dashboard');
  const markup = `${renderMetrics(plan)}<section class="workspace-grid">${renderNetwork(plan)}${renderControls()}</section>${renderReport(scenario, plan, state)}<section class="ledger-grid">${renderLedger(plan)}${renderInventory(plan)}</section>${renderAlerts()}${renderAudit(plan)}`;
  // Leave the active controls mounted, preserving drag and keyboard focus.
  if (!dashboard.children.length) {
    dashboard.innerHTML = markup;
    Object.keys(state).forEach((key) => document.getElementById(key).addEventListener('input', (event) => {
      state[key] = Number(event.target.value);
      renderDashboard();
    }));
    document.getElementById('reset-controls').addEventListener('click', () => {
      Object.assign(state, baseline);
      renderDashboard();
    });
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = markup;
  const nextChildren = [...template.content.children];
  [...dashboard.children].forEach((current, index) => {
    const next = nextChildren[index];
    if (current.classList.contains('workspace-grid')) {
      current.querySelector('.map-panel').replaceWith(next.querySelector('.map-panel'));
      current.querySelector('.control-summary').innerHTML = next.querySelector('.control-summary').innerHTML;
    } else current.replaceWith(next);
  });
  Object.keys(state).forEach((key) => {
    document.getElementById(key).value = state[key];
    document.querySelector(`output[for="${key}"]`).textContent = key === 'equityFloor' ? percent(state[key]) : `${state[key].toFixed(1)}x`;
  });
}

renderShell();
renderDashboard();
