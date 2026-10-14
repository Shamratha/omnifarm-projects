import {
  REPORT, EQUITY, STATUS, PRIORITY, COPY, wording,
  formatNumber, formatPercent, escapeHtml, statusBadge, priorityBadge, equityStatus, renderLegend,
} from './presentation.js';

const compareId = (a, b) => {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
};

function number(value) {
  return formatNumber(Number.isFinite(value) ? value : 0);
}

function percent(value) {
  return formatPercent(Number.isFinite(value * 100) ? value : 0);
}

function valueOr(value, fallback = '') {
  return value === undefined || value === null ? fallback : value;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function resourceById(scenario) {
  return new Map((scenario.resources || []).map((resource) => [resource.id, resource]));
}

function nodeById(scenario) {
  return new Map((scenario.nodes || []).map((node) => [node.id, node]));
}

function resourceRows(scenario, shelter) {
  const resources = scenario.resources || [];
  return resources.map((resource) => {
    const demand = valueOr(shelter.demand?.[resource.id], 0);
    const allocated = valueOr(shelter.allocated?.[resource.id], 0);
    const unmet = valueOr(shelter.unmet?.[resource.id], Math.max(0, demand - allocated));
    return {
      id: resource.id,
      name: valueOr(resource.name, resource.id),
      unit: valueOr(resource.unit, REPORT.units),
      demand,
      allocated,
      unmet,
    };
  });
}

function shelterRow(scenario, shelter) {
  const resources = resourceRows(scenario, shelter);
  return {
    id: shelter.id,
    name: valueOr(shelter.name, shelter.id),
    priority: valueOr(shelter.priority),
    population: valueOr(shelter.population, 0),
    reachable: Boolean(shelter.reachable),
    coverage: valueOr(shelter.coverage, 0),
    resources,
    totalAllocated: sum(resources.map((resource) => resource.allocated)),
    totalUnmet: sum(resources.map((resource) => resource.unmet)),
  };
}

function bottleneckSeverity(road) {
  // Zero-capacity roads cannot carry anything; exhausted positive capacity follows.
  const capacity = Number(road.capacity);
  if (capacity === 0) return 0;
  if (Number.isFinite(capacity) && capacity > 0) {
    const utilization = Number(road.used) / capacity;
    return utilization >= 1 ? 1 : 2;
  }
  return 2;
}

function compareBottlenecks(a, b) {
  return bottleneckSeverity(a) - bottleneckSeverity(b) || compareId(a.id, b.id);
}

function expiredAtOrBefore(lot, asOf) {
  const expires = Date.parse(lot.expiresAt);
  const snapshot = Date.parse(asOf);
  return Number.isFinite(expires) && Number.isFinite(snapshot) && expires <= snapshot;
}

/**
 * Create a presentation-only report from a scenario and an existing plan.
 * The scenario and plan are treated as immutable inputs.
 */
export function buildReport(scenario, plan, options = {}) {
  const inventoryScale = options?.inventoryScale ?? 1;
  const equityFloor = options?.equityFloor ?? 0.4;
  const resources = resourceById(scenario);
  const nodes = nodeById(scenario);
  const planShelters = (plan?.shelters || []).map((shelter) => shelterRow(scenario, shelter));
  const shelters = planShelters.sort((a, b) => compareId(a.id, b.id));
  const unmet = shelters.filter((shelter) => shelter.totalUnmet > 0).map((shelter) => ({
    ...shelter,
    resources: shelter.resources.map((resource) => ({ ...resource })),
  }));

  const bottlenecks = (plan?.bottlenecks || [])
    .filter((road) => !road.closed)
    .map((road) => ({ ...road }))
    .sort(compareBottlenecks);

  const expired = (plan?.inventory ?? scenario.inventory ?? [])
    .filter((lot) => lot.expired ?? expiredAtOrBefore(lot, scenario.asOf))
    .map((lot) => ({
      ...lot,
      excludedQuantity: lot.quantity * inventoryScale,
      depotName: valueOr(nodes.get(lot.depotId)?.name, lot.depotId),
      resourceName: valueOr(resources.get(lot.resource)?.name, lot.resource),
      unit: valueOr(resources.get(lot.resource)?.unit, REPORT.units),
    }))
    .sort((a, b) => compareId(a.id, b.id));

  const equityShelters = (plan?.shelters || []).map((shelter) => {
    const resourceDetails = resourceRows(scenario, shelter).map((resource) => {
      const target = resource.demand * equityFloor;
      return {
        id: resource.id,
        name: resource.name,
        unit: resource.unit,
        target,
        allocated: resource.allocated,
        shortfall: Math.max(0, target - resource.allocated),
      };
    });
    return {
      id: shelter.id,
      name: valueOr(shelter.name, shelter.id),
      vulnerability: valueOr(shelter.vulnerability, 0),
      met: shelter.equityMet,
      resources: resourceDetails,
    };
  }).sort((a, b) => compareId(a.id, b.id));

  return {
    shelters,
    unmet,
    bottlenecks,
    expired,
    equity: {
      floor: equityFloor,
      metCount: equityShelters.filter((shelter) => shelter.met).length,
      shortfallCount: equityShelters.filter((shelter) => !shelter.met).length,
      shelters: equityShelters,
    },
  };
}

function utcDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? valueOr(value, REPORT.unknownDate) : date.toISOString();
}

function toneBadge(text, kind = '') {
  const className = kind ? ` report-status-${escapeHtml(kind)}` : '';
  return `<span class="report-status${className}">${escapeHtml(text)}</span>`;
}

function tableShell(caption, content, columnKeys) {
  return `<div class="report-table-scroll"><table class="report-table"><caption>${escapeHtml(caption)}</caption><thead><tr>${columnKeys.map((key) => `<th scope="col"${REPORT.numericColumns.includes(key) ? ' class="report-number"' : ''}>${escapeHtml(REPORT.columns[key])}</th>`).join('')}</tr></thead><tbody>${content}</tbody></table></div>`;
}

function emptyRow(columns, message) {
  return `<tr><td colspan="${columns}" class="report-empty">${escapeHtml(message)}</td></tr>`;
}

function shelterTable(report) {
  const rows = report.shelters.flatMap((shelter) => (shelter.resources.length ? shelter.resources : [null]).map((resource) => `<tr>
    <th scope="row">${escapeHtml(shelter.name)} <span class="report-id">(${escapeHtml(shelter.id)})</span></th>
     <td>${Object.hasOwn(PRIORITY, shelter.priority) ? priorityBadge(shelter.priority) : escapeHtml(shelter.priority)}</td>
    <td class="report-number">${number(shelter.population)}</td>
    <td>${statusBadge(shelter.reachable ? 'reachable' : 'disconnected')}</td>
    <td class="report-number">${escapeHtml(percent(shelter.coverage))}</td>
    <td>${resource ? `${escapeHtml(resource.name)} <span class="report-unit">(${escapeHtml(resource.unit)})</span>` : escapeHtml(REPORT.empty.resources)}</td>
    <td class="report-number">${number(resource?.demand ?? 0)}</td>
    <td class="report-number">${number(resource?.allocated ?? 0)}</td>
    <td class="report-number">${number(resource?.unmet ?? 0)}</td>
  </tr>`));
  return tableShell(
    REPORT.captions.shelters,
    rows.length ? rows.join('') : emptyRow(9, REPORT.empty.shelters),
    ['shelter', 'priority', 'population', 'access', 'coverage', 'resource', 'demand', 'allocated', 'unmet'],
  );
}

function unmetTable(report) {
  const rows = report.unmet.flatMap((shelter) => shelter.resources
    .filter((resource) => resource.unmet > 0)
    .map((resource) => `<tr>
      <th scope="row">${escapeHtml(shelter.name)} <span class="report-id">(${escapeHtml(shelter.id)})</span></th>
      <td>${statusBadge(shelter.reachable ? 'reachable' : 'disconnected')}</td>
      <td>${escapeHtml(resource.name)} <span class="report-unit">(${escapeHtml(resource.unit)})</span></td>
      <td class="report-number">${number(resource.demand)}</td>
      <td class="report-number">${number(resource.allocated)}</td>
      <td class="report-number">${number(resource.unmet)}</td>
    </tr>`));
  return tableShell(
    REPORT.captions.unmet,
    rows.length ? rows.join('') : emptyRow(6, REPORT.empty.unmet),
    ['shelter', 'access', 'resource', 'demand', 'allocated', 'unmet'],
  );
}

function bottleneckTable(report) {
  const rows = report.bottlenecks.map((road) => {
    const saturation = road.capacity === 0
      ? statusBadge('noCapacity')
      : `${statusBadge('saturated')} ${escapeHtml(wording.saturation(road.used / road.capacity))}`;
    return `<tr>
      <th scope="row">${escapeHtml(valueOr(road.name, road.id))} <span class="report-id">(${escapeHtml(road.id)})</span></th>
      <td class="report-number">${number(road.used)}</td>
      <td class="report-number">${number(road.remaining)}</td>
      <td class="report-number">${number(road.capacity)}</td>
      <td class="report-number">${number(road.minutes)} ${escapeHtml(COPY.minutes)}</td>
      <td>${saturation}</td>
    </tr>`;
  });
  return tableShell(
    REPORT.captions.bottlenecks,
    rows.length ? rows.join('') : emptyRow(6, REPORT.empty.bottlenecks),
    ['road', 'used', 'remaining', 'capacity', 'minutes', 'status'],
  );
}

function closedRoadTable(plan) {
  const rows = (plan?.roads || []).filter((road) => road.closed).sort((a, b) => compareId(a.id, b.id)).map((road) => `<tr>
    <th scope="row">${escapeHtml(valueOr(road.name, road.id))} <span class="report-id">(${escapeHtml(road.id)})</span></th>
    <td>${escapeHtml(valueOr(road.reason, STATUS.closed.label))}</td>
    <td class="report-number">${number(road.minutes)} ${escapeHtml(COPY.minutes)}</td>
    <td>${statusBadge('closed')}</td>
  </tr>`);
  return tableShell(
    REPORT.captions.closed,
    rows.length ? rows.join('') : emptyRow(4, REPORT.empty.closed),
    ['road', 'reason', 'minutes', 'status'],
  );
}

function expiredTable(report) {
  const rows = report.expired.map((lot) => `<tr>
    <th scope="row">${escapeHtml(lot.id)} ${statusBadge('expired')}</th>
    <td>${escapeHtml(lot.resourceName)} <span class="report-unit">(${escapeHtml(lot.unit)})</span></td>
    <td>${escapeHtml(lot.depotName)} <span class="report-id">(${escapeHtml(lot.depotId)})</span></td>
    <td class="report-number">${number(lot.quantity)}</td>
    <td class="report-number">${number(lot.excludedQuantity)}</td>
    <td>${escapeHtml(utcDate(lot.expiresAt))} ${escapeHtml(COPY.utc)}</td>
  </tr>`);
  return tableShell(
    REPORT.captions.expired,
    rows.length ? rows.join('') : emptyRow(6, REPORT.empty.expired),
    ['lot', 'resource', 'depot', 'original', 'excluded', 'expires'],
  );
}

function equityTable(report) {
  const rows = report.equity.shelters.flatMap((shelter) => (shelter.resources.length ? shelter.resources : [null]).map((resource) => `<tr>
    <th scope="row">${escapeHtml(shelter.name)} <span class="report-id">(${escapeHtml(shelter.id)})</span></th>
    <td class="report-number">${escapeHtml(percent(shelter.vulnerability))}</td>
    <td>${statusBadge(equityStatus(report.equity.floor, shelter.met))}</td>
    <td>${resource ? `${escapeHtml(resource.name)} <span class="report-unit">(${escapeHtml(resource.unit)})</span>` : escapeHtml(REPORT.empty.resources)}</td>
    <td class="report-number">${number(resource?.target ?? 0)}</td>
    <td class="report-number">${number(resource?.allocated ?? 0)}</td>
    <td class="report-number">${number(resource?.shortfall ?? 0)}</td>
  </tr>`));
  return tableShell(
    REPORT.captions.equity,
    rows.length ? rows.join('') : emptyRow(7, REPORT.empty.shelters),
    ['shelter', 'vulnerability', 'floorStatus', 'resource', 'target', 'allocated', 'shortfall'],
  );
}

/** Render the report as standalone HTML for insertion by the parent application. */
export function renderReport(scenario, plan, options = {}) {
  const report = buildReport(scenario, plan, options);
  const floor = report.equity.floor;
  const sectionTitle = (id) => escapeHtml(REPORT.sections.find((section) => section.id === id).title);
  const unmetResourceCount = report.unmet.reduce(
    (total, shelter) => total + shelter.resources.filter((resource) => resource.unmet > 0).length,
    0,
  );
  const unmetQuantity = sum(report.unmet.map((shelter) => shelter.totalUnmet));

  return `<section id="plan" class="allocator-report" aria-labelledby="report-title">
  <header class="report-header">
    <h2 id="report-title">${escapeHtml(REPORT.title)}</h2>
    <p>${escapeHtml(REPORT.introduction)}</p>
  </header>
  ${renderLegend('report')}
  ${renderLegend('priority')}
  <nav class="report-tabs" aria-label="${escapeHtml(REPORT.navigation)}">
    ${REPORT.sections.map((section) => `<a class="report-tab" href="#report-${escapeHtml(section.id)}">${escapeHtml(section.title)}</a>`).join('\n    ')}
  </nav>

  <section id="report-shelters" class="report-section" aria-labelledby="report-shelters-title">
    <div class="report-section-heading"><h3 id="report-shelters-title">${sectionTitle('shelters')}</h3>${toneBadge(wording.shelters(report.shelters.length), 'info')}</div>
    ${shelterTable(report)}
  </section>

  <section id="report-unmet" class="report-section" aria-labelledby="report-unmet-title">
    <div class="report-section-heading"><h3 id="report-unmet-title">${sectionTitle('unmet')}</h3>${toneBadge(wording.unmetUnits(unmetQuantity), unmetQuantity ? 'warn' : 'good')}</div>
    <p class="report-summary">${toneBadge(wording.unmetShelters(report.unmet.length), report.unmet.length ? 'warn' : 'good')} ${toneBadge(wording.resourceShortfalls(unmetResourceCount), unmetResourceCount ? 'warn' : 'good')}</p>
    ${unmetTable(report)}
  </section>

  <section id="report-bottlenecks" class="report-section" aria-labelledby="report-bottlenecks-title">
    <div class="report-section-heading"><h3 id="report-bottlenecks-title">${sectionTitle('bottlenecks')}</h3>${toneBadge(wording.capacityIssues(report.bottlenecks.length), report.bottlenecks.length ? 'warn' : 'good')}</div>
    <p class="report-equity-summary">${escapeHtml(REPORT.capacityNote)}</p>
    ${bottleneckTable(report)}
    <h4>${escapeHtml(REPORT.closedHeading)}</h4>
    ${closedRoadTable(plan)}
  </section>

  <section id="report-expired" class="report-section" aria-labelledby="report-expired-title">
    <div class="report-section-heading"><h3 id="report-expired-title">${sectionTitle('expired')}</h3>${toneBadge(wording.lotsExcluded(report.expired.length), report.expired.length ? 'warn' : 'good')}</div>
    <p class="report-summary">${toneBadge(wording.scaledExcluded(sum(report.expired.map((lot) => lot.excludedQuantity))), 'info')}</p>
    ${expiredTable(report)}
  </section>

  <section id="report-equity" class="report-section" aria-labelledby="report-equity-title">
    <div class="report-section-heading"><h3 id="report-equity-title">${sectionTitle('equity')}</h3>${toneBadge(wording.floor(floor), 'info')}</div>
    ${floor === 0 ? `<p class="report-equity-summary">${escapeHtml(EQUITY.disabled)}</p>` : `<p class="report-summary">${toneBadge(wording.met(report.equity.metCount), 'good')} ${toneBadge(wording.shortfalls(report.equity.shortfallCount), report.equity.shortfallCount ? 'warn' : 'good')}</p>
    <p class="report-equity-summary">${escapeHtml(wording.equitySummary(report.equity.metCount, report.equity.shelters.length))}</p>`}
    ${equityTable(report)}
    <footer class="report-footnote">${escapeHtml(EQUITY.footnote)}</footer>
  </section>
</section>`;
}
