// Entirely synthetic, deterministic rasters: no files or services are fetched.
// Values are normalized proxies, not calibrated reflectance or temperatures.
export const STUDIO_TODAY = '2025-06-18T12:00:00Z';
export const STALE_DAYS = 14;
const WIDTH = 96;
const hash = (x, y) => {
  const value = Math.sin(x * 127.1 + y * 311.7 + 19.3) * 43758.5453;
  return value - Math.floor(value);
};
const riverCenter = y => 43 + Math.sin(y / 17) * 11 + Math.sin(y / 7) * 3;

function createTile(id, date, epoch, scenario) {
  const tile = { id, date, width: WIDTH, height: WIDTH, crs: 'LOCAL-SYNTHETIC', origin: [0, 960], resolution: [10, -10], infrared: [], visible: [], rgb: [], cloud: [], nodata: [], confidence: [] };
  for (let y = 0; y < WIDTH; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const fine = hash(x, y), coarse = hash(Math.floor(x / 12), Math.floor(y / 14));
      const distance = Math.abs(x - riverCenter(y));
      const flood = scenario === 'flood' && epoch === 1 && y > 40 && y < 80;
      const water = distance < (flood ? 12 : 4.5);
      const shore = !water && distance < (flood ? 14 : 6);
      const forest = x < riverCenter(y) - 7 && (y < 58 || x < 22);
      const town = x > 67 && x < 88 && y > 14 && y < 41;
      const newTown = scenario === 'urban' && epoch === 1 && x > 64 && x < 89 && y > 42 && y < 62;
      const road = (Math.abs(x - (73 - y * .23)) < 1.2 || (y > 69 && y < 71)) && !water;
      let ir, visible, rgb;
      if (water) { ir = .10 + fine * .035; visible = .21 + fine * .05; rgb = [36 + fine * 12, 80 + fine * 13, 85 + fine * 18]; }
      else if (shore) { ir = .26 + fine * .07; visible = .40 + fine * .06; rgb = [135 + fine * 20, 138 + fine * 15, 100 + fine * 13]; }
      else if (town || newTown || road) {
        const roof = (x % 4 < 2 && y % 4 < 2) && !road;
        ir = (roof ? .30 : .22) + fine * .05; visible = (roof ? .66 : .48) + fine * .07;
        rgb = roof ? [177 + fine * 30, 165 + fine * 25, 144 + fine * 30] : [114 + fine * 18, 117 + fine * 18, 104 + fine * 14];
      } else if (forest) { ir = .68 + fine * .15; visible = .27 + fine * .08; rgb = [40 + fine * 28, 67 + fine * 35, 37 + fine * 21]; }
      else {
        const field = hash(Math.floor(x / 13), Math.floor(y / 16));
        const boundary = x % 13 === 0 || y % 16 === 0;
        const stripe = (x + y) % 3 === 0 ? -.025 : 0;
        ir = (boundary ? .43 : .52 + field * .28) + fine * .04 + stripe;
        visible = .40 + field * .16 + fine * .04;
        rgb = [103 + field * 59 + fine * 10, 112 + field * 39 + fine * 14, 58 + field * 24 + fine * 8];
        if (boundary) rgb = [72, 84, 50];
      }
      // Different masks at each epoch ensure their union is really used.
      const cloud = epoch === 1 && (scenario === 'archive' ? ((x - 60) ** 2 / 400 + (y - 30) ** 2 / 210 < 1) : ((x - 77) ** 2 / 65 + (y - 75) ** 2 / 48 < 1));
      const nodata = x < 2 || y < 2 || x >= WIDTH - 2 || y >= WIDTH - 2 || (epoch === 1 && x === 2 && y > 80);
      const low = distance < 8 || (x > 53 && x < 62 && y > 28 && y < 54);
      tile.infrared.push(Math.max(0, Math.min(1, ir + (epoch === 1 ? .004 : 0))));
      tile.visible.push(Math.max(0, Math.min(1, visible + (epoch === 1 ? .003 : 0))));
      tile.rgb.push(rgb.map(Math.round));
      tile.cloud.push(cloud); tile.nodata.push(nodata);
      tile.confidence.push(nodata ? 0 : cloud ? .18 : low ? .48 + fine * .14 : .86 + coarse * .1);
    }
  }
  return tile;
}
function fixture(key, name, scenario, beforeDate, afterDate) {
  return { key, name, shortName: name.split(' / ')[0], location: 'LOCAL GRID · 960 × 960 m', pixelSize: '10 m', before: createTile(`${key}-before`, beforeDate, 0, scenario), after: createTile(`${key}-after`, afterDate, 1, scenario) };
}
export const FIXTURES = {
  'river-bend': fixture('river-bend', 'River bend / flood pulse', 'flood', '2025-06-06T09:20:00Z', '2025-06-18T09:20:00Z'),
  'new-block': fixture('new-block', 'New block / urban expansion', 'urban', '2025-06-08T09:20:00Z', '2025-06-17T09:20:00Z'),
  'archive-haze': fixture('archive-haze', 'Archive haze / stale control', 'archive', '2025-05-01T09:20:00Z', '2025-05-03T09:20:00Z')
};
export function bandTile(tile, band) {
  if (band !== 'infrared' && band !== 'visible') throw new Error('Unknown band');
  return { ...tile, values: tile[band] };
}
