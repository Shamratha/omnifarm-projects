export const demoSnapshot = {
  manifest: {
    design: 'Orion DSP',
    top: 'orion_dsp_top',
    technology: 'GF12LP · 9-track',
    run: 'route_042',
    snapshotId: 'SNAP-7F3A',
    generatedAt: '2026-10-14T14:32:09Z',
    reportVersion: 'openroad-proto/0.4',
    units: { time: 'ns', distance: 'µm', area: 'µm²' },
    sourceReports: [
      { name: 'report_checks.rpt', kind: 'timing', status: 'fresh', generatedAt: '2026-10-14T14:31:42Z', snapshotId: 'SNAP-7F3A' },
      { name: 'report_timing.rpt', kind: 'paths', status: 'fresh', generatedAt: '2026-10-14T14:31:44Z', snapshotId: 'SNAP-7F3A' },
      { name: 'report_clock_skew.rpt', kind: 'clock', status: 'fresh', generatedAt: '2026-10-14T14:29:45Z', snapshotId: 'SNAP-7F3A' },
      { name: 'route_congestion.rpt', kind: 'congestion', status: 'fresh', generatedAt: '2026-10-14T14:31:48Z', snapshotId: 'SNAP-7F3A' },
      { name: 'placement.def', kind: 'placement', status: 'fresh', generatedAt: '2026-10-14T14:29:18Z', snapshotId: 'SNAP-7F3A' },
      { name: 'netlist.v', kind: 'netlist', status: 'fresh', generatedAt: '2026-10-14T14:21:07Z', snapshotId: 'SNAP-7F3A' },
      { name: 'constraints.sdc', kind: 'constraints', status: 'fresh', generatedAt: '2026-10-14T14:20:58Z', snapshotId: 'SNAP-7F3A' },
      { name: 'orion_dsp.spef', kind: 'parasitics', status: 'fresh', generatedAt: '2026-10-14T14:30:51Z', snapshotId: 'SNAP-7F3A' }
    ],
    staleReports: []
  },
  stages: [
    { id: 'placement', label: 'Placement', run: 'place_031', setupWns: -0.412, setupTns: -15.84, holdWns: 0.018, holdTns: 0, overflow: 8.7, status: 'fail' },
    { id: 'cts', label: 'CTS', run: 'cts_038', setupWns: -0.267, setupTns: -8.31, holdWns: 0.011, holdTns: -0.04, overflow: 10.4, status: 'fail' },
    { id: 'signoff', label: 'Route / sign-off', run: 'route_042', setupWns: -0.183, setupTns: -4.21, holdWns: 0.012, holdTns: -0.08, overflow: 12.4, status: 'warn' }
  ],
  clocks: [
    { id: 'clk_core', name: 'clk_core', period: 3.000, sinks: 1842, latency: 0.382, skew: 0.041, status: 'pass', color: '#65d6b3' },
    { id: 'clk_bus', name: 'clk_bus', period: 4.000, sinks: 436, latency: 0.511, skew: 0.087, status: 'warn', color: '#f2b96b' },
    { id: 'clk_dbg', name: 'clk_dbg', period: 8.000, sinks: 118, latency: 0.244, skew: 0.018, status: 'pass', color: '#8ea9ff' }
  ],
  instances: [
    { id: 'u_dma_ctrl', type: 'MACRO', x: 94, y: 21, w: 27, h: 17, label: 'DMA_CTRL', macro: true },
    { id: 'u_sram0', type: 'SRAM', x: 15, y: 67, w: 23, h: 19, label: 'SRAM_0', macro: true },
    { id: 'u_sram1', type: 'SRAM', x: 72, y: 69, w: 23, h: 17, label: 'SRAM_1', macro: true },
    { id: 'u_vec', type: 'MACRO', x: 44, y: 10, w: 17, h: 13, label: 'VEC', macro: true },
    { id: 'u_reg_a', type: 'DFF_X2', x: 44, y: 47, label: 'u_reg_a', path: true },
    { id: 'u_buf_12', type: 'BUF_X1', x: 51, y: 44, label: 'u_buf_12', path: true },
    { id: 'u_mux_7', type: 'MUX2_X1', x: 59, y: 39, label: 'u_mux_7', path: true },
    { id: 'u_alu_3', type: 'AOI21_X2', x: 68, y: 45, label: 'u_alu_3', path: true },
    { id: 'u_reg_b', type: 'DFF_X2', x: 79, y: 42, label: 'u_reg_b', path: true },
    { id: 'u_reg_c', type: 'DFF_X1', x: 32, y: 39, label: 'u_reg_c' },
    { id: 'u_buf_19', type: 'BUF_X2', x: 25, y: 30, label: 'u_buf_19' },
    { id: 'u_arbiter', type: 'AOI22_X1', x: 84, y: 55, label: 'u_arbiter' },
    { id: 'u_reg_d', type: 'DFF_X1', x: 91, y: 53, label: 'u_reg_d' },
    { id: 'u_cdc_sync', type: 'DFF_X1', x: 22, y: 48, label: 'u_cdc_sync' }
  ],
  nets: [
    { id: 'n_102', name: 'n_102', points: [[45, 48], [51, 45], [59, 40], [68, 46], [79, 43]], critical: true, layer: 'M4', fanout: 1 },
    { id: 'n_117', name: 'n_117', points: [[79, 43], [86, 51], [92, 54]], critical: true, layer: 'M5', fanout: 2 },
    { id: 'n_clk_core', name: 'clk_core', points: [[9, 13], [25, 26], [44, 35], [60, 34], [79, 37], [103, 43]], clock: true, layer: 'M8', fanout: 1842 },
    { id: 'n_dma_bus', name: 'dma_bus[12]', points: [[111, 30], [98, 38], [92, 51]], layer: 'M6', fanout: 16 },
    { id: 'n_sram_data', name: 'sram0_rdata[31]', points: [[38, 76], [49, 63], [67, 59], [82, 77]], layer: 'M5', fanout: 32 },
    { id: 'n_cdc', name: 'cdc_req', points: [[23, 49], [30, 40], [38, 31]], layer: 'M4', fanout: 4 }
  ],
  congestion: [
    { id: 'hot-1', x: 47, y: 32, w: 14, h: 13, layer: 'M4', demand: 118, capacity: 100, overflow: 18, nets: ['n_102', 'n_cdc'], paths: ['p-001', 'p-002', 'p-006'] },
    { id: 'hot-2', x: 72, y: 50, w: 15, h: 12, layer: 'M5', demand: 112, capacity: 100, overflow: 12, nets: ['n_117', 'n_sram_data'], paths: ['p-001', 'p-003'] },
    { id: 'hot-3', x: 88, y: 37, w: 13, h: 13, layer: 'M6', demand: 109, capacity: 100, overflow: 9, nets: ['n_dma_bus'], paths: ['p-004'] },
    { id: 'hot-4', x: 26, y: 54, w: 12, h: 13, layer: 'M4', demand: 105, capacity: 100, overflow: 5, nets: ['n_cdc'], paths: ['p-006'] },
    { id: 'hot-5', x: 60, y: 71, w: 15, h: 10, layer: 'M3', demand: 103, capacity: 100, overflow: 3, nets: ['n_sram_data'], paths: ['p-003'] },
    { id: 'hot-6', x: 38, y: 25, w: 10, h: 9, layer: 'M7', demand: 101, capacity: 100, overflow: 1, nets: ['n_clk_core'], paths: ['p-005'] }
  ],
  paths: [
    { id: 'p-001', rank: 1, analysis: 'setup', clock: 'clk_core', startpoint: 'u_reg_a/Q', endpoint: 'u_reg_b/D', slack: -0.183, arrival: 2.817, required: 2.634, logicDelay: 1.492, netDelay: 1.325, cells: 17, segments: ['u_reg_a', 'u_buf_12', 'u_mux_7', 'u_alu_3', 'u_reg_b'], netIds: ['n_102'], hotspotIds: ['hot-1', 'hot-2'], reason: 'Long combinational arc', exception: null, color: '#ff827e' },
    { id: 'p-002', rank: 2, analysis: 'setup', clock: 'clk_core', startpoint: 'u_reg_c/Q', endpoint: 'u_reg_b/D', slack: -0.183, arrival: 2.817, required: 2.634, logicDelay: 1.671, netDelay: 1.146, cells: 21, segments: ['u_reg_c', 'u_buf_19', 'u_mux_7', 'u_alu_3', 'u_reg_b'], netIds: ['n_102'], hotspotIds: ['hot-1'], reason: 'High fan-in merge', exception: null, color: '#ff827e' },
    { id: 'p-003', rank: 3, analysis: 'setup', clock: 'clk_core', startpoint: 'u_sram1/rdata[7]', endpoint: 'u_reg_d/D', slack: -0.161, arrival: 2.839, required: 2.678, logicDelay: 1.202, netDelay: 1.598, cells: 12, segments: ['u_sram1', 'u_alu_3', 'u_arbiter', 'u_reg_d'], netIds: ['n_sram_data', 'n_117'], hotspotIds: ['hot-2', 'hot-5'], reason: 'Net delay dominant', exception: null, color: '#ffad72' },
    { id: 'p-004', rank: 4, analysis: 'setup', clock: 'clk_bus', startpoint: 'u_dma_ctrl/data[3]', endpoint: 'u_reg_d/D', slack: -0.124, arrival: 3.876, required: 3.752, logicDelay: 1.388, netDelay: 1.311, cells: 16, segments: ['u_dma_ctrl', 'u_arbiter', 'u_reg_d'], netIds: ['n_dma_bus', 'n_117'], hotspotIds: ['hot-3', 'hot-2'], reason: 'Clock latency mismatch', exception: null, color: '#ffad72' },
    { id: 'p-005', rank: 5, analysis: 'setup', clock: 'clk_core', startpoint: 'u_cdc_sync/Q', endpoint: 'u_reg_c/D', slack: -0.082, arrival: 2.918, required: 2.836, logicDelay: 1.779, netDelay: 1.039, cells: 26, segments: ['u_cdc_sync', 'u_buf_19', 'u_reg_c'], netIds: ['n_cdc'], hotspotIds: ['hot-4', 'hot-6'], reason: 'Crossing guardband', exception: null, color: '#f2b96b' },
    { id: 'p-006', rank: 6, analysis: 'setup', clock: 'clk_core', startpoint: 'u_cdc_sync/Q', endpoint: 'u_reg_b/D', slack: -0.044, arrival: 2.956, required: 2.912, logicDelay: 1.552, netDelay: 1.224, cells: 18, segments: ['u_cdc_sync', 'u_buf_19', 'u_mux_7', 'u_alu_3', 'u_reg_b'], netIds: ['n_cdc', 'n_102'], hotspotIds: ['hot-1', 'hot-4'], reason: 'Shared critical net', exception: { kind: 'false_path', status: 'candidate', scope: 'path', sourceReport: 'constraints.sdc' }, color: '#f2b96b' },
    { id: 'p-007', rank: 7, analysis: 'setup', clock: 'clk_dbg', launchClock: 'clk_core', captureClock: 'clk_dbg', clockRelation: 'asynchronous', startpoint: 'u_reg_c/Q', endpoint: 'u_cdc_sync/D', slack: 0.114, arrival: 1.886, required: 2.000, logicDelay: 0.994, netDelay: 0.892, cells: 9, segments: ['u_reg_c', 'u_cdc_sync'], netIds: ['n_cdc'], hotspotIds: [], reason: 'CDC debug crossing', exception: { kind: 'false_path', status: 'applied', scope: 'clock_pair', clockGroups: ['clk_core', 'clk_dbg'], sourceReport: 'constraints.sdc' }, color: '#65d6b3' },
    { id: 'p-008', rank: 8, analysis: 'setup', clock: 'clk_bus', startpoint: 'u_reg_d/Q', endpoint: 'u_dma_ctrl/cfg[2]', slack: 0.224, arrival: 3.776, required: 4.000, logicDelay: 1.104, netDelay: 1.441, cells: 14, segments: ['u_reg_d', 'u_dma_ctrl'], netIds: ['n_dma_bus'], hotspotIds: ['hot-3'], reason: 'Clean path', exception: null, color: '#65d6b3' },
    { id: 'p-009', rank: 1, analysis: 'hold', clock: 'clk_core', startpoint: 'u_reg_b/Q', endpoint: 'u_reg_a/D', slack: 0.012, arrival: 0.212, required: 0.200, logicDelay: 0.113, netDelay: 0.099, cells: 8, segments: ['u_reg_b', 'u_buf_12', 'u_reg_a'], netIds: ['n_102'], hotspotIds: ['hot-1'], reason: 'Tight but clean', exception: null, color: '#65d6b3' },
    { id: 'p-010', rank: 2, analysis: 'hold', clock: 'clk_bus', startpoint: 'u_reg_d/Q', endpoint: 'u_dma_ctrl/cfg[2]', slack: -0.006, arrival: 0.194, required: 0.200, logicDelay: 0.108, netDelay: 0.092, cells: 7, segments: ['u_reg_d', 'u_dma_ctrl'], netIds: ['n_dma_bus'], hotspotIds: ['hot-3'], reason: 'Clock skew exposure', exception: null, color: '#f2b96b' },
    { id: 'p-011', rank: 3, analysis: 'hold', clock: 'clk_core', startpoint: 'u_reg_c/Q', endpoint: 'u_reg_b/D', slack: -0.006, arrival: 0.194, required: 0.200, logicDelay: 0.091, netDelay: 0.103, cells: 6, segments: ['u_reg_c', 'u_mux_7', 'u_reg_b'], netIds: ['n_102'], hotspotIds: ['hot-1'], reason: 'Negative slack tie', exception: null, color: '#f2b96b' },
    { id: 'p-012', rank: 4, analysis: 'hold', clock: 'clk_core', startpoint: 'u_cdc_sync/Q', endpoint: 'u_reg_c/D', slack: 0.021, arrival: 0.179, required: 0.200, logicDelay: 0.082, netDelay: 0.097, cells: 5, segments: ['u_cdc_sync', 'u_reg_c'], netIds: ['n_cdc'], hotspotIds: ['hot-4'], reason: 'Clean path', exception: null, color: '#65d6b3' },
    { id: 'p-013', rank: 5, analysis: 'hold', clock: 'clk_dbg', launchClock: 'clk_core', captureClock: 'clk_dbg', clockRelation: 'asynchronous', startpoint: 'u_reg_a/Q', endpoint: 'u_cdc_sync/D', slack: 0.074, arrival: 0.126, required: 0.200, logicDelay: 0.062, netDelay: 0.064, cells: 4, segments: ['u_reg_a', 'u_cdc_sync'], netIds: ['n_cdc'], hotspotIds: [], reason: 'Asynchronous clock groups', exception: { kind: 'clock_group', status: 'applied', scope: 'clock_pair', clockGroups: ['clk_core', 'clk_dbg'], sourceReport: 'constraints.sdc' }, color: '#65d6b3' }
  ],
  candidates: [
    { id: 'resize-buf', kind: 'CELL RESIZE', title: 'Upsize u_buf_12', target: 'u_buf_12', description: 'Swap BUF_X1 → BUF_X4 on the shared critical arc.', rationale: 'Shared by 3 failing setup paths · 1.325 ns net delay', model: { setupWns: 0.071, setupTns: 0.214, holdWns: -0.005, overflow: 0.3, area: 0.18, power: 1.7 }, risk: 'Low', affectedPaths: 3, accent: '#8ea9ff' },
    { id: 'spread-net', kind: 'PLACEMENT', title: 'Spread critical cluster', target: 'region hot-1', description: 'Nudge 5 cells away from the M4 overflow tile.', rationale: 'M4 hotspot overlaps the worst path · 118% demand', model: { setupWns: 0.046, setupTns: 0.162, holdWns: 0.001, overflow: -2.1, area: 0, power: 0.3 }, risk: 'Low', affectedPaths: 4, accent: '#65d6b3' },
    { id: 'clock-skew', kind: 'CLOCK TREE', title: 'Balance clk_core sink', target: 'clk_core / u_reg_b', description: 'Modeled useful skew at the capture sink.', rationale: '41 ps clock skew · capture branch is 18 ps late', model: { setupWns: 0.033, setupTns: 0.098, holdWns: -0.009, overflow: 0, area: 0.06, power: 0.8 }, risk: 'Watch hold', affectedPaths: 2, accent: '#f2b96b' },
    { id: 'false-path', kind: 'CONSTRAINT', title: 'Constrain CDC debug arc', target: 'u_cdc_sync → u_reg_b', description: 'Mark the debug-only crossing as a false path.', rationale: 'Candidate exception detected · review CDC intent first', model: { setupWns: 0.044, setupTns: 0.176, holdWns: 0, overflow: 0, area: 0, power: 0 }, risk: 'Review intent', affectedPaths: 1, affectedPathIds: ['p-006'], accent: '#d49af5' }
  ],
  slackBins: [
    { label: '< -0.20', min: -Infinity, max: -0.2, count: 6 },
    { label: '-0.20 → -0.10', min: -0.2, max: -0.1, count: 18 },
    { label: '-0.10 → 0', min: -0.1, max: 0, count: 36 },
    { label: '0 → 0.10', min: 0, max: 0.1, count: 44 },
    { label: '0.10 → 0.20', min: 0.1, max: 0.2, count: 31 },
    { label: '> 0.20', min: 0.2, max: Infinity, count: 79 }
  ],
  totals: { endpoints: 214, setupViolations: 60, holdViolations: 2, maxSlew: 11, maxCap: 7, maxFanout: 3, area: 82410, power: 118.4, wirelength: 18342 }
};
