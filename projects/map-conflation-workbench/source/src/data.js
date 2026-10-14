export const sourceMeta = {
  primary: {
    id: 'primary',
    label: 'City streets · 2024',
    shortLabel: 'City streets',
    date: '2024-06-18',
    color: '#147d92',
    description: 'Municipal centerline extract'
  },
  secondary: {
    id: 'secondary',
    label: 'Open map · 2025',
    shortLabel: 'Open map',
    date: '2025-02-03',
    color: '#db6c42',
    description: 'Community-maintained extract'
  }
};

// A small, deterministic fixture: coordinates are in a local schematic projection,
// not lat/lon. This keeps the workbench completely offline and repeatable.
export const features = [
  {
    id: 'city-way-1842', source: 'primary', type: 'way', name: 'Juniper Avenue',
    tags: { highway: 'residential', name: 'Juniper Avenue', surface: 'asphalt', lanes: '2' },
    geometry: [[90, 98], [250, 110], [418, 105], [580, 116]],
    updated: '2024-06-18'
  },
  {
    id: 'open-way-771', source: 'secondary', type: 'way', name: 'Juniper Ave',
    tags: { highway: 'residential', name: 'Juniper Ave', surface: 'asphalt' },
    geometry: [[92, 101], [252, 114], [420, 109], [578, 120]],
    updated: '2025-02-03'
  },
  {
    id: 'city-way-1843', source: 'primary', type: 'way', name: 'Juniper Avenue',
    tags: { highway: 'residential', name: 'Juniper Avenue', surface: 'asphalt', lanes: '2' },
    geometry: [[92, 155], [250, 150], [415, 160], [580, 154]],
    updated: '2024-06-18'
  },
  {
    id: 'open-way-772', source: 'secondary', type: 'way', name: 'Juniper Avenue',
    tags: { highway: 'residential', name: 'Juniper Avenue', surface: 'gravel' },
    geometry: [[90, 159], [252, 154], [414, 164], [580, 158]],
    updated: '2025-02-03'
  },
  {
    id: 'city-way-1901', source: 'primary', type: 'way', name: 'Market Street',
    tags: { highway: 'tertiary', name: 'Market Street', oneway: 'no' },
    geometry: [[113, 220], [245, 280], [370, 338], [500, 393]],
    updated: '2024-05-22'
  },
  {
    id: 'open-way-801', source: 'secondary', type: 'way', name: 'Market St',
    tags: { highway: 'tertiary', name: 'Market St', oneway: 'yes' },
    geometry: [[118, 223], [247, 282], [373, 340], [505, 401]],
    updated: '2025-01-12'
  },
  {
    id: 'city-way-2110', source: 'primary', type: 'way', name: 'Harbor Road',
    tags: { highway: 'secondary', name: 'Harbor Road', maxspeed: '35' },
    geometry: [[535, 74], [535, 170], [536, 282], [539, 420]],
    updated: '2024-03-09'
  },
  {
    id: 'open-way-929', source: 'secondary', type: 'way', name: 'Harbor Road',
    tags: { highway: 'secondary', name: 'Harbor Road', maxspeed: '25' },
    geometry: [[548, 75], [547, 171], [550, 284], [552, 423]],
    updated: '2025-02-03'
  },
  {
    id: 'city-way-2204', source: 'primary', type: 'way', name: 'Oak Boulevard',
    tags: { highway: 'primary', name: 'Oak Boulevard', lanes: '4', bridge: 'yes' },
    geometry: [[80, 440], [195, 416], [320, 402], [470, 418], [620, 454]],
    updated: '2024-01-14'
  },
  {
    id: 'open-way-977', source: 'secondary', type: 'way', name: 'Oak Boulevard',
    tags: { highway: 'primary', name: 'Oak Boulevard', lanes: '2' },
    geometry: [[80, 446], [195, 422], [320, 408], [470, 424], [620, 460]],
    updated: '2025-01-27'
  },
  {
    id: 'city-way-2320', source: 'primary', type: 'way', name: 'Pine Street',
    tags: { highway: 'residential', name: 'Pine Street', lit: 'yes' },
    geometry: [[165, 45], [165, 125]],
    updated: '2024-04-01'
  },
  {
    id: 'open-way-1001', source: 'secondary', type: 'way', name: 'Pine Street',
    tags: { highway: 'residential', name: 'Pine Street', lit: 'yes' },
    geometry: [[206, 45], [207, 125]],
    updated: '2025-01-27'
  },
  {
    id: 'city-way-2410', source: 'primary', type: 'way', name: 'Cedar Lane',
    tags: { highway: 'service', name: 'Cedar Lane', access: 'private' },
    geometry: [[665, 145], [720, 145], [760, 195]],
    updated: '2024-02-12'
  },
  {
    id: 'open-way-1092', source: 'secondary', type: 'way', name: 'Cedar Lane',
    tags: { highway: 'service', name: 'Cedar Lane', access: 'no' },
    geometry: [[688, 148], [735, 148], [775, 198]],
    updated: '2025-01-10'
  },
  // Split-way fixture: two secondary ways correspond to one primary way.
  {
    id: 'city-way-2515', source: 'primary', type: 'way', name: 'River Walk',
    tags: { highway: 'footway', name: 'River Walk', surface: 'paved' },
    geometry: [[95, 520], [250, 520], [410, 520], [625, 520]],
    updated: '2024-02-18'
  },
  {
    id: 'open-way-1208a', source: 'secondary', type: 'way', name: 'River Walk',
    tags: { highway: 'footway', name: 'River Walk', surface: 'paved' },
    geometry: [[97, 523], [250, 523], [410, 523]],
    updated: '2025-02-03'
  },
  {
    id: 'open-way-1208b', source: 'secondary', type: 'way', name: 'River Walk',
    tags: { highway: 'footway', name: 'River Walk', surface: 'paved' },
    geometry: [[410, 523], [625, 523]],
    updated: '2025-02-03'
  }
];

export const mapLabels = [
  { text: 'NORTH DISTRICT', x: 96, y: 70 },
  { text: 'MARKET QUARTER', x: 248, y: 250 },
  { text: 'RIVERFRONT', x: 388, y: 570 }
];
