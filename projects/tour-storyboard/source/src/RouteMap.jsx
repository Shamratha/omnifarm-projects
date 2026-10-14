import React, { useMemo } from 'react';
import { landmarks } from './data';

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 620;
const MIN_LNG = 2.315;
const MAX_LNG = 2.365;
const MIN_LAT = 48.844;
const MAX_LAT = 48.876;

const streets = [
  { d: 'M 22 532 C 152 490, 246 457, 357 420 S 593 365, 989 292', major: true },
  { d: 'M -16 439 C 175 411, 345 366, 506 313 S 802 212, 1012 185', major: true },
  { d: 'M 12 583 C 158 535, 277 513, 400 478 S 672 395, 1008 346', major: true },
  { d: 'M 116 -14 C 161 109, 205 215, 276 317 S 392 497, 460 654', major: true },
  { d: 'M 232 -12 C 252 114, 305 235, 369 342 S 492 525, 531 651', major: true },
  { d: 'M 431 -17 C 421 117, 452 251, 509 354 S 626 533, 657 647', major: true },
  { d: 'M 613 -20 C 580 103, 591 212, 638 319 S 764 510, 803 648', major: true },
  { d: 'M 808 -16 C 731 108, 722 221, 768 330 S 893 517, 967 646', major: true },
  { d: 'M -20 115 C 160 149, 324 170, 476 165 S 776 103, 1020 68' },
  { d: 'M -12 228 C 165 251, 331 254, 501 228 S 796 157, 1015 142' },
  { d: 'M -8 300 C 164 330, 315 326, 481 297 S 790 230, 1012 214' },
  { d: 'M -15 365 C 158 383, 322 382, 468 354 S 761 288, 1011 266' },
  { d: 'M -5 503 C 137 482, 258 447, 374 406 S 657 322, 1008 251' },
  { d: 'M 61 644 C 130 524, 179 413, 191 317 S 189 110, 180 -15' },
  { d: 'M 327 643 C 340 520, 344 425, 331 327 S 312 111, 340 -16' },
  { d: 'M 551 646 C 549 518, 533 433, 549 337 S 620 116, 694 -17' },
  { d: 'M 720 647 C 685 527, 672 421, 701 334 S 818 119, 887 -13' },
  { d: 'M 923 647 C 858 527, 835 430, 861 346 S 959 179, 1032 80' },
  { d: 'M 91 75 L 925 474' },
  { d: 'M 44 193 C 269 152, 463 174, 625 230 S 863 341, 1028 372' },
  { d: 'M 24 260 C 218 209, 411 215, 584 275 S 828 413, 1010 450' },
  { d: 'M 145 626 C 269 491, 395 397, 549 323 S 819 200, 992 169' },
  { d: 'M 222 648 C 344 512, 445 445, 590 375 S 852 252, 1010 231' },
  { d: 'M 385 643 C 448 508, 531 433, 654 371 S 888 299, 1012 304' },
];

const blocks = [
  'M 24 81 L 113 92 L 132 171 L 44 184 Z',
  'M 141 101 L 222 108 L 232 180 L 151 183 Z',
  'M 252 77 L 333 67 L 361 144 L 264 166 Z',
  'M 367 62 L 450 52 L 477 135 L 380 148 Z',
  'M 496 43 L 587 31 L 612 119 L 514 133 Z',
  'M 637 32 L 727 18 L 754 93 L 648 116 Z',
  'M 788 17 L 884 7 L 913 76 L 806 94 Z',
  'M 924 7 L 1014 4 L 1017 89 L 945 78 Z',
  'M 1 205 L 92 194 L 118 276 L 10 297 Z',
  'M 128 198 L 215 190 L 244 268 L 143 279 Z',
  'M 257 185 L 346 176 L 374 253 L 272 268 Z',
  'M 389 169 L 478 154 L 511 239 L 402 253 Z',
  'M 524 148 L 611 131 L 652 218 L 545 238 Z',
  'M 673 122 L 769 102 L 801 187 L 696 207 Z',
  'M 817 102 L 921 84 L 954 169 L 845 190 Z',
  'M 957 101 L 1020 92 L 1022 183 L 984 172 Z',
  'M 2 317 L 101 300 L 124 375 L 10 402 Z',
  'M 142 294 L 238 281 L 268 358 L 161 378 Z',
  'M 283 282 L 377 267 L 408 341 L 308 360 Z',
  'M 423 266 L 520 250 L 553 327 L 447 345 Z',
  'M 569 241 L 662 220 L 701 298 L 596 320 Z',
  'M 718 210 L 814 194 L 855 274 L 753 295 Z',
  'M 872 195 L 971 177 L 1013 247 L 906 269 Z',
  'M 26 423 L 112 405 L 146 477 L 46 502 Z',
  'M 167 395 L 263 374 L 302 447 L 198 475 Z',
  'M 316 369 L 419 350 L 461 422 L 349 450 Z',
  'M 473 350 L 572 328 L 617 396 L 508 423 Z',
  'M 629 323 L 728 297 L 775 367 L 663 394 Z',
  'M 786 292 L 891 272 L 943 338 L 837 365 Z',
  'M 19 527 L 124 492 L 169 563 L 51 603 Z',
  'M 195 486 L 294 458 L 345 526 L 235 566 Z',
  'M 365 452 L 470 429 L 518 491 L 407 525 Z',
  'M 542 421 L 647 395 L 705 448 L 586 485 Z',
  'M 729 384 L 837 359 L 902 418 L 781 455 Z',
  'M 921 348 L 1022 323 L 1021 420 L 974 429 Z',
  'M 275 566 L 375 535 L 419 603 L 311 635 Z',
  'M 452 510 L 558 479 L 610 541 L 491 579 Z',
  'M 647 473 L 756 441 L 817 498 L 695 537 Z',
];

const parks = [
  { d: 'M 47 219 C 72 198, 105 198, 128 216 L 143 274 C 103 291, 66 285, 41 262 Z', label: 'Tuileries' },
  { d: 'M 197 519 C 233 492, 283 491, 314 517 L 336 560 C 300 584, 243 586, 211 562 Z', label: 'Jardin du Palais-Royal' },
  { d: 'M 555 501 C 594 478, 639 478, 672 502 L 695 549 C 657 576, 603 574, 571 550 Z', label: 'Square du Temple' },
  { d: 'M 331 544 C 357 529, 392 531, 409 551 L 419 595 C 388 611, 349 608, 326 587 Z', label: 'Place des Vosges' },
  { d: 'M 155 565 C 189 542, 220 540, 239 554 L 247 601 C 214 620, 173 614, 149 595 Z', label: 'Luxembourg' },
];

const water = 'M -35 456 C 90 424, 190 401, 288 375 C 402 345, 486 339, 580 302 C 687 261, 767 207, 855 154 C 916 117, 970 91, 1037 79 L 1037 165 C 972 184, 927 212, 882 239 C 782 299, 696 352, 607 384 C 505 421, 405 425, 306 451 C 197 480, 91 511, -35 549 Z';
const waterEdge = 'M -35 456 C 90 424, 190 401, 288 375 C 402 345, 486 339, 580 302 C 687 261, 767 207, 855 154 C 916 117, 970 91, 1037 79';

const districts = [
  { label: 'RIVE GAUCHE', x: 167, y: 459, rotate: -14 },
  { label: 'SAINT-GERMAIN', x: 265, y: 401, rotate: -10 },
  { label: 'LES HALLES', x: 441, y: 184, rotate: -6 },
  { label: 'LE MARAIS', x: 663, y: 159, rotate: -12 },
  { label: 'BASTILLE', x: 853, y: 351, rotate: -14 },
  { label: 'MONTORGUEIL', x: 548, y: 94, rotate: -4 },
];

const landmarkById = Object.fromEntries(landmarks.map((landmark) => [landmark.id, landmark]));

function project(lat, lng) {
  return {
    x: ((lng - MIN_LNG) / (MAX_LNG - MIN_LNG)) * MAP_WIDTH,
    y: ((MAX_LAT - lat) / (MAX_LAT - MIN_LAT)) * MAP_HEIGHT,
  };
}

function getCurvePath(points) {
  if (points.length < 2) return '';
  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const midpointX = (previous.x + point.x) / 2;
    const midpointY = (previous.y + point.y) / 2;
    return `${path} Q ${midpointX} ${midpointY} ${point.x} ${point.y}`;
  }, '');
}

function MarkerLabel({ x, y, text, color, selected }) {
  const width = Math.max(86, text.length * 6.6 + 24);
  const left = x + 17;
  const top = y - 31;

  return (
    <g className={`map-marker-label ${selected ? 'map-marker-label--selected' : ''}`} transform={`translate(${left} ${top})`} pointerEvents="none">
      <rect width={width} height="25" rx="12.5" fill="#fffdf8" stroke={selected ? color : '#dfd8cc'} strokeWidth={selected ? "1.5" : "1"} />
      <circle cx="12" cy="12.5" r="3" fill={color} />
      <text x="21" y="16.5" fill="#4a4842">{text}</text>
    </g>
  );
}

function CameraFan({ point, camera, color }) {
  if (!point || !camera) return null;
  const bearing = ((camera.bearing || 0) - 90) * (Math.PI / 180);
  const length = 50 + Math.max(0, Math.min(1.5, camera.zoom || 1)) * 12;
  const spread = 0.36;
  const p1 = { x: point.x + Math.cos(bearing - spread) * length, y: point.y + Math.sin(bearing - spread) * length };
  const p2 = { x: point.x + Math.cos(bearing + spread) * length, y: point.y + Math.sin(bearing + spread) * length };

  return (
    <g className="map-camera-fan" pointerEvents="none">
      <path d={`M ${point.x} ${point.y} L ${p1.x} ${p1.y} A ${length} ${length} 0 0 1 ${p2.x} ${p2.y} Z`} fill={color} fillOpacity=".15" stroke={color} strokeOpacity=".48" strokeWidth="1.5" />
      <path d={`M ${point.x} ${point.y} L ${point.x + Math.cos(bearing) * length} ${point.y + Math.sin(bearing) * length}`} stroke={color} strokeWidth="1.5" strokeOpacity=".6" strokeDasharray="3 4" />
    </g>
  );
}

export default function RouteMap({
  scenes = [],
  selectedId,
  onSelect,
  onMapClick,
  zoom = 1,
  showLabels = true,
  cameraMode = false,
  activeProgress = 0,
  activeCamera = null,
  playing = false,
}) {
  const sceneLandmarks = useMemo(() => scenes
    .map((scene) => ({ scene, landmark: landmarkById[scene.landmarkId] }))
    .filter(({ landmark }) => landmark), [scenes]);
  const points = sceneLandmarks.map(({ landmark }) => project(landmark.lat, landmark.lng));
  const route = getCurvePath(points);
  const activeIndex = Math.max(0, Math.min(sceneLandmarks.length - 1, Math.floor(activeProgress * sceneLandmarks.length)));
  const selectedScene = sceneLandmarks.find(({ scene }) => scene.id === selectedId || scene.landmarkId === selectedId) || sceneLandmarks[activeIndex];
  const selectedLandmark = selectedScene?.landmark;
  const selectedPoint = activeCamera && Number.isFinite(activeCamera.lat) && Number.isFinite(activeCamera.lng)
    ? project(activeCamera.lat, activeCamera.lng)
    : selectedLandmark ? project(selectedLandmark.lat, selectedLandmark.lng) : null;
  const selectedColor = selectedLandmark?.color || '#e36f61';
  const progressPoint = activeCamera && Number.isFinite(activeCamera.lat) && Number.isFinite(activeCamera.lng)
    ? project(activeCamera.lat, activeCamera.lng)
    : points.length > 1 ? points[Math.min(points.length - 1, Math.floor(activeProgress * (points.length - 1)))] : points[0];
  const mapScale = Math.max(0.88, Math.min(1.3, zoom));

  const handleMapClick = (event) => {
    if (!cameraMode || !onMapClick) return;
    const svg = event.currentTarget;
    const bounds = svg.getBoundingClientRect();
    const renderedX = ((event.clientX - bounds.left) / bounds.width) * MAP_WIDTH;
    const renderedY = ((event.clientY - bounds.top) / bounds.height) * MAP_HEIGHT;
    const translateX = (1 - mapScale) * 500;
    const translateY = (1 - mapScale) * 310;
    const svgX = (renderedX - translateX) / mapScale;
    const svgY = (renderedY - translateY) / mapScale;
    onMapClick({
      lat: MAX_LAT - (svgY / MAP_HEIGHT) * (MAX_LAT - MIN_LAT),
      lng: MIN_LNG + (svgX / MAP_WIDTH) * (MAX_LNG - MIN_LNG),
    });
  };

  return (
    <div className={`map-shell ${cameraMode ? 'map-shell--camera-mode' : ''} ${playing ? 'map-shell--playing' : ''}`} style={{ width: '100%', minHeight: '420px', overflow: 'hidden', background: '#f4f0e8' }}>
      <svg
        className="map-svg"
        viewBox="0 0 1000 620"
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label="Illustrated map of central Paris with tour route"
        onClick={handleMapClick}
        style={{ '--map-scale': mapScale, width: '100%', height: '100%', display: 'block' }}
      >
        <defs>
          <style>{`
            .map-svg { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .map-district-labels text { fill: #9a958a; font-size: 10px; font-weight: 650; letter-spacing: 2.1px; }
            .map-park-label { fill: #789373; font-size: 9px; font-style: italic; letter-spacing: .5px; opacity: .9; }
            .map-river-label { fill: #719ca4; font-size: 10px; font-weight: 700; letter-spacing: 3px; opacity: .8; }
            .map-river-label--small { font-size: 8px; letter-spacing: 2px; opacity: .65; }
            .map-marker-label text { font-size: 10px; font-weight: 650; letter-spacing: .1px; }
            .map-extra-label { fill: #7f817d; font-size: 8px; letter-spacing: .2px; }
            .map-marker-number { font-size: 10px; font-weight: 750; }
            .map-compass text, .map-scale text { fill: #77736b; font-size: 9px; font-weight: 700; letter-spacing: 1px; }
            .map-camera-hint-text { fill: #777269; font-size: 8px; font-weight: 750; letter-spacing: 1.1px; }
             .map-shell--playing .map-route-line { animation: map-route-flow 1.8s linear infinite; }
             .map-progress-dot--playing { animation: map-progress-pulse 1.2s ease-in-out infinite; }
            .map-marker--selected .map-marker-halo { animation: map-marker-breathe 2.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
             @keyframes map-route-flow { to { stroke-dashoffset: -22; } }
             @keyframes map-progress-pulse { 50% { transform: scale(1.22); transform-origin: center; } }
            @keyframes map-marker-breathe { 50% { opacity: .52; transform: scale(1.12); } }
          `}</style>
          <filter id="map-soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#81766a" floodOpacity=".16" />
          </filter>
          <filter id="map-label-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.2" floodColor="#756d61" floodOpacity=".16" />
          </filter>
          <pattern id="map-paper" width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="5" r=".7" fill="#b5aa99" opacity=".14" />
            <circle cx="12" cy="14" r=".6" fill="#b5aa99" opacity=".12" />
          </pattern>
          <linearGradient id="map-water" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c6dce0" />
            <stop offset="1" stopColor="#afcfd4" />
          </linearGradient>
          <linearGradient id="map-route" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#e79078" />
            <stop offset="1" stopColor="#d95f5f" />
          </linearGradient>
        </defs>

        <g className="map-canvas" transform={`translate(${(1 - mapScale) * 500} ${(1 - mapScale) * 310}) scale(${mapScale})`}>
          <rect width="1000" height="620" fill="#f4f0e8" />
          <rect width="1000" height="620" fill="url(#map-paper)" />

          <g className="map-blocks" fill="#e1dfda" stroke="#d6d3cc" strokeWidth="1.2">
            {blocks.map((d, index) => <path key={`block-${index}`} d={d} />)}
          </g>

          <g className="map-parks" fill="#c9d8c2" stroke="#b5c9b2" strokeWidth="1.2">
            {parks.map((park) => <path key={park.label} d={park.d} />)}
          </g>

          <g className="map-streets" fill="none" strokeLinecap="round">
            {streets.map((street, index) => (
              <g key={`street-${index}`}>
                <path d={street.d} stroke="#d7d3cb" strokeWidth={street.major ? 11 : 6} opacity=".9" />
                <path d={street.d} stroke="#fbfaf5" strokeWidth={street.major ? 7 : 3.5} />
              </g>
            ))}
          </g>

          <path className="map-seine" d={water} fill="url(#map-water)" stroke="#9fc5cc" strokeWidth="1.2" />
          <path d={waterEdge} fill="none" stroke="#eaf4f1" strokeWidth="2" opacity=".86" />
          <path d="M -35 548 C 91 511, 197 480, 306 451 C 405 425, 505 421, 607 384 C 696 352, 782 299, 882 239 C 927 212, 972 184, 1037 165" fill="none" stroke="#a7cbd0" strokeWidth="1" opacity=".6" />

          <g className="map-paris-details" fill="none" stroke="#b8b5ae" strokeWidth="1.2" opacity=".72">
            <path d="M 91 269 L 113 247 L 127 271 L 111 289 Z" />
            <path d="M 185 207 L 211 195 L 232 213 L 221 236 L 194 231 Z" />
            <path d="M 448 172 L 463 149 L 479 172 L 470 193 L 449 192 Z" />
            <path d="M 603 188 L 634 164 L 657 186 L 646 212 L 615 215 Z" />
            <path d="M 777 231 L 800 213 L 823 239 L 810 263 L 783 257 Z" />
            <path d="M 850 419 L 882 397 L 911 421 L 900 450 L 862 447 Z" />
            <path d="M 514 519 L 535 498 L 558 515 L 549 544 L 521 546 Z" />
            <path d="M 385 276 L 403 256 L 422 274 L 415 299 L 393 300 Z" />
          </g>

          {parks.map((park) => (
            <text key={`park-label-${park.label}`} className="map-park-label" x="0" y="0" transform={`translate(${park.label === 'Tuileries' ? 60 : park.label === 'Luxembourg' ? 165 : park.label === 'Place des Vosges' ? 341 : park.label === 'Square du Temple' ? 572 : 210} ${park.label === 'Tuileries' ? 250 : park.label === 'Luxembourg' ? 582 : park.label === 'Place des Vosges' ? 575 : park.label === 'Square du Temple' ? 532 : 535}) rotate(-12)`}>{park.label}</text>
          ))}

          <g className="map-district-labels" pointerEvents="none">
            {districts.map((district) => <text key={district.label} x={district.x} y={district.y} transform={`rotate(${district.rotate} ${district.x} ${district.y})`}>{district.label}</text>)}
          </g>

          <text className="map-river-label" x="548" y="335" transform="rotate(-27 548 335)">LA SEINE</text>
          <text className="map-river-label map-river-label--small" x="791" y="210" transform="rotate(-32 791 210)">LA SEINE</text>

          <g className="map-route-layer" pointerEvents="none">
            {route && <path d={route} fill="none" stroke="#fffdf8" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" opacity=".9" />}
            {route && <path d={route} fill="none" stroke="url(#map-route)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 9" className="map-route-line" />}
          {progressPoint && <circle cx={progressPoint.x} cy={progressPoint.y} r="7" fill="#fffdf8" stroke="#e36f61" strokeWidth="2" className={`map-progress-dot ${playing ? 'map-progress-dot--playing' : ''}`} />}
          </g>

          {selectedPoint && <CameraFan point={selectedPoint} camera={activeCamera || selectedScene?.scene.camera} color={selectedColor} />}

          <g className="map-marker-layer">
            {sceneLandmarks.map(({ scene, landmark }, index) => {
              const point = project(landmark.lat, landmark.lng);
              const selected = scene.id === selectedId || scene.landmarkId === selectedId || (!selectedId && index === activeIndex);
              const color = landmark.color || '#e36f61';
              return (
                <g
                  key={scene.id}
                  className={`map-marker ${selected ? 'map-marker--selected' : ''}`}
                  transform={`translate(${point.x} ${point.y})`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect?.(scene.id);
                  }}
                  role="button"
                  tabIndex="0"
                  aria-label={`Select ${landmark.name}`}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') onSelect?.(scene.id);
                  }}
                >
                  <circle r={selected ? 20 : 16} fill="#fffdf8" opacity=".92" className="map-marker-halo" />
                  <circle r={selected ? 13 : 11} fill={color} stroke="#fffdf8" strokeWidth="2.5" filter="url(#map-soft-shadow)" />
                  <text textAnchor="middle" y="5" fill="#fffdf8" className="map-marker-number">{index + 1}</text>
                  {showLabels && <MarkerLabel x={0} y={0} text={landmark.name} color={color} selected={selected} />}
                </g>
              );
            })}
          </g>

          <g className="map-extra-landmarks" pointerEvents="none">
            {landmarks.filter((landmark) => !sceneLandmarks.some(({ scene }) => scene.landmarkId === landmark.id)).map((landmark) => {
              const point = project(landmark.lat, landmark.lng);
              return (
                <g key={landmark.id} transform={`translate(${point.x} ${point.y})`}>
                  <circle r="4" fill={landmark.color} stroke="#fffdf8" strokeWidth="1.5" />
                  {showLabels && <text x="8" y="3" className="map-extra-label">{landmark.name}</text>}
                </g>
              );
            })}
          </g>

          <g className="map-compass" transform="translate(914 70)">
            <circle r="26" fill="#fffdf8" fillOpacity=".82" stroke="#ddd6ca" />
            <path d="M 0 -17 L 4 -3 L 0 0 L -4 -3 Z" fill="#e36f61" />
            <path d="M 0 17 L 4 3 L 0 0 L -4 3 Z" fill="#aaa49a" />
            <text x="0" y="-31" textAnchor="middle">N</text>
          </g>
          <g className="map-scale" transform="translate(52 586)">
            <path d="M 0 0 H 70" stroke="#76716a" strokeWidth="2" />
            <path d="M 0 -4 V 4 M 70 -4 V 4" stroke="#76716a" strokeWidth="1.5" />
            <text x="35" y="-9" textAnchor="middle">500 m</text>
          </g>
        </g>

        <rect className="map-camera-hint" x="14" y="14" width="165" height="28" rx="14" fill="#fffdf8" fillOpacity=".88" stroke="#ded7ca" pointerEvents="none" />
        <text className="map-camera-hint-text" x="29" y="32" pointerEvents="none">{cameraMode ? 'CLICK TO SET CAMERA' : 'CENTRAL PARIS · WALKING ROUTE'}</text>
      </svg>
    </div>
  );
}
