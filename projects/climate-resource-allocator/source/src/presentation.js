// Presentation vocabulary only. Planner IDs, ordering and calculations stay separate.
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const STATUS = freeze({
  reachable: { label: 'Reachable', tone: 'good', description: 'An open positive-capacity route connects this shelter to a depot before allocation.' },
  disconnected: { label: 'Disconnected', tone: 'warn', description: 'No open positive-capacity route connects this shelter to a depot.' },
  open: { label: 'Open road', tone: 'info', description: 'An open road with capacity, not used by this plan.' },
  allocated: { label: 'Allocated route', tone: 'good', description: 'A road used by at least one planned shipment.' },
  closed: { label: 'Closed', tone: 'warn', description: 'Excluded from routing, irrespective of nominal capacity.' },
  noCapacity: { label: 'No capacity', tone: 'warn', description: 'An open road with zero effective capacity.' },
  saturated: { label: 'Saturated', tone: 'warn', description: 'All effective road capacity is consumed by the plan.' },
  expired: { label: 'Expired', tone: 'warn', description: 'Inventory expiring at or before the synthetic snapshot is excluded.' },
  usable: { label: 'Usable', tone: 'good', description: 'Inventory that has not expired at the synthetic snapshot.' },
  met: { label: 'Met', tone: 'good', description: 'The attempted equity floor is met for every resource at this shelter.' },
  shortfall: { label: 'Shortfall', tone: 'warn', description: 'At least one resource is below the attempted equity floor.' },
  disabled: { label: 'Disabled', tone: 'info', description: 'A zero equity floor requests no minimum resource share.' },
  full: { label: 'Full coverage', tone: 'good', description: 'All requested resource demand is allocated.' },
  partial: { label: 'Partial coverage', tone: 'warn', description: 'Some, but not all, requested demand is allocated.' },
  none: { label: 'No allocation', tone: 'warn', description: 'No requested resources are allocated.' },
  critical: { label: 'Critical', tone: 'warn', description: 'Highest priority in the priority fill after the equity-first phase; fill before High and Moderate.' },
  high: { label: 'High', tone: 'info', description: 'Second priority in the priority fill after the equity-first phase; fill before Moderate.' },
  moderate: { label: 'Moderate', tone: 'info', description: 'Later priority in the priority fill after the equity-first phase and higher priority needs.' },
});

export const EQUITY = freeze({
  floor: 'Equity floor', phase: 'Equity-first phase',
  hint: 'Minimum share attempted per shelter and resource',
  disabled: 'Equity-first targets are disabled. No minimum share is requested.',
  footnote: 'Equity is attempted by the planner and is not guaranteed. A 0% floor is Disabled.',
  explanation: 'Allocated amounts are final-plan totals across both phases.',
});

export const PRIORITY = freeze({ critical: 'Critical', high: 'High', moderate: 'Moderate' });
export const PRIORITY_STYLE = freeze({
  critical: { rank: 1, foreground: '--priority-critical-fg', background: '--priority-critical-bg' },
  high: { rank: 2, foreground: '--priority-high-fg', background: '--priority-high-bg' },
  moderate: { rank: 3, foreground: '--priority-moderate-fg', background: '--priority-moderate-bg' },
});
export const PHASE = freeze({ equity: EQUITY.phase, priority: 'Priority fill' });
export const REPORT = freeze({
  title: 'Allocation report', navigation: 'Report sections',
  introduction: 'Resource-level outcomes from the deterministic plan. Quantities are displayed to at most two decimal places; aggregate units are abstract planning units.',
  sections: [
    { id: 'shelters', title: 'Shelter allocations' },
    { id: 'unmet', title: 'Unmet demand' },
    { id: 'bottlenecks', title: 'Route bottlenecks' },
    { id: 'expired', title: 'Expired supplies' },
    { id: 'equity', title: 'Equity indicators' },
  ],
  captions: { shelters: 'Shelter allocation by resource', unmet: 'Unmet demand by shelter and resource', bottlenecks: 'Open route bottlenecks', closed: 'Closed roads excluded from routing', expired: 'Expired inventory excluded from the plan', equity: 'Equity floor by shelter and resource' },
  empty: { shelters: 'No shelters', unmet: 'No unmet demand', bottlenecks: 'No saturated open roads', closed: 'No closed roads', expired: 'No expired supplies', resources: 'No resources', shipments: 'No shipments are feasible under these controls.' },
  columns: {
    shelter: 'Shelter', priority: 'Priority', population: 'Population', access: 'Access', coverage: 'Coverage', resource: 'Resource / unit', demand: 'Demand', allocated: 'Allocated', unmet: 'Unmet', road: 'Road', used: 'Used (shared units)', remaining: 'Remaining (shared units)', capacity: 'Effective capacity (shared units)', minutes: 'Travel time', status: 'Status', reason: 'Reason', lot: 'Lot', depot: 'Depot', original: 'Original quantity', excluded: 'Excluded quantity', expires: 'Expires at (UTC)', vulnerability: 'Vulnerability', floorStatus: 'Floor status', target: 'Target', shortfall: 'Shortfall',
  },
  units: 'units',
  numericColumns: ['population', 'coverage', 'demand', 'allocated', 'unmet', 'used', 'remaining', 'capacity', 'minutes', 'original', 'excluded', 'vulnerability', 'target', 'shortfall'],
  capacityNote: 'All resources share road capacity. Effective capacity includes the current what-if scale. Closed roads are shown separately.',
  closedHeading: 'Closed roads', unknownDate: 'Unknown date',
});

export const COPY = freeze({
  brandMark: 'CR', brandLines: ['CLIMATE', 'RESPONSE'], brandSubtitle: 'RESOURCE ALLOCATOR', primaryNavigation: 'Primary',
  dashboardTitle: 'Resource allocation overview', snapshot: 'PLANNING SNAPSHOT',
  overview: 'Overview', weather: 'Weather alerts', localMode: 'LOCAL MODE', noDispatch: 'No live dispatch',
  prototype: 'Prototype planning mode', disclaimer: 'All data is synthetic. This deterministic plan supports tabletop analysis — it is not an emergency dispatch system.', localData: 'LOCAL DATA ONLY',
  totalCoverage: 'Total coverage', unmet: REPORT.sections[1].title, bottlenecks: REPORT.sections[2].title,
  usableInventory: 'Usable inventory', planCoverage: 'Plan coverage',
  networkModel: 'NETWORK MODEL', networkTitle: 'Supply routes & shelter access', mapDescription: 'Synthetic road network showing allocation routes and shelter coverage',
  controlsKicker: 'SCENARIO CONTROLS', controlsTitle: 'What-if capacity', controlsIntro: 'Adjust inventory, shared road capacity, or the attempted equity floor to recalculate the deterministic plan.',
  inventoryControl: 'Inventory available', inventoryHint: 'Scale synthetic stock; expired lots remain excluded', roadControl: 'Road capacity', roadHint: 'Scale shared road capacity',
  routePolicy: 'Route policy', shortest: 'Shortest feasible', priorityOrder: 'Priority order', reset: 'Reset to baseline',
  ledgerKicker: 'SHIPMENT LEDGER', ledgerTitle: 'Every planned movement', deterministic: 'Deterministic output',
  inventoryKicker: 'SUPPLY INVENTORY', inventoryTitle: 'Lot-level accounting', expiryAware: 'Expiry-aware',
  weatherKicker: 'SITUATION INPUTS', syntheticFeed: 'Synthetic feed', auditKicker: 'AUDIT TRAIL', auditTitle: 'How this plan was formed',
  sharedCapacity: 'Shared capacity model', roads: 'roads', minutes: 'min', direct: 'direct', asOf: 'As of', utc: 'UTC',
  ledgerHeaders: ['Resource', 'Destination', 'From', 'Units', 'Route / time', 'Phase'],
});

export const LEGEND = freeze({
  routes: { title: 'Route legend', keys: ['allocated', 'open', 'saturated', 'noCapacity', 'closed'] },
  shelters: { title: 'Shelter coverage legend', keys: ['full', 'partial', 'none'] },
  report: { title: 'Status legend', keys: ['reachable', 'disconnected', 'expired', 'met', 'shortfall', 'disabled'] },
  priority: { title: 'Priority legend', keys: ['critical', 'high', 'moderate'] },
});

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
export const formatNumber = (value) => formatter.format(value);
export const formatPercent = (value) => `${formatNumber(value * 100)}%`;
export const formatUtc = (value) => `${new Date(value).toISOString()} ${COPY.utc}`;
export const equityStatus = (floor, met) => floor === 0 ? 'disabled' : met ? 'met' : 'shortfall';
export const coverageStatus = (coverage) => coverage >= 1 ? 'full' : coverage > 0 ? 'partial' : 'none';
export const roadStatus = (road) => road.closed ? 'closed' : road.capacity === 0 ? 'noCapacity' : road.remaining === 0 ? 'saturated' : road.used > 0 ? 'allocated' : 'open';

export function statusBadge(key) {
  const status = STATUS[key];
  return `<span class="report-status report-status-${status.tone}" data-status="${key}" title="${escapeHtml(status.description)}">${escapeHtml(status.label)}</span>`;
}

export function priorityBadge(key) {
  const style = PRIORITY_STYLE[key];
  return `<span class="priority ${key}" data-priority="${key}" title="${escapeHtml(STATUS[key].description)}"><span class="priority-rank" aria-hidden="true">${style.rank}</span>${escapeHtml(PRIORITY[key])}</span>`;
}

export function renderLegend(kind) {
  const legend = LEGEND[kind];
  const isPriority = kind === 'priority';
  return `<section class="status-legend${isPriority ? ' priority-legend' : ''}" data-legend="${kind}" aria-label="${escapeHtml(legend.title)}"><h3>${escapeHtml(legend.title)}</h3><ul>${legend.keys.map((key) => `<li data-legend-status="${key}">${isPriority ? `<i class="legend-swatch legend-priority-${key}" aria-hidden="true"></i>${priorityBadge(key)}<span><strong>${escapeHtml(STATUS[key].label)}</strong><small>${escapeHtml(STATUS[key].description)}</small></span>` : `<i class="legend-swatch legend-${key}" aria-hidden="true"></i><span><strong>${escapeHtml(STATUS[key].label)}</strong><small>${escapeHtml(STATUS[key].description)}</small></span>`}</li>`).join('')}</ul></section>`;
}

// Dynamic copy is kept here as well, instead of in dashboard/report templates.
const count = (n, singular, plural = `${singular}s`) => `${formatNumber(n)} ${n === 1 ? singular : plural}`;
export const wording = freeze({
  shelters: (n) => count(n, 'shelter'),
  unmetUnits: (n) => count(n, 'unmet unit'),
  unmetShelters: (n) => `${count(n, 'shelter')} with unmet demand`,
  resourceShortfalls: (n) => count(n, 'resource shortfall'),
  capacityIssues: (n) => count(n, 'open capacity issue'),
  lotsExcluded: (n) => `${count(n, 'lot')} excluded`,
  scaledExcluded: (n) => `${count(n, 'scaled unit')} excluded`,
  floor: (value) => value === 0 ? `0% floor — ${STATUS.disabled.label}` : `${formatPercent(value)} floor`,
  met: (n) => `${formatNumber(n)} met`, shortfalls: (n) => count(n, 'shortfall'),
  equitySummary: (met, total) => `${formatNumber(met)} of ${count(total, 'shelter')} met the attempted equity floor for every resource. ${EQUITY.explanation}`,
  saturation: (fraction) => `${formatPercent(fraction)} saturated`,
  expiredExcluded: (n) => `${count(n, 'unit')} excluded as expired`,
  requestedShare: (share) => `${formatPercent(share)} of requested resources`,
  shipments: (n) => count(n, 'shipment'), decisions: (n) => count(n, 'decision'),
  remainingStock: (remaining, available) => `${formatNumber(remaining)} remaining of ${formatNumber(available)}`,
  perResource: (floor) => floor === 0 ? STATUS.disabled.label : `${formatPercent(floor)} per resource`,
  roadUsage: (used, capacity) => `${formatNumber(used)} / ${formatNumber(capacity)} shared units used`,
  openRoads: (n) => count(n, 'open road'),
  priorityOrder: () => [PRIORITY.critical, PRIORITY.high, PRIORITY.moderate].join(' → '),
});
