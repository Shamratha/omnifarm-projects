const PRIORITY = { critical: 0, high: 1, moderate: 2 };
const compareId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function nonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}

function timestamp(value, name) {
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const result = typeof value === 'string' && isoDateTime.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) throw new TypeError(`${name} must be an ISO datetime with an explicit Z or numeric offset`);
  return result;
}

function validateIds(items, label) {
  if (!Array.isArray(items)) throw new TypeError(`${label} must be an array`);
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new TypeError(`${label} IDs must be non-empty strings`);
    }
    if (ids.has(item.id)) throw new TypeError(`${label} IDs must be unique`);
    ids.add(item.id);
  }
  return ids;
}

function sum(values) {
  return nonNegative(values.reduce((total, value) => total + value, 0), 'Total');
}

function comparePaths(a, b) {
  if (a.minutes !== b.minutes) return a.minutes - b.minutes;
  for (let i = 0; i < Math.min(a.roadIds.length, b.roadIds.length); i += 1) {
    const comparison = compareId(a.roadIds[i], b.roadIds[i]);
    if (comparison) return comparison;
  }
  return a.roadIds.length - b.roadIds.length || compareId(a.nodeId, b.nodeId);
}

// Dijkstra on the residual, bidirectional network. Road IDs break route ties.
// Settled nodes prevent cycles even when a road has zero travel time.
function shortestPath(graph, from, to) {
  if (!graph.has(from) || !graph.has(to)) return null;
  const first = { nodeId: from, minutes: 0, roadIds: [], roads: [] };
  const best = new Map([[from, first]]);
  const settled = new Set();
  const queue = [first];
  while (queue.length) {
    queue.sort(comparePaths);
    const current = queue.shift();
    if (settled.has(current.nodeId) || best.get(current.nodeId) !== current) continue;
    settled.add(current.nodeId);
    if (current.nodeId === to) return current;
    for (const { nodeId, road } of graph.get(current.nodeId)) {
      if (road.closed || road.remaining <= 0 || settled.has(nodeId)) continue;
      const candidate = {
        nodeId,
        minutes: nonNegative(current.minutes + road.minutes, 'Route minutes'),
        roadIds: [...current.roadIds, road.id],
        roads: [...current.roads, road],
      };
      if (!best.has(nodeId) || comparePaths(candidate, best.get(nodeId)) < 0) {
        best.set(nodeId, candidate);
        queue.push(candidate);
      }
    }
  }
  return null;
}

/**
 * Greedy planning: equity targets per resource, then priority-ranked unmet need.
 * Each phase visits shelters before resources; lots are used earliest-expiry first.
 * Quantities are divisible, and every delivered unit consumes one capacity unit
 * on every route road, regardless of resource. Inputs are never mutated.
 */
export function allocate(scenario, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new TypeError('scenario must be an object');
  }
  const inventoryScale = nonNegative(options.inventoryScale === undefined ? 1 : options.inventoryScale, 'inventoryScale');
  const roadCapacityScale = nonNegative(options.roadCapacityScale === undefined ? 1 : options.roadCapacityScale, 'roadCapacityScale');
  const equityFloor = nonNegative(options.equityFloor === undefined ? 0.4 : options.equityFloor, 'equityFloor');
  if (equityFloor > 1) throw new RangeError('equityFloor must be between 0 and 1');
  const closedRoadIds = options.closedRoadIds === undefined ? [] : options.closedRoadIds;
  if (!Array.isArray(closedRoadIds) || closedRoadIds.some(id => typeof id !== 'string')) {
    throw new TypeError('closedRoadIds must be an array of road IDs');
  }
  const closedIds = new Set(closedRoadIds);
  const asOf = timestamp(scenario.asOf, 'asOf');
  const nodeIds = validateIds(scenario.nodes, 'Node');
  validateIds(scenario.roads, 'Road');
  validateIds(scenario.shelters, 'Shelter');
  validateIds(scenario.inventory, 'Inventory');
  const resourceIds = scenario.resources.map(resource => resource.id);
  const resourceSet = new Set(resourceIds);
  if (resourceSet.size !== resourceIds.length) throw new TypeError('Resource IDs must be unique');
  const nodesById = new Map(scenario.nodes.map(node => [node.id, node]));
  for (const road of scenario.roads) {
    if (!nodeIds.has(road.from) || !nodeIds.has(road.to)) {
      throw new TypeError(`Road ${road.id} endpoints must reference existing nodes`);
    }
  }
  for (const shelter of scenario.shelters) {
    const shelterNode = nodesById.get(shelter.nodeId);
    if (!shelterNode || shelterNode.type !== 'shelter') {
      throw new TypeError(`Shelter ${shelter.id} nodeId must reference an existing shelter node`);
    }
    const demand = shelter.demand === undefined || shelter.demand === null ? {} : shelter.demand;
    if (typeof demand !== 'object' || Array.isArray(demand)) {
      throw new TypeError(`Shelter ${shelter.id} demand must be an object`);
    }
    for (const resource of Object.keys(demand)) {
      if (!resourceSet.has(resource)) throw new TypeError(`Unknown shelter demand resource: ${resource}`);
    }
  }
  for (const lot of scenario.inventory) {
    const depot = nodesById.get(lot.depotId);
    if (!depot || depot.type !== 'depot') {
      throw new TypeError(`Inventory ${lot.id} depotId must reference an existing depot node`);
    }
  }
  const zeros = () => Object.fromEntries(resourceIds.map(id => [id, 0]));
  const decisions = [
    `Plan as of ${scenario.asOf}: inventory scale ${inventoryScale}, road capacity scale ${roadCapacityScale}, equity floor ${equityFloor * 100}%.`,
    'Roads are bidirectional; all resources share road capacity, one unit per delivered unit on each road.',
    'Equity phase visits shelters by vulnerability then ID; priority phase uses critical, high, moderate, then vulnerability and ID. Resources follow scenario order.',
    'Inventory lots use earliest expiry then ID; each lot uses its shortest currently feasible route, with road IDs breaking ties.',
  ];
  const roads = scenario.roads.map(road => {
    nonNegative(road.minutes, `Road ${road.id} minutes`);
    const baseCapacity = nonNegative(road.capacity, `Road ${road.id} capacity`);
    const capacity = nonNegative(baseCapacity * roadCapacityScale, `Road ${road.id} scaled capacity`);
    const closed = Boolean(road.closed || closedIds.has(road.id));
    return { ...road, baseCapacity, capacity, used: 0, remaining: closed ? 0 : capacity, utilization: 0, closed };
  });
  const graph = new Map(scenario.nodes.map(node => [node.id, []]));
  for (const road of roads) {
    graph.get(road.from).push({ nodeId: road.to, road });
    graph.get(road.to).push({ nodeId: road.from, road });
    if (road.closed) decisions.push(`Closed road excluded: ${road.name ?? road.id} (${road.id})${road.reason ? ` — ${road.reason}` : ''}.`);
  }
  const inventory = scenario.inventory.map(lot => {
    if (!resourceSet.has(lot.resource)) throw new TypeError(`Unknown inventory resource: ${lot.resource}`);
    const expires = timestamp(lot.expiresAt, `Inventory ${lot.id} expiresAt`);
    const quantity = nonNegative(nonNegative(lot.quantity, `Inventory ${lot.id} quantity`) * inventoryScale, `Inventory ${lot.id} scaled quantity`);
    const expired = expires <= asOf;
    if (expired) decisions.push(`Expired lot excluded: ${lot.id} (${quantity} ${lot.resource}; expired ${lot.expiresAt}).`);
    return { ...lot, available: expired ? 0 : quantity, allocated: 0, remaining: expired ? 0 : quantity, expired };
  });
  const lotsByResource = new Map(resourceIds.map(resource => [resource, inventory
    .filter(lot => lot.resource === resource && !lot.expired)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || compareId(a.id, b.id))]));
  const depots = scenario.nodes.filter(node => node.type === 'depot');
  const shelters = scenario.shelters.map(shelter => {
    const vulnerability = nonNegative(shelter.vulnerability, `Shelter ${shelter.id} vulnerability`);
    if (vulnerability > 1) throw new RangeError(`Shelter ${shelter.id} vulnerability must be at most 1`);
    if (!Object.hasOwn(PRIORITY, shelter.priority)) throw new TypeError(`Unknown shelter priority: ${shelter.priority}`);
    const unmet = Object.fromEntries(resourceIds.map(resource => [resource,
      nonNegative(shelter.demand?.[resource] ?? 0, `Shelter ${shelter.id} ${resource} demand`),
    ]));
    // Reachability describes the initial open positive-capacity network, not stock.
    const reachable = depots.some(depot => shortestPath(graph, depot.id, shelter.nodeId) !== null);
    if (!reachable) decisions.push(`Shelter ${shelter.id} is disconnected from all depots on the open positive-capacity network.`);
    return { ...shelter, allocated: zeros(), unmet, coverage: 0, equityMet: false, reachable };
  });
  const allocations = [];
  const byVulnerability = (a, b) => b.vulnerability - a.vulnerability || compareId(a.id, b.id);
  const equityOrder = [...shelters].sort(byVulnerability);
  const priorityOrder = [...shelters].sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || byVulnerability(a, b));

  function deliver(shelter, resource, target, phase) {
    let needed = Math.max(0, target - shelter.allocated[resource]);
    for (const lot of lotsByResource.get(resource)) {
      // Recompute after saturation so the next shipment can use an alternate path.
      while (needed > 0 && lot.remaining > 0) {
        const path = shortestPath(graph, lot.depotId, shelter.nodeId);
        if (!path) break;
        const quantity = Math.min(needed, lot.remaining, ...path.roads.map(road => road.remaining));
        if (quantity <= 0) break;
        lot.remaining = Math.max(0, lot.remaining - quantity);
        lot.allocated += quantity;
        for (const road of path.roads) {
          road.remaining = Math.max(0, road.remaining - quantity);
          road.used += quantity;
        }
        shelter.allocated[resource] += quantity;
        shelter.unmet[resource] = Math.max(0, shelter.unmet[resource] - quantity);
        needed = Math.max(0, needed - quantity);
        allocations.push({ shelterId: shelter.id, resource, quantity, depotId: lot.depotId, roadIds: path.roadIds, minutes: path.minutes, phase });
      }
      if (needed <= 0) break;
    }
  }

  for (const shelter of equityOrder) {
    for (const resource of resourceIds) {
      deliver(shelter, resource, (shelter.demand?.[resource] ?? 0) * equityFloor, 'equity');
    }
  }
  for (const shelter of priorityOrder) {
    for (const resource of resourceIds) {
      deliver(shelter, resource, shelter.demand?.[resource] ?? 0, 'priority');
    }
  }

  // Coverage is total delivered / total demand; equity requires each resource floor.
  const tolerance = value => Number.EPSILON * 16 * Math.max(1, value);
  for (const shelter of shelters) {
    const demand = sum(resourceIds.map(resource => shelter.demand?.[resource] ?? 0));
    const delivered = sum(Object.values(shelter.allocated));
    shelter.coverage = demand === 0 ? 1 : Math.min(1, delivered / demand);
    shelter.equityMet = resourceIds.every(resource => {
      const target = (shelter.demand?.[resource] ?? 0) * equityFloor;
      return shelter.allocated[resource] + tolerance(target) >= target;
    });
    decisions.push(`${shelter.name ?? shelter.id}: ${(shelter.coverage * 100).toFixed(1)}% coverage; equity floor ${shelter.equityMet ? 'met' : 'not met'}; ${sum(Object.values(shelter.unmet))} units unmet.`);
  }
  for (const road of roads) {
    road.utilization = road.capacity === 0 ? 0 : Math.min(1, road.used / road.capacity);
  }
  // Saturated open roads (including zero-capacity roads) are reported for overlays.
  const bottlenecks = roads.filter(road => !road.closed && road.remaining === 0);
  for (const road of bottlenecks) decisions.push(`Bottleneck: ${road.name ?? road.id} (${road.id}); ${road.used} shared units used, no capacity remaining.`);
  const demand = sum(shelters.flatMap(shelter => resourceIds.map(resource => shelter.demand?.[resource] ?? 0)));
  const allocated = sum(allocations.map(allocation => allocation.quantity));
  const totals = {
    demand,
    allocated,
    unmet: sum(shelters.flatMap(shelter => Object.values(shelter.unmet))),
    coverage: demand === 0 ? 1 : Math.min(1, allocated / demand),
    expired: sum(inventory.filter(lot => lot.expired).map(lot => lot.quantity * inventoryScale)),
    available: sum(inventory.map(lot => lot.available)),
  };
  decisions.push(`Allocated ${totals.allocated} of ${totals.demand} demanded units from ${totals.available} usable inventory units; ${totals.expired} expired units excluded.`);
  return { allocations, shelters, inventory, roads, totals, bottlenecks, decisions };
}
