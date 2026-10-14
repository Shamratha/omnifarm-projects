// Synthetic planning snapshot; quantities and road capacities are shared units.
export const scenario = {
  asOf: '2026-10-14T09:00:00Z',
  region: 'Riverbend County',
  resources: [
    { id: 'water', name: 'Drinking water', unit: 'liters' },
    { id: 'food', name: 'Meal kits', unit: 'kits' },
    { id: 'medical', name: 'Medical supplies', unit: 'kits' },
  ],
  nodes: [
    { id: 'west-depot', name: 'West Logistics Depot', x: 12, y: 48, type: 'depot' },
    { id: 'east-depot', name: 'East Relief Depot', x: 88, y: 52, type: 'depot' },
    { id: 'west-junction', name: 'West Interchange', x: 30, y: 48, type: 'junction' },
    { id: 'east-junction', name: 'East Interchange', x: 70, y: 48, type: 'junction' },
    { id: 'north-junction', name: 'North Bridge', x: 50, y: 22, type: 'junction' },
    { id: 'south-junction', name: 'South Bypass', x: 50, y: 78, type: 'junction' },
    { id: 'riverside-node', name: 'Riverside School', x: 43, y: 43, type: 'shelter' },
    { id: 'north-node', name: 'North Community Hall', x: 47, y: 8, type: 'shelter' },
    { id: 'east-node', name: 'Eastside Cooling Center', x: 89, y: 28, type: 'shelter' },
    { id: 'south-node', name: 'South Sports Center', x: 53, y: 94, type: 'shelter' },
    { id: 'hill-node', name: 'Hilltop Library', x: 13, y: 20, type: 'shelter' },
  ],
  shelters: [
    {
      id: 'riverside', nodeId: 'riverside-node', name: 'Riverside School',
      area: 'River floodplain', population: 320, priority: 'critical', vulnerability: 0.96,
      demand: { water: 960, food: 320, medical: 60 },
    },
    {
      id: 'north-hall', nodeId: 'north-node', name: 'North Community Hall',
      area: 'Northbank', population: 240, priority: 'high', vulnerability: 0.82,
      demand: { water: 720, food: 240, medical: 45 },
    },
    {
      id: 'east-cooling', nodeId: 'east-node', name: 'Eastside Cooling Center',
      area: 'Eastside', population: 180, priority: 'critical', vulnerability: 0.9,
      demand: { water: 540, food: 180, medical: 32 },
    },
    {
      id: 'south-center', nodeId: 'south-node', name: 'South Sports Center',
      area: 'Southbank', population: 220, priority: 'high', vulnerability: 0.68,
      demand: { water: 660, food: 220, medical: 40 },
    },
    {
      id: 'hilltop', nodeId: 'hill-node', name: 'Hilltop Library',
      area: 'Western hills', population: 160, priority: 'moderate', vulnerability: 0.55,
      demand: { water: 480, food: 160, medical: 25 },
    },
  ],
  // Roads are two-way. Riverside's access road is the main baseline bottleneck.
  roads: [
    { id: 'west-feed', from: 'west-depot', to: 'west-junction', name: 'West Supply Road', minutes: 5, capacity: 3000, closed: false },
    { id: 'east-feed', from: 'east-depot', to: 'east-junction', name: 'East Supply Road', minutes: 5, capacity: 2400, closed: false },
    { id: 'river-crossing', from: 'west-junction', to: 'east-junction', name: 'River Road Bridge', minutes: 6, capacity: 2000, closed: true, reason: 'Floodwater overtopping the bridge deck' },
    { id: 'west-north', from: 'west-junction', to: 'north-junction', name: 'Northbank Approach', minutes: 9, capacity: 2200, closed: false },
    { id: 'north-east', from: 'north-junction', to: 'east-junction', name: 'North Bridge Crossing', minutes: 10, capacity: 2200, closed: false },
    { id: 'west-south', from: 'west-junction', to: 'south-junction', name: 'West Bypass', minutes: 12, capacity: 1800, closed: false },
    { id: 'south-east', from: 'south-junction', to: 'east-junction', name: 'East Bypass', minutes: 12, capacity: 1800, closed: false },
    { id: 'riverside-access', from: 'west-junction', to: 'riverside-node', name: 'Riverside Raised Access', minutes: 7, capacity: 620, closed: false },
    { id: 'north-access', from: 'north-junction', to: 'north-node', name: 'Community Hall Lane', minutes: 4, capacity: 1100, closed: false },
    { id: 'east-access', from: 'east-junction', to: 'east-node', name: 'Cooling Center Avenue', minutes: 6, capacity: 900, closed: false },
    { id: 'south-access', from: 'south-junction', to: 'south-node', name: 'Sports Center Drive', minutes: 5, capacity: 1000, closed: false },
    { id: 'hill-access', from: 'west-depot', to: 'hill-node', name: 'Hilltop Switchback', minutes: 8, capacity: 450, closed: false },
  ],
  inventory: [
    { id: 'west-water', depotId: 'west-depot', resource: 'water', quantity: 2100, expiresAt: '2026-10-15T09:00:00Z' },
    { id: 'east-water', depotId: 'east-depot', resource: 'water', quantity: 1400, expiresAt: '2026-10-17T09:00:00Z' },
    { id: 'west-food', depotId: 'west-depot', resource: 'food', quantity: 700, expiresAt: '2026-10-14T18:00:00Z' },
    { id: 'east-food', depotId: 'east-depot', resource: 'food', quantity: 500, expiresAt: '2026-10-16T09:00:00Z' },
    { id: 'west-medical', depotId: 'west-depot', resource: 'medical', quantity: 100, expiresAt: '2026-10-16T09:00:00Z' },
    { id: 'east-medical', depotId: 'east-depot', resource: 'medical', quantity: 80, expiresAt: '2026-10-18T09:00:00Z' },
    { id: 'expired-water', depotId: 'west-depot', resource: 'water', quantity: 240, expiresAt: '2026-10-14T08:00:00Z' },
    { id: 'expired-food', depotId: 'east-depot', resource: 'food', quantity: 80, expiresAt: '2026-10-13T18:00:00Z' },
    { id: 'expired-medical', depotId: 'west-depot', resource: 'medical', quantity: 15, expiresAt: '2026-10-12T09:00:00Z' },
  ],
  alerts: [
    {
      id: 'flood-warning', title: 'River flood warning', severity: 'critical',
      description: 'Overnight rainfall has closed River Road Bridge. Riverside access is restricted to the raised single-lane road.',
      area: 'River floodplain and Northbank',
    },
    {
      id: 'heat-warning', title: 'Extreme heat advisory', severity: 'high',
      description: 'Afternoon temperatures near 39°C increase drinking-water and medical needs, especially at Eastside Cooling Center.',
      area: 'Eastside and Southbank',
    },
  ],
};
