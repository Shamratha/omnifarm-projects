import test from 'node:test';
import assert from 'node:assert/strict';
import { scenario } from '../src/data.js';
import { allocate } from '../src/planner.js';
import { buildReport, renderReport } from '../src/report.js';

const AS_OF = '2025-07-01T00:00:00.000Z';

function node(id, name, type) {
  return { id, name, x: 0, y: 0, type };
}

function road(id, from, to, capacity = 100, closed = false) {
  return { id, from, to, name: id, minutes: 5, capacity, closed };
}

function reportFor(input, options = {}) {
  const plan = allocate(input, options);
  return { plan, report: buildReport(input, plan, options) };
}

function simpleFixture({
  demand = { water: 4 },
  quantity = 4,
  capacity = 100,
  resources = [{ id: 'water', name: 'Water', unit: 'liters' }],
  inventory = null,
} = {}) {
  return {
    asOf: AS_OF,
    resources,
    nodes: [node('depot', 'Depot', 'depot'), node('shelter-node', 'Shelter', 'shelter')],
    shelters: [{
      id: 'shelter-1',
      nodeId: 'shelter-node',
      name: 'Shelter',
      area: 'Test area',
      population: 100,
      priority: 'high',
      vulnerability: 0.8,
      demand,
    }],
    roads: [road('route', 'depot', 'shelter-node', capacity)],
    inventory: inventory || [{
      id: 'lot-1',
      depotId: 'depot',
      resource: 'water',
      quantity,
      expiresAt: '2025-07-02T00:00:00.000Z',
    }],
    alerts: [],
  };
}

function byId(items, id) {
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `expected an item with id ${id}`);
  return item;
}

function resourceById(shelter, id) {
  return byId(shelter.resources, id);
}

function approximatelyEqual(actual, expected, message) {
  assert.ok(Number.isFinite(actual), `${message}: expected a finite number`);
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
}

function bodyText(html) {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, decimal) => String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function section(html, id) {
  // The outer report section can contain the first named section, so locate
  // the requested opening tag directly rather than depending on wrapper markup.
  const opening = [...html.matchAll(/<section\b[^>]*>/gi)]
    .find(([tag]) => attribute(tag, 'id') === id);
  assert.ok(opening, `missing report section ${id}`);
  const start = opening.index + opening[0].length;
  const end = html.indexOf('</section>', start);
  assert.ok(end >= start, `section ${id} must close`);
  return html.slice(start, end);
}

function assertNumericTables(markup) {
  const tables = [...markup.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  assert.ok(tables.length > 0, 'expected a report table');
  for (const [, table] of tables) {
    const caption = table.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
    assert.ok(caption && bodyText(caption[1]), 'table needs a descriptive caption');
    const headers = [...table.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)];
    assert.ok(headers.some(([tag]) => attribute(tag, 'scope') === 'col'), 'table needs column headers');
    for (const [tag] of headers) {
      assert.ok(['col', 'row', 'colgroup', 'rowgroup'].includes(attribute(tag, 'scope')), 'headers need an explicit scope');
    }
    for (const [tag, , content] of table.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
      const text = bodyText(content);
      if (/^\d[\d,.]*(?:\s*%|\s+min)?$/.test(text)) {
        assert.ok((attribute(tag, 'class') || '').split(/\s+/).includes('report-number'), `numeric cell "${text}" needs report-number`);
      }
    }
  }
}

function assertPlanAccounting(options) {
  const input = structuredClone(scenario);
  const { plan, report } = reportFor(input, options);

  assert.equal(report.shelters.length, input.shelters.length);
  for (const plannedShelter of plan.shelters) {
    const sourceShelter = byId(input.shelters, plannedShelter.id);
    const row = byId(report.shelters, plannedShelter.id);
    assert.deepEqual(
      { id: row.id, name: row.name, priority: row.priority, population: row.population },
      {
        id: sourceShelter.id,
        name: sourceShelter.name,
        priority: sourceShelter.priority,
        population: sourceShelter.population,
      },
    );
    assert.equal(row.reachable, plannedShelter.reachable);
    assert.equal(row.coverage, plannedShelter.coverage);
    assert.equal(row.totalAllocated, Object.values(plannedShelter.allocated).reduce((sum, value) => sum + value, 0));
    assert.equal(row.totalUnmet, Object.values(plannedShelter.unmet).reduce((sum, value) => sum + value, 0));
    assert.equal(row.resources.length, input.resources.length);
    for (const resource of input.resources) {
      const resourceRow = resourceById(row, resource.id);
      assert.deepEqual(
        resourceRow,
        {
          id: resource.id,
          name: resource.name,
          unit: resource.unit,
          demand: sourceShelter.demand?.[resource.id] ?? 0,
          allocated: plannedShelter.allocated[resource.id] ?? 0,
          unmet: plannedShelter.unmet[resource.id] ?? 0,
        },
      );
    }
  }

  approximatelyEqual(report.shelters.reduce((sum, row) => sum + row.totalAllocated, 0), plan.totals.allocated, 'total allocated');
  approximatelyEqual(report.shelters.reduce((sum, row) => sum + row.totalUnmet, 0), plan.totals.unmet, 'total unmet');
  for (const resource of input.resources) {
    const allocated = report.shelters.reduce((sum, row) => sum + resourceById(row, resource.id).allocated, 0);
    const ledgerAllocated = plan.allocations.filter((entry) => entry.resource === resource.id)
      .reduce((sum, entry) => sum + entry.quantity, 0);
    approximatelyEqual(allocated, ledgerAllocated, `${resource.id} allocation ledger`);
  }
  const expectedUnmet = report.shelters.filter((row) => row.totalUnmet > 0);
  assert.equal(report.unmet.length, expectedUnmet.length);
  for (const row of expectedUnmet) assert.deepEqual(byId(report.unmet, row.id), row);
  assert.equal(report.bottlenecks.length, plan.bottlenecks.length);
  for (const roadSummary of plan.bottlenecks) {
    const row = byId(report.bottlenecks, roadSummary.id);
    for (const [key, value] of Object.entries(roadSummary)) assert.deepEqual(row[key], value);
    assert.equal(row.capacity, roadSummary.capacity);
    assert.equal(row.baseCapacity, roadSummary.baseCapacity);
    assert.equal(row.used, roadSummary.used);
    assert.equal(row.remaining, roadSummary.remaining);
    assert.equal(row.utilization, roadSummary.utilization);
  }

  const expiredLots = input.inventory.filter((item) => Date.parse(item.expiresAt) <= Date.parse(input.asOf));
  assert.equal(report.expired.length, expiredLots.length);
  for (const lot of expiredLots) {
    const row = byId(report.expired, lot.id);
    const depot = byId(input.nodes, lot.depotId);
    const resource = byId(input.resources, lot.resource);
    for (const [key, value] of Object.entries(lot)) assert.deepEqual(row[key], value);
    assert.equal(row.excludedQuantity, lot.quantity * (options.inventoryScale ?? 1));
    assert.equal(row.depotName, depot.name);
    assert.equal(row.resourceName, resource.name);
    assert.equal(row.unit, resource.unit);
    assert.equal(row.quantity, lot.quantity);
    assert.equal(row.depotId, lot.depotId);
    assert.equal(row.resource, lot.resource);
  }
  assert.equal(report.expired.reduce((sum, lot) => sum + lot.excludedQuantity, 0), plan.totals.expired);
  assert.equal(report.equity.floor, options.equityFloor ?? 0.4);
  assert.equal(report.equity.shelters.length, plan.shelters.length);
  assert.equal(report.equity.metCount, plan.shelters.filter((shelter) => shelter.equityMet).length);
  assert.equal(report.equity.shortfallCount, plan.shelters.filter((shelter) => !shelter.equityMet).length);
  for (const shelter of plan.shelters) {
    const row = byId(report.equity.shelters, shelter.id);
    assert.equal(row.name, shelter.name);
    assert.equal(row.vulnerability, shelter.vulnerability);
    assert.equal(row.met, shelter.equityMet);
    assert.equal(row.resources.length, input.resources.length);
    for (const resource of input.resources) {
      const target = (shelter.demand[resource.id] ?? 0) * (options.equityFloor ?? 0.4);
      assert.deepEqual(resourceById(row, resource.id), {
        ...resource, target, allocated: shelter.allocated[resource.id],
        shortfall: Math.max(0, target - shelter.allocated[resource.id]),
      });
    }
  }
}

for (const options of [{}, { inventoryScale: 0.5, roadCapacityScale: 0.5, equityFloor: 0.4 }]) {
  test(`buildReport preserves per-resource plan accounting (${options.inventoryScale ?? 1} inventory scale)`, () => {
    assertPlanAccounting(options);
  });
}

test('reports expired quantities with an explicit zero inventory scale', () => {
  const input = structuredClone(scenario);
  const { report } = reportFor(input, { inventoryScale: 0, equityFloor: 0 });

  assert.ok(report.expired.length > 0);
  for (const lot of input.inventory.filter((item) => Date.parse(item.expiresAt) <= Date.parse(input.asOf))) {
    assert.equal(byId(report.expired, lot.id).excludedQuantity, 0);
  }
});

test('reports effective scaled capacity for every saturated road', () => {
  const input = simpleFixture({ demand: { water: 10 }, quantity: 10, capacity: 3 });
  const { plan, report } = reportFor(input, { roadCapacityScale: 2, equityFloor: 0 });
  const plannedRoad = byId(plan.bottlenecks, 'route');
  const reportRoad = byId(report.bottlenecks, 'route');

  assert.equal(plannedRoad.capacity, 6);
  assert.equal(reportRoad.capacity, 6);
  assert.equal(reportRoad.baseCapacity, 3);
  assert.equal(reportRoad.used, 6);
  assert.equal(reportRoad.remaining, 0);
});

test('includes disconnected shelters in unmet demand after closing hill access', () => {
  const input = structuredClone(scenario);
  const { plan, report } = reportFor(input, { closedRoadIds: ['hill-access'], equityFloor: 0 });
  const plannedShelter = byId(plan.shelters, 'hilltop');
  const shelter = byId(report.shelters, 'hilltop');
  const unmet = byId(report.unmet, 'hilltop');

  assert.equal(plannedShelter.reachable, false);
  assert.equal(shelter.reachable, false);
  assert.equal(shelter.totalAllocated, 0);
  const source = byId(input.shelters, 'hilltop');
  assert.equal(shelter.totalUnmet, Object.values(source.demand).reduce((sum, value) => sum + value, 0));
  assert.deepEqual(unmet, shelter);
  for (const resource of input.resources) {
    assert.equal(resourceById(shelter, resource.id).allocated, 0);
    assert.equal(resourceById(unmet, resource.id).unmet, source.demand[resource.id]);
  }
  const html = section(renderReport(input, plan, { closedRoadIds: ['hill-access'], equityFloor: 0 }), 'report-unmet');
  assert.ok(bodyText(html).includes(source.name));
  assert.match(bodyText(html), /disconnected/i);
});

test('reports equity shortfall per resource rather than using aggregate coverage', () => {
  const input = simpleFixture({
    demand: { water: 10, food: 10 },
    resources: [
      { id: 'water', name: 'Water', unit: 'liters' },
      { id: 'food', name: 'Food', unit: 'kits' },
    ],
    inventory: [
      { id: 'water-lot', depotId: 'depot', resource: 'water', quantity: 10, expiresAt: '2025-07-02T00:00:00.000Z' },
      { id: 'food-lot', depotId: 'depot', resource: 'food', quantity: 2, expiresAt: '2025-07-02T00:00:00.000Z' },
    ],
  });
  const options = { equityFloor: 0.4 };
  const { plan, report } = reportFor(input, options);
  const plannedShelter = byId(plan.shelters, 'shelter-1');
  const equityShelter = byId(report.equity.shelters, 'shelter-1');
  const food = resourceById(equityShelter, 'food');

  assert.ok(plannedShelter.coverage >= options.equityFloor);
  assert.equal(plannedShelter.equityMet, false);
  assert.equal(equityShelter.met, false);
  assert.equal(report.equity.floor, options.equityFloor);
  assert.deepEqual(resourceById(equityShelter, 'water'), {
    id: 'water', name: 'Water', unit: 'liters', target: 4, allocated: 10, shortfall: 0,
  });
  assert.deepEqual(food, {
    id: 'food', name: 'Food', unit: 'kits', target: 4, allocated: 2, shortfall: 2,
  });
  assert.equal(report.equity.metCount, 0);
  assert.equal(report.equity.shortfallCount, 1);
});

test('floor zero is represented as disabled equity with zero targets', () => {
  const input = simpleFixture({ quantity: 0, demand: { water: 7 } });
  const { plan, report } = reportFor(input, { equityFloor: 0 });
  const plannedShelter = byId(plan.shelters, 'shelter-1');
  const equityShelter = byId(report.equity.shelters, 'shelter-1');

  assert.equal(plannedShelter.equityMet, true);
  assert.equal(equityShelter.met, true);
  assert.equal(report.equity.floor, 0);
  assert.deepEqual(resourceById(equityShelter, 'water'), {
    id: 'water', name: 'Water', unit: 'liters', target: 0, allocated: 0, shortfall: 0,
  });
  assert.equal(report.equity.metCount, 1);
  assert.equal(report.equity.shortfallCount, 0);
  assert.match(bodyText(section(renderReport(input, plan, { equityFloor: 0 }), 'report-equity')), /disabled/i);
});

test('handles zero capacity and zero inventory while exposing the saturated road', () => {
  const input = simpleFixture({
    demand: { water: 5 },
    quantity: 0,
    capacity: 0,
  });
  const { plan, report } = reportFor(input, { equityFloor: 0 });
  const shelter = byId(report.shelters, 'shelter-1');
  const bottleneck = byId(report.bottlenecks, 'route');

  assert.equal(byId(plan.shelters, 'shelter-1').reachable, false);
  assert.equal(shelter.reachable, false);
  assert.equal(shelter.totalAllocated, 0);
  assert.equal(shelter.totalUnmet, 5);
  assert.equal(bottleneck.capacity, 0);
  assert.equal(bottleneck.used, 0);
  assert.equal(bottleneck.remaining, 0);
  assert.equal(bottleneck.utilization, 0);
  assert.deepEqual(report.expired, []);
  const html = renderReport(input, plan, { equityFloor: 0 });
  assert.doesNotMatch(bodyText(html), /NaN|Infinity/);
  assertNumericTables(section(html, 'report-bottlenecks'));
  assert.match(bodyText(section(html, 'report-bottlenecks')), /No capacity/);
  assert.doesNotMatch(bodyText(section(html, 'report-bottlenecks')), /0% saturated/);
});

test('zero inventory leaves reachable shelters fully unmet without creating road bottlenecks', () => {
  const input = simpleFixture();
  const { plan, report } = reportFor(input, { inventoryScale: 0 });
  const shelter = byId(report.shelters, 'shelter-1');
  assert.equal(shelter.reachable, true);
  assert.equal(shelter.coverage, 0);
  assert.equal(shelter.totalAllocated, 0);
  assert.equal(shelter.totalUnmet, 4);
  assert.equal(resourceById(shelter, 'water').unmet, 4);
  assert.deepEqual(report.bottlenecks, []);
  assert.equal(report.equity.shortfallCount, 1);
  assert.doesNotMatch(bodyText(renderReport(input, plan, { inventoryScale: 0 })), /NaN|Infinity/);
});

test('returns empty unmet, expired, and bottleneck sections for a fully supplied plan', () => {
  const input = simpleFixture({ demand: { water: 4 }, quantity: 4, capacity: 100 });
  const { plan, report } = reportFor(input, { equityFloor: 0.4 });

  assert.equal(report.shelters[0].totalUnmet, 0);
  assert.deepEqual(report.unmet, []);
  assert.deepEqual(report.expired, []);
  assert.deepEqual(report.bottlenecks, []);
  const html = renderReport(input, plan, { equityFloor: 0.4 });
  for (const [id, message] of [
    ['report-unmet', /no unmet demand/i],
    ['report-expired', /no expired (?:supplies|inventory)/i],
    ['report-bottlenecks', /no (?:saturated (?:open )?roads|(?:route )?bottlenecks)/i],
  ]) {
    const content = section(html, id);
    assert.match(bodyText(content), message);
    assert.doesNotMatch(content, /<tbody\b[^>]*>\s*<\/tbody>/i);
  }
});

test('renderReport escapes dynamic data and exposes accessible numeric tables', () => {
  const input = structuredClone(scenario);
  const payload = `<img src="x" onerror='alert(1)'> & <script>alert(1)</script>`;
  const values = [];
  for (const [collection, field] of [
    [input.shelters, 'name'], [input.nodes, 'name'], [input.roads, 'name'],
    [input.resources, 'name'], [input.resources, 'unit'], [input.inventory, 'id'],
  ]) {
    for (const item of collection) {
      item[field] = `${item[field]} ${payload}`;
    }
  }
  const { plan } = reportFor(input);
  values.push(input.shelters[0].name, input.resources[0].name, input.resources[0].unit);
  for (const lot of plan.inventory.filter((lot) => lot.expired)) {
    values.push(lot.id, byId(input.nodes, lot.depotId).name);
  }
  for (const bottleneck of plan.bottlenecks) values.push(bottleneck.name);
  const html = renderReport(input, plan);
  for (const value of values) assert.ok(bodyText(html).includes(value), `missing escaped dynamic text ${value}`);
  for (const [id, heading] of [
    ['report-shelters', 'Shelter allocations'], ['report-unmet', 'Unmet demand'],
    ['report-bottlenecks', 'Route bottlenecks'], ['report-expired', 'Expired supplies'],
    ['report-equity', 'Equity indicators'],
  ]) {
    const content = section(html, id);
    const headings = [...content.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
    assert.ok(headings.some(([, text]) => bodyText(text) === heading), `missing heading ${heading}`);
    assertNumericTables(content);
  }
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.match(html, /&quot;|&#(?:34|x22);/i);
  assert.match(html, /&#(?:39|x27);|&apos;/i);
});

test('fractional demand, allocation, shortfall, excluded stock and capacity remain visible', () => {
  const input = simpleFixture({ demand: { water: 2.5 }, quantity: 1.5, capacity: 0.75 });
  input.inventory.push({
    id: 'expired-lot', depotId: 'depot', resource: 'water', quantity: 2.5, expiresAt: AS_OF,
  });
  const options = { inventoryScale: 0.5 };
  const { report, plan } = reportFor(input, options);
  assert.equal(report.shelters[0].totalAllocated, 0.75);
  assert.equal(report.shelters[0].totalUnmet, 1.75);
  assert.equal(report.expired[0].excludedQuantity, 1.25);
  assert.equal(report.bottlenecks[0].capacity, 0.75);
  assert.equal(report.equity.shelters[0].resources[0].shortfall, 0.25);
  const html = renderReport(input, plan, options);
  for (const [id, amounts] of [
    ['report-shelters', ['2.5', '0.75', '1.75']],
    ['report-unmet', ['1.75']], ['report-bottlenecks', ['0.75']],
    ['report-expired', ['1.25']], ['report-equity', ['0.75', '0.25']],
  ]) {
    const content = section(html, id);
    const cells = [...content.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(([, cell]) => bodyText(cell));
    for (const amount of amounts) {
      assert.ok(cells.some((cell) => Number(cell.replace(/,/g, '')) === Number(amount)), `${id} must display ${amount} without rounding to an integer`);
    }
    assertNumericTables(content);
  }
});

test('repeated report construction and rendering is deterministic and non-mutating', () => {
  const input = structuredClone(scenario);
  const options = { inventoryScale: 0.75, roadCapacityScale: 0.5, equityFloor: 0.25 };
  const originalInput = structuredClone(input);
  const originalOptions = structuredClone(options);
  const plan = allocate(input, options);
  const originalPlan = structuredClone(plan);

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  freeze(input);
  freeze(plan);
  freeze(options);
  const first = buildReport(input, plan, options);
  const originalReport = structuredClone(first);
  const html = renderReport(input, plan, options);

  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.deepEqual(buildReport(input, plan, options), first);
    assert.equal(renderReport(input, plan, options), html);
  }
  assert.deepEqual(first, originalReport);
  assert.deepEqual(input, originalInput);
  assert.deepEqual(options, originalOptions);
  assert.deepEqual(plan, originalPlan);
});

test('report row order stays stable when planner summary arrays are reordered', () => {
  const options = { roadCapacityScale: 0.5 };
  const plan = allocate(scenario, options);
  const reordered = {
    ...plan,
    shelters: [...plan.shelters].reverse(),
    bottlenecks: [...plan.bottlenecks].reverse(),
    roads: [...plan.roads].reverse(),
    inventory: [...plan.inventory].reverse(),
  };
  assert.deepEqual(buildReport(scenario, reordered, options), buildReport(scenario, plan, options));
  assert.equal(renderReport(scenario, reordered, options), renderReport(scenario, plan, options));
});

test('expired lot timestamps display the absolute UTC time regardless of their offset', () => {
  const input = simpleFixture();
  input.inventory[0].expiresAt = '2025-06-30T19:00:00-05:00';
  const plan = allocate(input);
  const html = section(renderReport(input, plan), 'report-expired');
  assert.match(bodyText(html), /2025-07-01T00:00:00\.000Z UTC/);
  assert.match(bodyText(html), /Excluded quantity/);
});

test('empty scenario retains all report sections and descriptive empty states', () => {
  const input = { ...simpleFixture(), shelters: [], roads: [], inventory: [] };
  const plan = allocate(input);
  const html = renderReport(input, plan);
  for (const [id, text] of [
    ['report-shelters', 'No shelters'], ['report-unmet', 'No unmet demand'],
    ['report-bottlenecks', 'No saturated open roads'], ['report-expired', 'No expired supplies'],
    ['report-equity', 'No shelters'],
  ]) {
    assert.ok(bodyText(section(html, id)).includes(text));
  }
  assert.doesNotMatch(bodyText(html), /NaN|Infinity/);
});
