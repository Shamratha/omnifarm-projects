import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/planner.js';

const AS_OF = '2025-07-01T00:00:00.000Z';

function scenario({
  nodes,
  shelters,
  roads,
  inventory,
  resources = [{ id: 'water', name: 'Water', unit: 'units' }],
}) {
  return {
    asOf: AS_OF,
    resources,
    nodes,
    shelters,
    roads,
    inventory,
    alerts: [],
  };
}

function node(id, name, type) {
  return { id, name, x: 0, y: 0, type };
}

function shelter(id, nodeId, demand, priority = 'high', vulnerability = 0.5) {
  return {
    id,
    nodeId,
    name: id,
    area: 100,
    population: 100,
    priority,
    vulnerability,
    demand: { water: demand },
  };
}

function road(id, from, to, minutes = 10, capacity = 100, closed = false) {
  return { id, from, to, name: id, minutes, capacity, closed };
}

function stock(id, depotId, quantity, expiresAt = '2025-07-02T00:00:00.000Z') {
  return { id, depotId, resource: 'water', quantity, expiresAt };
}

function simpleScenario() {
  return scenario({
    nodes: [node('depot', 'Depot', 'depot'), node('shelter-node', 'Shelter', 'shelter')],
    shelters: [shelter('shelter-1', 'shelter-node', 6)],
    roads: [road('route', 'depot', 'shelter-node', 5, 8)],
    inventory: [stock('water-1', 'depot', 10)],
  });
}

function byId(items, id) {
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `expected an item with id ${id}`);
  return item;
}

function shelterAllocation(result, shelterId) {
  return result.allocations
    .filter((allocation) => allocation.shelterId === shelterId)
    .reduce((total, allocation) => total + allocation.quantity, 0);
}

function shelterWater(result, shelterId, field) {
  return byId(result.shelters, shelterId)[field].water ?? 0;
}

function totalAllocation(result) {
  return result.allocations.reduce((total, allocation) => total + allocation.quantity, 0);
}

function approximatelyEqual(actual, expected, message) {
  assert.ok(Number.isFinite(actual), `${message}: expected a finite number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

function assertConservation(input, result, { inventoryScale = 1, roadCapacityScale = 1, closedRoadIds = [] } = {}) {
  const demand = input.shelters.reduce(
    (total, destination) => total + input.resources.reduce((sum, resource) => sum + (destination.demand?.[resource.id] ?? 0), 0),
    0,
  );
  const available = input.inventory
    .filter((item) => Date.parse(item.expiresAt) > Date.parse(input.asOf))
    .reduce((total, item) => total + item.quantity * inventoryScale, 0);
  const expired = input.inventory.reduce((total, item) => total + item.quantity * inventoryScale, 0) - available;

  approximatelyEqual(result.totals.demand, demand, 'total demand');
  approximatelyEqual(totalAllocation(result), result.totals.allocated, 'allocation ledger');
  approximatelyEqual(result.totals.allocated + result.totals.unmet, demand, 'demand conservation');
  approximatelyEqual(result.totals.available, available, 'available stock');
  approximatelyEqual(result.totals.expired, expired, 'expired stock');
  approximatelyEqual(result.totals.coverage, demand === 0 ? 1 : result.totals.allocated / demand, 'total coverage');
  assert.ok(result.totals.allocated <= available);
  assert.ok(Array.isArray(result.bottlenecks));
  assert.ok(result.decisions.length > 0 && result.decisions.every((decision) => typeof decision === 'string'));

  for (const destination of input.shelters) {
    const summary = byId(result.shelters, destination.id);
    assert.equal(typeof summary.reachable, 'boolean');
    assert.equal(typeof summary.equityMet, 'boolean');
    assert.ok(summary.allocated && summary.unmet);
    let allocated = 0;
    let requested = 0;
    for (const { id: resource } of input.resources) {
      const quantity = destination.demand?.[resource] ?? 0;
      const delivered = result.allocations
        .filter((item) => item.shelterId === destination.id && item.resource === resource)
        .reduce((total, item) => total + item.quantity, 0);
      assert.ok(delivered <= quantity, `${destination.id}/${resource} exceeds demand`);
      approximatelyEqual(summary.allocated[resource] ?? 0, delivered, 'shelter allocation');
      approximatelyEqual(delivered + (summary.unmet[resource] ?? 0), quantity, 'shelter demand conservation');
      allocated += delivered;
      requested += quantity;
    }
    approximatelyEqual(summary.coverage, requested === 0 ? 1 : allocated / requested, 'shelter coverage');
  }

  for (const item of result.inventory) {
    const original = byId(input.inventory, item.id);
    const usable = Date.parse(original.expiresAt) > Date.parse(input.asOf)
      ? original.quantity * inventoryScale
      : 0;
    assert.ok('expired' in item);
    approximatelyEqual(item.available, usable, 'inventory availability');
    assert.ok(item.allocated >= 0 && item.remaining >= 0);
    approximatelyEqual(item.allocated + item.remaining, usable, 'inventory conservation');
  }
  for (const depotId of new Set(input.inventory.map((item) => item.depotId))) {
    for (const resource of input.resources) {
      const delivered = result.allocations
        .filter((item) => item.depotId === depotId && item.resource === resource.id)
        .reduce((total, item) => total + item.quantity, 0);
      const stockAllocated = result.inventory
        .filter((item) => item.depotId === depotId && item.resource === resource.id)
        .reduce((total, item) => total + item.allocated, 0);
      approximatelyEqual(delivered, stockAllocated, 'depot/resource allocation conservation');
    }
  }

  for (const allocation of result.allocations) {
    assert.ok(Number.isFinite(allocation.quantity) && allocation.quantity > 0);
    assert.ok(input.resources.some((item) => item.id === allocation.resource));
    assert.equal(typeof allocation.phase, 'string');
    assert.ok(allocation.phase.length > 0);
    let currentNode = allocation.depotId;
    let minutes = 0;
    for (const roadId of allocation.roadIds) {
      const segment = byId(input.roads, roadId);
      assert.ok(!segment.closed && !closedRoadIds.includes(roadId), 'allocations cannot traverse a closed road');
      assert.equal(byId(result.roads, roadId).closed, false);
      assert.ok(segment.from === currentNode || segment.to === currentNode, 'route must be continuous');
      currentNode = segment.from === currentNode ? segment.to : segment.from;
      minutes += segment.minutes;
    }
    assert.equal(currentNode, byId(input.shelters, allocation.shelterId).nodeId);
    approximatelyEqual(allocation.minutes, minutes, 'route travel time');
  }
  for (const segment of input.roads) {
    const summary = byId(result.roads, segment.id);
    const closed = Boolean(segment.closed || closedRoadIds.includes(segment.id));
    const capacity = segment.capacity * roadCapacityScale;
    assert.equal(summary.closed, closed);
    approximatelyEqual(summary.baseCapacity, segment.capacity, 'base road capacity');
    approximatelyEqual(summary.capacity, capacity, 'effective road capacity');
    const used = result.allocations
      .filter((item) => item.roadIds.includes(segment.id))
      .reduce((total, item) => total + item.quantity, 0);
    approximatelyEqual(summary.used, used, 'shared road usage');
    assert.ok(used <= capacity && summary.remaining >= 0);
    if (closed) {
      assert.equal(used, 0, 'closed roads carry no allocations');
      assert.equal(summary.remaining, 0, 'closed roads expose no usable capacity');
    } else {
      approximatelyEqual(summary.used + summary.remaining, capacity, 'road capacity conservation');
    }
    approximatelyEqual(summary.utilization, capacity === 0 ? 0 : used / capacity, 'road utilization');
    assert.equal(result.bottlenecks.some((item) => item.id === segment.id), !closed && summary.remaining === 0);
  }
}

test('marks shelters without a route unreachable and leaves their demand unmet', () => {
  const input = scenario({
    nodes: [node('depot', 'Depot', 'depot'), node('isolated', 'Isolated', 'shelter')],
    shelters: [shelter('shelter-isolated', 'isolated', 6)],
    roads: [road('closed-access', 'depot', 'isolated')],
    inventory: [stock('water-1', 'depot', 10)],
  });

  const result = allocate(input, { equityFloor: 0, closedRoadIds: ['closed-access'] });
  const destination = byId(result.shelters, 'shelter-isolated');

  assert.equal(destination.reachable, false);
  assert.equal(byId(result.roads, 'closed-access').closed, true);
  assert.equal(destination.allocated.water ?? 0, 0);
  assert.equal(destination.unmet.water, 6);
  assert.equal(result.allocations.length, 0);
  assert.equal(result.totals.allocated, 0);
  assert.equal(result.totals.unmet, 6);
  assertConservation(input, result, { closedRoadIds: ['closed-access'] });
});

test('uses shelter id as the stable tiebreaker for equal priorities', () => {
  const input = scenario({
    nodes: [
      node('depot', 'Depot', 'depot'),
      node('a-node', 'A', 'shelter'),
      node('b-node', 'B', 'shelter'),
    ],
    // Deliberately reverse the input order: id, rather than input order, wins.
    shelters: [
      shelter('shelter-b', 'b-node', 4, 'critical', 0.5),
      shelter('shelter-a', 'a-node', 4, 'critical', 0.5),
    ],
    roads: [road('road-a', 'depot', 'a-node'), road('road-b', 'depot', 'b-node')],
    inventory: [stock('water-1', 'depot', 4)],
  });

  const result = allocate(input, { equityFloor: 0 });

  assert.equal(shelterAllocation(result, 'shelter-a'), 4);
  assert.equal(shelterAllocation(result, 'shelter-b'), 0);
  assert.equal(result.allocations.every((allocation) => allocation.shelterId === 'shelter-a'), true);
  assert.ok(result.decisions.every((decision) => typeof decision === 'string'));
  const reordered = allocate({ ...input, shelters: [...input.shelters].reverse() }, { equityFloor: 0 });
  assert.deepEqual(reordered.allocations, result.allocations);
});

test('treats inventory expiring exactly at asOf as expired', () => {
  const input = scenario({
    nodes: [node('depot', 'Depot', 'depot'), node('shelter-node', 'Shelter', 'shelter')],
    shelters: [shelter('shelter-1', 'shelter-node', 6)],
    roads: [road('road-1', 'depot', 'shelter-node')],
    inventory: [
      stock('expired-earlier', 'depot', 3, '2025-06-30T23:59:59.000Z'),
      stock('expired', 'depot', 5, AS_OF),
      stock('current', 'depot', 2),
    ],
  });

  const result = allocate(input, { equityFloor: 0 });
  const expired = byId(result.inventory, 'expired');
  const current = byId(result.inventory, 'current');

  assert.ok(expired.expired);
  assert.equal(expired.available, 0);
  assert.equal(expired.allocated, 0);
  assert.equal(expired.remaining, 0);
  assert.equal(byId(result.inventory, 'expired-earlier').available, 0);
  assert.equal(byId(result.inventory, 'expired-earlier').allocated, 0);
  assert.equal(current.allocated, 2);
  assert.equal(shelterAllocation(result, 'shelter-1'), 2);
  assert.equal(result.totals.expired, 8);
  assert.equal(result.totals.unmet, 4);
  assert.equal(result.totals.available, 2);
});

test('preserves demand, stock, and route-capacity conservation', () => {
  const input = scenario({
    nodes: [
      node('depot', 'Depot', 'depot'),
      node('hub', 'Hub', 'transfer'),
      node('shelter-1-node', 'Shelter 1', 'shelter'),
      node('shelter-2-node', 'Shelter 2', 'shelter'),
    ],
    shelters: [
      shelter('shelter-1', 'shelter-1-node', 5),
      shelter('shelter-2', 'shelter-2-node', 5),
    ],
    roads: [
      road('shared', 'depot', 'hub', 4, 6),
      road('branch-1', 'hub', 'shelter-1-node', 3, 100),
      road('branch-2', 'hub', 'shelter-2-node', 3, 100),
    ],
    resources: [
      { id: 'water', name: 'Water', unit: 'units' },
      { id: 'food', name: 'Food', unit: 'units' },
    ],
    inventory: [
      stock('water-1', 'depot', 3),
      stock('water-2', 'depot', 4),
      { ...stock('food-1', 'depot', 2), resource: 'food' },
    ],
  });
  input.shelters[0].demand.food = 2;
  input.shelters[1].demand.food = 2;

  const result = allocate(input, { equityFloor: 0 });

  assert.equal(result.totals.allocated, 6, 'available stock should fill the shared bottleneck');
  assertConservation(input, result);
});

test('shares one road capacity across allocations using that road', () => {
  const input = scenario({
    nodes: [
      node('depot', 'Depot', 'depot'),
      node('hub', 'Hub', 'transfer'),
      node('left', 'Left', 'shelter'),
      node('right', 'Right', 'shelter'),
    ],
    shelters: [shelter('left-shelter', 'left', 4), shelter('right-shelter', 'right', 4)],
    roads: [
      road('bottleneck', 'depot', 'hub', 5, 5),
      road('left-branch', 'hub', 'left', 5, 100),
      road('right-branch', 'hub', 'right', 5, 100),
    ],
    inventory: [stock('water-1', 'depot', 8)],
  });

  const result = allocate(input, { equityFloor: 0 });
  const bottleneck = byId(result.roads, 'bottleneck');
  const users = result.allocations.filter((allocation) => allocation.roadIds.includes('bottleneck'));

  assert.ok(users.length >= 2, 'both shelters should receive through the shared route');
  assert.equal(users.reduce((total, allocation) => total + allocation.quantity, 0), bottleneck.used);
  assert.equal(bottleneck.used, 5);
  assert.equal(bottleneck.remaining, 0);
  assert.equal(totalAllocation(result), 5);
  assert.ok(shelterAllocation(result, 'left-shelter') > 0);
  assert.ok(shelterAllocation(result, 'right-shelter') > 0);
});

test('roadCapacityScale changes the amount that can pass a bottleneck', () => {
  const input = scenario({
    nodes: [node('depot', 'Depot', 'depot'), node('hub', 'Hub', 'transfer'), node('shelter-node', 'Shelter', 'shelter')],
    shelters: [shelter('shelter-1', 'shelter-node', 10)],
    roads: [road('bottleneck', 'depot', 'hub', 4, 3), road('last-mile', 'hub', 'shelter-node', 4, 100)],
    inventory: [stock('water-1', 'depot', 10)],
  });

  const regular = allocate(input, { equityFloor: 0, roadCapacityScale: 1 });
  const expanded = allocate(input, { equityFloor: 0, roadCapacityScale: 2 });
  const regularRoad = byId(regular.roads, 'bottleneck');
  const expandedRoad = byId(expanded.roads, 'bottleneck');

  assert.equal(regular.totals.allocated, 3);
  assert.equal(expanded.totals.allocated, 6);
  assert.equal(regular.totals.allocated, regularRoad.used);
  assert.equal(expanded.totals.allocated, expandedRoad.used);
  assert.equal(regularRoad.remaining + regularRoad.used, 3);
  assert.equal(expandedRoad.remaining + expandedRoad.used, 6);
  assertConservation(input, regular);
  assertConservation(input, expanded, { roadCapacityScale: 2 });
});

test('inventoryScale changes usable stock without changing shelter demand', () => {
  const input = scenario({
    nodes: [node('depot', 'Depot', 'depot'), node('shelter-node', 'Shelter', 'shelter')],
    shelters: [shelter('shelter-1', 'shelter-node', 10)],
    roads: [road('route', 'depot', 'shelter-node', 5, 100)],
    inventory: [stock('water-1', 'depot', 8)],
  });

  const result = allocate(input, { equityFloor: 0, inventoryScale: 0.5 });
  const lot = byId(result.inventory, 'water-1');

  assert.equal(result.totals.demand, 10);
  assert.equal(result.totals.available, 4);
  assert.equal(result.totals.allocated, 4);
  assert.equal(result.totals.unmet, 6);
  assert.equal(lot.available, 4);
  assert.equal(lot.remaining, 0);
  assertConservation(input, result, { inventoryScale: 0.5 });
});

test('runs the equity phase before priority fill and marks the floor met', () => {
  const input = scenario({
    nodes: [
      node('depot', 'Depot', 'depot'),
      node('critical-node', 'Critical', 'shelter'),
      node('moderate-node', 'Moderate', 'shelter'),
    ],
    shelters: [
      shelter('critical-shelter', 'critical-node', 10, 'critical', 0.9),
      shelter('moderate-shelter', 'moderate-node', 10, 'moderate', 0.9),
    ],
    roads: [road('critical-route', 'depot', 'critical-node'), road('moderate-route', 'depot', 'moderate-node')],
    inventory: [stock('water-1', 'depot', 12)],
  });

  const result = allocate(input, { equityFloor: 0.4 });
  const critical = byId(result.shelters, 'critical-shelter');
  const moderate = byId(result.shelters, 'moderate-shelter');
  const equityAllocations = result.allocations.filter((allocation) => allocation.phase === 'equity');
  const priorityAllocations = result.allocations.filter((allocation) => allocation.phase === 'priority');

  assert.ok(equityAllocations.length >= 2, 'each reachable shelter should participate in equity allocation');
  assert.ok(critical.allocated.water >= 4);
  assert.ok(moderate.allocated.water >= 4);
  assert.equal(critical.equityMet, true);
  assert.equal(moderate.equityMet, true);
  assert.ok(priorityAllocations.length > 0, 'remaining stock should be filled by priority');
  const firstPriority = result.allocations.findIndex((allocation) => allocation.phase === 'priority');
  assert.ok(result.allocations.slice(0, firstPriority).every((allocation) => allocation.phase === 'equity'));
  assert.ok(result.allocations.slice(firstPriority).every((allocation) => allocation.phase === 'priority'));
  for (const destination of input.shelters) {
    assert.equal(
      equityAllocations
        .filter((allocation) => allocation.shelterId === destination.id)
        .reduce((total, allocation) => total + allocation.quantity, 0),
      destination.demand.water * 0.4,
    );
  }
  assert.equal(shelterWater(result, 'critical-shelter', 'allocated'), 8);
  assert.equal(shelterWater(result, 'moderate-shelter', 'allocated'), 4);
  assert.equal(result.totals.allocated, 12);
});

test('returns effective scaled capacities and computes partial utilization from them', () => {
  for (const roadCapacityScale of [0.5, 2]) {
    const input = simpleScenario();
    const options = { equityFloor: 0, roadCapacityScale };
    const result = allocate(input, options);
    const segment = byId(result.roads, 'route');

    assert.equal(segment.baseCapacity, 8);
    assert.equal(segment.capacity, 8 * roadCapacityScale);
    assert.equal(segment.used, Math.min(6, segment.capacity));
    assert.equal(segment.utilization, segment.used / segment.capacity);
    assert.equal(input.roads[0].capacity, 8);
    assertConservation(input, result, options);
  }
});

test('rejects unknown shelter demand resources even when their demand is zero', () => {
  for (const quantity of [0, 3]) {
    const input = simpleScenario();
    input.shelters[0].demand.watre = quantity;
    assert.throws(() => allocate(input), {
      name: 'TypeError',
      message: 'Unknown shelter demand resource: watre',
    });
  }
});

test('requires ISO datetimes with explicit timezones for asOf and inventory expiry', () => {
  const invalidTimestamps = [
    '2025-07-01',
    '2025-07-01T00:00:00',
    'July 1, 2025 00:00:00 GMT',
    '2025-07-01 00:00:00Z',
    '2025-07-01T00:00:00+25:00',
    '2025-13-01T00:00:00Z',
    'not-a-date',
    1751328000000,
    null,
  ];
  for (const value of invalidTimestamps) {
    for (const field of ['asOf', 'expiresAt']) {
      const input = simpleScenario();
      if (field === 'asOf') input.asOf = value;
      else input.inventory[0].expiresAt = value;
      assert.throws(() => allocate(input), {
        name: 'TypeError',
        message: new RegExp(`${field} must be an ISO datetime with an explicit Z or numeric offset`),
      });
    }
  }
});

test('compares explicit positive and negative offsets as absolute instants', () => {
  const input = simpleScenario();
  input.asOf = '2025-07-01T02:00:00+02:00';
  input.inventory = [
    stock('at-boundary', 'depot', 5, '2025-06-30T19:00:00-05:00'),
    stock('earlier-offset', 'depot', 2, '2025-06-30T19:30:00-05:00'),
    stock('later-utc', 'depot', 4, '2025-07-01T01:00:00Z'),
  ];
  const result = allocate(input, { equityFloor: 0 });

  assert.equal(byId(result.inventory, 'at-boundary').expired, true);
  assert.equal(byId(result.inventory, 'earlier-offset').allocated, 2);
  assert.equal(byId(result.inventory, 'later-utc').allocated, 4);
  assert.equal(result.totals.expired, 5);
  assertConservation(input, result);
});

for (const [collection, label] of [
  ['nodes', 'Node'],
  ['roads', 'Road'],
  ['shelters', 'Shelter'],
  ['inventory', 'Inventory'],
]) {
  test(`requires unique nonempty ${collection} IDs`, () => {
    for (const id of ['', '   ', '\t\n', null, undefined, 42]) {
      const input = simpleScenario();
      input[collection][0].id = id;
      assert.throws(() => allocate(input), {
        name: 'TypeError',
        message: `${label} IDs must be non-empty strings`,
      });
    }
    const input = simpleScenario();
    input[collection].push({ ...input[collection][0] });
    assert.throws(() => allocate(input), {
      name: 'TypeError',
      message: `${label} IDs must be unique`,
    });
  });
}

test('requires road endpoints to reference existing nodes, including closed roads', () => {
  for (const endpoint of ['from', 'to']) {
    for (const closed of [false, true]) {
      const input = simpleScenario();
      input.roads[0][endpoint] = 'missing-node';
      input.roads[0].closed = closed;
      assert.throws(() => allocate(input), {
        name: 'TypeError',
        message: 'Road route endpoints must reference existing nodes',
      });
    }
  }
});

test('requires shelters to reference an existing node of shelter type', () => {
  for (const nodeId of ['missing-node', 'depot', 'transfer-node']) {
    const input = simpleScenario();
    input.nodes.push(node('transfer-node', 'Transfer', 'transfer'));
    input.shelters[0].nodeId = nodeId;
    assert.throws(() => allocate(input), {
      name: 'TypeError',
      message: 'Shelter shelter-1 nodeId must reference an existing shelter node',
    });
  }
});

test('requires inventory to reference an existing depot, even for expired lots', () => {
  for (const depotId of ['missing-node', 'shelter-node', 'transfer-node']) {
    for (const expiresAt of [AS_OF, '2025-07-02T00:00:00Z']) {
      const input = simpleScenario();
      input.nodes.push(node('transfer-node', 'Transfer', 'transfer'));
      input.inventory[0].depotId = depotId;
      input.inventory[0].expiresAt = expiresAt;
      assert.throws(() => allocate(input), {
        name: 'TypeError',
        message: 'Inventory water-1 depotId must reference an existing depot node',
      });
    }
  }
});

test('reroutes the same lot after the shortest route saturates', () => {
  const input = scenario({
    nodes: [node('depot', 'Depot', 'depot'), node('hub', 'Hub', 'transfer'), node('destination', 'Shelter', 'shelter')],
    shelters: [shelter('shelter-1', 'destination', 7)],
    roads: [
      road('direct', 'depot', 'destination', 1, 3),
      road('detour-1', 'depot', 'hub', 2, 10),
      road('detour-2', 'hub', 'destination', 2, 10),
    ],
    inventory: [stock('water-1', 'depot', 10)],
  });
  const result = allocate(input, { equityFloor: 0 });

  assert.deepEqual(result.allocations.map(({ quantity, roadIds, minutes }) => ({ quantity, roadIds, minutes })), [
    { quantity: 3, roadIds: ['direct'], minutes: 1 },
    { quantity: 4, roadIds: ['detour-1', 'detour-2'], minutes: 4 },
  ]);
  assert.equal(byId(result.inventory, 'water-1').allocated, 7);
  assert.equal(result.totals.unmet, 0);
  assert.deepEqual(result.bottlenecks.map((segment) => segment.id), ['direct']);
  assertConservation(input, result);
});

test('repeated plans are deterministic and leave scenario and options unchanged', () => {
  const input = simpleScenario();
  input.roads = [
    road('z-route', 'depot', 'shelter-node', 5, 4),
    road('a-route', 'depot', 'shelter-node', 5, 4),
    road('closed-route', 'depot', 'shelter-node', 1, 100),
  ];
  input.inventory = [stock('z-lot', 'depot', 4), stock('a-lot', 'depot', 4)];
  const options = { inventoryScale: 0.75, roadCapacityScale: 0.5, equityFloor: 0.25, closedRoadIds: ['closed-route'] };
  const originalInput = structuredClone(input);
  const originalOptions = structuredClone(options);
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(input);
  freeze(options);

  const result = allocate(input, options);
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.deepEqual(allocate(input, options), result);
  }
  assert.deepEqual(input, originalInput);
  assert.deepEqual(options, originalOptions);
  assert.deepEqual(result.allocations[0].roadIds, ['a-route']);
  assert.equal(byId(result.inventory, 'a-lot').allocated, 3);
  assert.equal(byId(result.inventory, 'z-lot').allocated, 1);
  assertConservation(input, result, options);
});

test('honors explicit zero inventoryScale, roadCapacityScale, and equityFloor', () => {
  for (const control of ['inventoryScale', 'roadCapacityScale']) {
    const input = simpleScenario();
    const options = { [control]: 0 };
    const result = allocate(input, options);
    assert.equal(result.totals.allocated, 0);
    assert.equal(result.allocations.length, 0);
    assert.equal(result.totals.unmet, 6);
    if (control === 'inventoryScale') {
      assert.equal(result.totals.available, 0);
      assert.equal(result.shelters[0].reachable, true);
    } else {
      assert.equal(result.roads[0].capacity, 0);
      assert.equal(result.roads[0].utilization, 0);
      assert.equal(result.shelters[0].reachable, false);
    }
    assertConservation(input, result, options);
  }

  const input = simpleScenario();
  const result = allocate(input, { equityFloor: 0 });
  assert.equal(result.totals.allocated, 6);
  assert.ok(result.allocations.every((allocation) => allocation.phase === 'priority'));
  assert.equal(result.shelters[0].equityMet, true);
  assertConservation(input, result);
});

test('conserves scaled capacity with closed roads, zero capacity, and zero demand', () => {
  const input = simpleScenario();
  input.shelters[0].demand.water = 0;
  input.nodes.push(node('empty-node', 'Empty', 'shelter'));
  input.shelters.push({ ...shelter('empty-shelter', 'empty-node', 0), demand: {} });
  input.roads.push(
    road('closed', 'depot', 'shelter-node', 1, 10, true),
    road('closed-by-option', 'depot', 'shelter-node', 1, 10),
    road('zero-capacity', 'depot', 'empty-node', 1, 0),
  );
  const options = { roadCapacityScale: 2, closedRoadIds: ['closed-by-option'] };
  const result = allocate(input, options);

  assert.equal(result.totals.demand, 0);
  assert.equal(result.totals.coverage, 1);
  assert.equal(result.allocations.length, 0);
  assert.ok(result.shelters.every((destination) => destination.coverage === 1 && destination.equityMet));
  assert.deepEqual(result.bottlenecks.map((segment) => segment.id), ['zero-capacity']);
  assertConservation(input, result, options);
});
