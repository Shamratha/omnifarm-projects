import assert from 'node:assert/strict';
import { scenario } from '../src/data.js';
import { allocate } from '../src/planner.js';
import { buildReport, renderReport } from '../src/report.js';
import { formatSampleSummary } from '../src/terminal-report.js';

const BASELINE_OPTIONS = Object.freeze({ inventoryScale: 1, roadCapacityScale: 1, equityFloor: 0.4 });
const EXPECTED_TOTALS = Object.freeze({
  demand: 4682,
  allocated: 3747,
  unmet: 935,
  expired: 335,
  available: 4880,
});
const RESOURCE_IDS = scenario.resources.map((resource) => resource.id);

function byId(items, id, label = 'item') {
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `expected ${label} ${id}`);
  return item;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function closeEnough(actual, expected, message) {
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(expected));
  assert.ok(Number.isFinite(actual), `${message}: expected a finite number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function assertFinite(value, path = 'value') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} must be finite`);
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => assertFinite(child, `${path}.${key}`));
  }
}

function assertBaseline(plan) {
  const actual = Object.fromEntries(Object.keys(EXPECTED_TOTALS).map((key) => [key, plan.totals[key]]));
  const differences = Object.fromEntries(Object.entries(EXPECTED_TOTALS)
    .filter(([key, expected]) => actual[key] !== expected)
    .map(([key, expected]) => [key, { expected, actual: actual[key] }]));
  assert.equal(Object.keys(differences).length, 0, `baseline differences: ${JSON.stringify(differences)}`);
}

function assertPlan(plan, options) {
  assertFinite(plan, 'plan');
  const { inventoryScale, roadCapacityScale, closedRoadIds = [] } = options;
  closeEnough(plan.totals.demand, plan.totals.allocated + plan.totals.unmet, 'demand ledger');
  closeEnough(sum(plan.allocations.map((allocation) => allocation.quantity)), plan.totals.allocated, 'shipment ledger');
  closeEnough(sum(plan.inventory.map((lot) => lot.available)), plan.totals.available, 'available inventory total');
  closeEnough(plan.totals.available, plan.totals.allocated + sum(plan.inventory.map((lot) => lot.remaining)), 'inventory total ledger');

  for (const lot of plan.inventory) {
    const source = byId(scenario.inventory, lot.id, 'input inventory');
    const expired = Date.parse(source.expiresAt) <= Date.parse(scenario.asOf);
    assert.equal(lot.expired, expired, `${lot.id} expiry state`);
    closeEnough(lot.available, expired ? 0 : source.quantity * inventoryScale, `${lot.id} usable inventory`);
    assert.ok(lot.allocated >= 0 && lot.remaining >= 0, `${lot.id} quantities must be non-negative`);
    closeEnough(lot.available, lot.allocated + lot.remaining, `inventory ledger ${lot.id}`);
  }

  for (const sourceShelter of scenario.shelters) {
    const shelter = byId(plan.shelters, sourceShelter.id, 'shelter');
    for (const resource of RESOURCE_IDS) {
      const demand = sourceShelter.demand?.[resource] ?? 0;
      const allocated = sum(plan.allocations
        .filter((allocation) => allocation.shelterId === shelter.id && allocation.resource === resource)
        .map((allocation) => allocation.quantity));
      closeEnough(shelter.allocated[resource], allocated, `${shelter.id}/${resource} allocation`);
      assert.ok(allocated >= 0 && shelter.unmet[resource] >= 0, `${shelter.id}/${resource} quantities must be non-negative`);
      closeEnough(allocated + shelter.unmet[resource], demand, `${shelter.id}/${resource} demand ledger`);
    }
    closeEnough(shelter.coverage, sum(Object.values(shelter.allocated)) / sum(Object.values(sourceShelter.demand)), `${shelter.id} coverage`);
  }

  for (const roadInput of scenario.roads) {
    const road = byId(plan.roads, roadInput.id, 'road');
    const used = sum(plan.allocations
      .filter((allocation) => allocation.roadIds.includes(road.id))
      .map((allocation) => allocation.quantity));
    const closed = Boolean(roadInput.closed || closedRoadIds.includes(road.id));
    closeEnough(road.capacity, roadInput.capacity * roadCapacityScale, `${road.id} effective capacity`);
    closeEnough(road.used, used, `road ledger ${road.id}`);
    assert.ok(road.used <= road.capacity, `${road.id} exceeds capacity`);
    assert.ok(road.remaining >= 0, `${road.id} has negative remaining capacity`);
    assert.equal(road.closed, closed, `${road.id} closed state`);
    if (closed) {
      assert.equal(road.used, 0, `${road.id} is closed but was traversed`);
      assert.equal(road.remaining, 0, `${road.id} is closed but has remaining capacity`);
    } else {
      closeEnough(road.used + road.remaining, road.capacity, `${road.id} capacity ledger`);
    }
  }

  for (const allocation of plan.allocations) {
    assert.ok(allocation.quantity > 0, 'shipments must have positive quantities');
    let currentNode = allocation.depotId;
    for (const roadId of allocation.roadIds) {
      const roadInput = byId(scenario.roads, roadId, 'input road');
      const road = byId(plan.roads, roadId, 'planned road');
      assert.equal(road.closed, false, `allocation traverses closed road ${roadId}`);
      assert.ok(roadInput.from === currentNode || roadInput.to === currentNode, `${roadId} breaks route continuity`);
      currentNode = roadInput.from === currentNode ? roadInput.to : roadInput.from;
    }
    assert.equal(currentNode, byId(scenario.shelters, allocation.shelterId, 'input shelter').nodeId);
  }
}

function assertReport(plan, report, html) {
  assertFinite(plan);
  assertFinite(report);
  assert.doesNotMatch(html, /NaN|Infinity/);

  for (const plannedShelter of plan.shelters) {
    const row = byId(report.shelters, plannedShelter.id, 'report shelter');
    closeEnough(row.totalAllocated, sum(Object.values(plannedShelter.allocated)), `${row.id} report allocation sum`);
    closeEnough(row.totalUnmet, sum(Object.values(plannedShelter.unmet)), `${row.id} report unmet sum`);
    for (const resource of RESOURCE_IDS) {
      const reportResource = byId(row.resources, resource, 'report resource');
      assert.equal(reportResource.allocated, plannedShelter.allocated[resource]);
      assert.equal(reportResource.unmet, plannedShelter.unmet[resource]);
      assert.equal(reportResource.demand, byId(scenario.shelters, plannedShelter.id, 'input shelter').demand[resource]);
    }
  }

  closeEnough(
    sum(report.shelters.map((shelter) => shelter.totalAllocated)),
    plan.totals.allocated,
    'report allocated total',
  );
  closeEnough(
    sum(report.shelters.map((shelter) => shelter.totalUnmet)),
    plan.totals.unmet,
    'report unmet total',
  );
  for (const resource of RESOURCE_IDS) {
    const reportAllocated = sum(report.shelters.map((shelter) => byId(shelter.resources, resource).allocated));
    const planAllocated = sum(plan.allocations
      .filter((allocation) => allocation.resource === resource)
      .map((allocation) => allocation.quantity));
    closeEnough(reportAllocated, planAllocated, `${resource} report resource total`);
  }

  const expired = report.expired;
  assert.equal(expired.length, scenario.inventory.filter((lot) => Date.parse(lot.expiresAt) <= Date.parse(scenario.asOf)).length);
  closeEnough(sum(expired.map((lot) => lot.excludedQuantity)), plan.totals.expired, 'report expiry total');
  assert.equal(report.bottlenecks.length, plan.bottlenecks.length);
  assert.equal(report.equity.metCount, plan.shelters.filter((shelter) => shelter.equityMet).length);
  assert.equal(report.equity.shortfallCount, plan.shelters.filter((shelter) => !shelter.equityMet).length);

  const expectedSections = [
    'report-shelters', 'report-unmet', 'report-bottlenecks', 'report-expired', 'report-equity',
  ];
  const sections = [...html.matchAll(/<section\s+id=["'](report-[^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(sections, expectedSections, 'report must contain the five named sections in order');
  for (const title of ['Shelter allocations', 'Unmet demand', 'Route bottlenecks', 'Expired supplies', 'Equity indicators']) {
    assert.match(html, new RegExp(`<h3[^>]*>${title}</h3>`), `report is missing readable section title ${title}`);
  }

  assert.match(html, /data-legend=["']report["']/, 'report must include its status legend');
  for (const status of ['reachable', 'disconnected', 'expired', 'met', 'shortfall', 'disabled']) {
    assert.match(html, new RegExp(`data-legend-status=["']${status}["']`), `status legend must explain ${status}`);
  }
  const priorityLegend = html.match(/<(section|div|aside)\b[^>]*(?:data-legend=["'][^"']*priorit[^"']*["']|aria-label=["'][^"']*priority[^"']*legend[^"']*["'])[^>]*>([\s\S]*?)<\/\1>/i);
  assert.ok(priorityLegend, 'report must include its priority legend');
  for (const priority of ['Critical', 'High', 'Moderate']) {
    assert.match(priorityLegend[2], new RegExp(`\\b${priority}\\b`, 'i'), `priority legend must explain ${priority}`);
  }
}

function checkedCase(overrides = {}) {
  const options = freeze({ ...BASELINE_OPTIONS, ...overrides });
  const plan = freeze(allocate(scenario, options));
  assertPlan(plan, options);
  assertReport(plan, buildReport(scenario, plan, options), renderReport(scenario, plan, options));
  return plan;
}

function assertWhatIfCases(baseline) {
  const expanded = checkedCase({ roadCapacityScale: 1.5 });
  assert.ok(expanded.totals.allocated >= EXPECTED_TOTALS.allocated, 'expanded road capacity must not reduce allocation');
  if (baseline.bottlenecks.length && EXPECTED_TOTALS.unmet > 0) {
    assert.ok(expanded.totals.allocated > EXPECTED_TOTALS.allocated, 'sample capacity what-if should improve allocation');
  }
  assert.ok(expanded.totals.unmet <= EXPECTED_TOTALS.unmet, 'expanded road capacity must not increase unmet demand');

  const noInventory = checkedCase({ inventoryScale: 0 });
  assert.equal(noInventory.totals.allocated, 0);
  assert.equal(noInventory.totals.unmet, noInventory.totals.demand);
  assert.equal(noInventory.totals.available, 0);

  const closedHillAccess = checkedCase({ closedRoadIds: ['hill-access'] });
  const hilltop = byId(closedHillAccess.shelters, 'hilltop', 'closed-road shelter');
  assert.equal(hilltop.reachable, false);
  assert.equal(sum(Object.values(hilltop.allocated)), 0);
  for (const resource of RESOURCE_IDS) assert.equal(hilltop.unmet[resource], hilltop.demand[resource]);
  assert.ok(closedHillAccess.allocations.every((allocation) => !allocation.roadIds.includes('hill-access')));
  return { expanded, noInventory, hilltop };
}

const originalScenario = structuredClone(scenario);
freeze(scenario);

const baseline = freeze(allocate(scenario, BASELINE_OPTIONS));
const report = buildReport(scenario, baseline, BASELINE_OPTIONS);
const html = renderReport(scenario, baseline, BASELINE_OPTIONS);
const repeatedPlan = allocate(scenario, BASELINE_OPTIONS);
const repeatedReport = buildReport(scenario, repeatedPlan, BASELINE_OPTIONS);
const repeatedHtml = renderReport(scenario, repeatedPlan, BASELINE_OPTIONS);

assertBaseline(baseline);
assertPlan(baseline, BASELINE_OPTIONS);
assertReport(baseline, report, html);
assert.deepEqual(repeatedPlan, baseline, 'repeated plan must be deterministic');
assert.deepEqual(repeatedReport, report, 'repeated report must be deterministic');
assert.equal(repeatedHtml, html, 'repeated report HTML must be deterministic');
const { expanded, noInventory, hilltop } = assertWhatIfCases(baseline);
assert.deepEqual(scenario, originalScenario, 'scenario must remain immutable');

console.log(`${formatSampleSummary(scenario, baseline, report, { expanded, noInventory, hilltop })}\n\nSample scenario checks passed.`);
