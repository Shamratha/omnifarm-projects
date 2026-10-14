import { classifyPathException, exceptionKind } from './model.js';

const DOMAINS = ['timing', 'constraints', 'clock', 'physical'];
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const STYLES = `
body{font:14px Arial,sans-serif;line-height:1.5;color:#192735;max-width:1400px;margin:32px auto;padding:0 20px}
h1,h2,h3{color:#0b5360}section{margin:24px 0;padding:12px;border:1px solid #ccd8de}
table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ccd8de;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#e8f1f3}.table-wrap{overflow-x:auto}.empty,.note{color:#627382}
.evidence{border-left:5px solid #a35c13}.violations{border-left:5px solid #bd3d3d}
.exclusions{border-left:5px solid #72538d}.review{border-left:5px solid #a35c13}
.modeled,.derived{border-left:5px solid #8e6bb4;background:#f6f0fb}.notice{padding:12px;background:#f0f4f6}
@media print{body{margin:0;font-size:10px}section{break-inside:avoid}.table-wrap{overflow:visible}}
`;

/** Escape report text for both HTML content and quoted attributes. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function text(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function unique(values) {
  return [...new Set(values)];
}

function sourceFreshness(source) {
  // Computed metadata takes precedence over a source's declared status.
  if (source.freshness) return source.freshness;
  if (source.unknown) return 'unknown';
  if (source.stale) return 'stale';
  return source.stale === false && source.unknown === false ? 'fresh' : 'unknown';
}

function freshnessLabel(status) {
  return status === 'fresh' ? 'FRESH' : status === 'stale' ? 'STALE' : 'UNKNOWN / UNVERIFIED';
}

function domainReports(report, domain) {
  return report.evidence?.[domain]?.reports
    ?? (report.evidence?.reports ?? []).filter((source) => source.domain === domain);
}

function domainReasons(report, domain) {
  return unique([
    ...(report.evidence?.[domain]?.reasons ?? []),
    ...domainReports(report, domain).flatMap((source) => source.reasons ?? [])
  ]);
}

function overallReasons(report) {
  return unique([
    ...(report.evidence?.reasons ?? []),
    ...DOMAINS.flatMap((domain) => domainReasons(report, domain)),
    ...(report.evidence?.reports ?? []).flatMap((source) => source.reasons ?? [])
  ]);
}

function classificationFor(report, path, modeled) {
  if (path.classification) return path.classification;
  if (path.disposition) return path; // The exception inventory has flat classification fields.
  const inventory = !modeled && (report.exceptions ?? []).find((item) => item.id === path.id && item.analysis === path.analysis);
  if (inventory?.classification) return inventory.classification;
  if (inventory?.disposition) return inventory;
  // Older model reports lack path annotations. Reuse the model's pure classifier,
  // including its freshness rules, rather than infer exclusions from slack/clocks.
  return classifyPathException(path, {
    constraints: { status: path.constraintFreshness ?? report.evidence?.constraints?.status ?? 'unknown' }
  });
}

function pathRow(report, path, modeled = false) {
  const classification = classificationFor(report, path, modeled);
  const analysis = path.analysis ?? report.baseline?.selectedAnalysis ?? report.context?.analysis;
  const timingFreshness = path.timingFreshness ?? report.evidence?.timing?.status ?? 'unknown';
  const constraintFreshness = path.constraintFreshness ?? report.evidence?.constraints?.status ?? 'unknown';
  const negative = Number.isFinite(path.slack) && path.slack < 0;
  let status = classification.excluded ? 'EXCLUDED' : negative ? 'VIOLATION' : Number.isFinite(path.slack) ? 'CLEAN' : 'UNKNOWN';
  if (classification.review) status += ' · EXCEPTION REVIEW';
  const origin = modeled ? 'modeled' : path.origin ?? report.baseline?.[analysis]?.origin ?? report.context?.origin ?? 'unknown';
  if (modeled || origin === 'modeled') status = `MODELED · ${status}`;
  else if (origin === 'derived') status = `DERIVED · ${status}`;
  return {
    ...path,
    analysis,
    classification,
    negative,
    status,
    origin,
    launchClock: path.launchClock ?? path.clock ?? 'unknown',
    captureClock: path.captureClock ?? path.clock ?? path.launchClock ?? 'unknown',
    clockRelation: path.clockRelation ?? 'unknown',
    timingFreshness,
    constraintFreshness,
    timingReasons: unique([...domainReasons(report, 'timing'), ...(path.timingFreshnessReasons ?? [])]),
    constraintReasons: unique([...domainReasons(report, 'constraints'), ...(path.constraintFreshnessReasons ?? [])]),
    freshnessReasons: unique([
      ...domainReasons(report, 'timing'), ...domainReasons(report, 'constraints'),
      ...(path.timingFreshnessReasons ?? []), ...(path.constraintFreshnessReasons ?? []),
      ...(path.freshnessReasons ?? [])
    ]),
    source: path.sourceReport ?? path.source ?? classification.source ?? '',
    rowType: modeled ? 'modeled_candidate' : 'baseline'
  };
}

function table(id, headers, rows) {
  const head = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('');
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(text(value))}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="empty" colspan="${headers.length}">None reported</td></tr>`;
  return `<div class="table-wrap"><table id="${escapeHtml(id)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function section(id, title, content, className = '') {
  return `<section id="${escapeHtml(id)}" class="${escapeHtml(className)}"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function pathTable(id, paths) {
  return table(id, [
    'Analysis', 'Path', 'Status', 'Slack (ns)', 'Startpoint', 'Endpoint', 'Launch clock', 'Capture clock', 'Relation',
    'Classification', 'Exception status', 'Source', 'Timing freshness', 'Constraint freshness', 'Freshness reasons', 'Origin'
  ], paths.map((path) => [
    path.analysis, path.id, path.status, path.slack, path.startpoint, path.endpoint, path.launchClock, path.captureClock,
    path.clockRelation, path.classification.label, path.classification.status, path.source,
    freshnessLabel(path.timingFreshness), freshnessLabel(path.constraintFreshness), path.freshnessReasons.join(', ') || 'none', path.origin
  ]));
}

function isAsyncClockException(path) {
  return path.classification.disposition === 'clock_group_excluded';
}

function exceptionTable(id, paths) {
  return table(id, [
    'Analysis', 'Path', 'Classification', 'Disposition', 'Kind', 'Exception status', 'Excluded', 'Review',
    'Launch clock', 'Capture clock', 'Relation', 'Source', 'Exception details', 'Origin'
  ], paths.map((path) => [
    path.analysis, path.id, path.classification.label,
    path.classification.disposition,
    path.classification.kind ?? exceptionKind(path.exception), path.classification.status,
    path.classification.excluded, path.classification.review, path.launchClock, path.captureClock,
    path.clockRelation, path.classification.source, path.exception, path.origin
  ]));
}

const METRIC_LABELS = {
  wns: 'WNS (ns)', tns: 'TNS (ns)', violations: 'Violating endpoints', endpoints: 'Timed endpoints',
  totalPaths: 'Total paths', timedPaths: 'Timed paths', excludedPaths: 'Excluded paths',
  excludedFalsePaths: 'Excluded false paths', excludedClockGroups: 'Excluded clock groups',
  exceptionCandidates: 'Candidate exceptions', unverifiedExceptions: 'Unverified exceptions',
  overflow: 'Route overflow (%)', area: 'Area (µm²)', power: 'Power (mW)'
};

function summaryTable(id, summary = {}) {
  return table(id, ['Metric', 'Value'], Object.entries(summary).map(([key, value]) => [METRIC_LABELS[key] ?? key, value]));
}

function evidenceHtml(report) {
  const reports = report.evidence?.reports ?? DOMAINS.flatMap((domain) => domainReports(report, domain));
  const renderSources = (id, sources) => table(id, [
    'Report', 'Domain', 'Declared status', 'Computed freshness', 'Stale', 'Unknown', 'Reasons', 'Generated at', 'Snapshot'
  ], sources.map((source) => [
    source.name, source.domain, source.status, freshnessLabel(sourceFreshness(source)), source.stale, source.unknown,
    (source.reasons ?? []).join(', ') || 'none', source.generatedAt, source.snapshotId
  ]));
  return section('evidence', `Evidence status · ${freshnessLabel(report.evidence?.overall)}`, `
    ${table('evidence-domains', ['Domain', 'Computed status', 'Reports', 'Reasons'], DOMAINS.map((domain) => [
      domain, freshnessLabel(report.evidence?.[domain]?.status), domainReports(report, domain).length,
      domainReasons(report, domain).join(', ') || (domainReports(report, domain).length ? 'none' : 'No source reports')
    ]))}
    <h3>Stale / unverified source evidence</h3>
    ${renderSources('unverified-sources', reports.filter((source) => sourceFreshness(source) !== 'fresh'))}
    <h3>Source reports · computed freshness and reasons</h3>
    ${renderSources('source-reports', reports)}
  `, 'evidence');
}

function exceptionsHtml(report) {
  const paths = (report.exceptions ?? []).map((record) => pathRow(report, record));
  const candidates = paths.filter((path) => path.classification.disposition === 'exception_review' || path.classification.status === 'candidate');
  const unverified = paths.filter((path) => path.classification.review && !candidates.includes(path));
  const clockGroups = paths.filter((path) => isAsyncClockException(path));
  return [
    section('exceptions', 'Complete exception inventory · setup and hold', exceptionTable('exception-inventory', paths)),
    section('false-paths', 'False path exclusions', exceptionTable('false-path-exclusions', paths.filter((path) => path.classification.disposition === 'false_path_excluded')), 'exclusions'),
    section('clock-groups', 'Asynchronous clock-group exclusions', exceptionTable('clock-group-exclusions', clockGroups), 'exclusions'),
    section('multicycle', 'Multicycle exceptions · remain timed', exceptionTable('multicycle-exceptions', paths.filter((path) => path.classification.kind === 'multicycle'))),
    section('candidate-exceptions', 'Candidate exceptions · review required', exceptionTable('candidate-exception-inventory', candidates), 'review'),
    section('unverified-exceptions', 'Unverified exceptions · review required', exceptionTable('unverified-exception-inventory', unverified), 'review')
  ].join('\n');
}

function physicalHtml(report) {
  const baseline = report.baseline ?? {};
  return section('physical', 'Clocks and physical hotspots', `
    <h3>Clock domains</h3>
    ${table('clocks', ['Clock', 'Period (ns)', 'Sinks', 'Latency (ns)', 'Skew (ns)', 'Status'], (baseline.clocks ?? []).map((clock) => [clock.name ?? clock.id, clock.period, clock.sinks, clock.latency, clock.skew, clock.status]))}
    <h3>Launch / capture clock pairs</h3>
    ${table('clock-pairs', ['Clock pair and relation'], (baseline.clockPairs ?? []).map((pair) => [pair]))}
    <h3>Congestion hotspots</h3>
    ${table('hotspots', ['Hotspot', 'Layer', 'Bounds (x, y, w, h)', 'Overflow (%)', 'Demand', 'Capacity', 'Nets', 'Related paths'], (baseline.hotspots ?? []).map((hotspot) => [
      hotspot.id, hotspot.layer, [hotspot.x, hotspot.y, hotspot.w, hotspot.h].join(', '), hotspot.overflow,
      hotspot.demand, hotspot.capacity, (hotspot.nets ?? []).join(', '), (hotspot.paths ?? []).join(', ')
    ]))}
  `);
}

function candidateHtml(report) {
  const candidate = report.candidate;
  if (!candidate) return '';
  const paths = (candidate.paths ?? []).map((path) => pathRow(report, path, true));
  return section('candidate', `MODELED candidate · ${text(candidate.title ?? candidate.id)}`, `
    <p>MODELED ONLY: deterministic what-if data, not reported STA or silicon sign-off evidence.</p>
    <p>Candidate ID: ${escapeHtml(candidate.id)} · origin: modeled</p>
    <h3>Modeled summary</h3>${summaryTable('candidate-summary', candidate.modeledSummary ?? {})}
    <h3>Modeled candidate paths</h3>${pathTable('candidate-paths', paths)}
    <h3>Modeled candidate exceptions</h3>${exceptionTable('candidate-modeled-exceptions', paths.filter((path) => path.exception))}
  `, 'modeled');
}

/** Pure, self-contained HTML serialization; the supplied eligibility flag is not a closure claim. */
export function signoffHtml(report = {}) {
  const baseline = report.baseline ?? {};
  const context = report.context ?? {};
  const analysis = baseline.selectedAnalysis ?? context.analysis ?? 'setup';
  const paths = (baseline.worstPaths ?? []).map((path) => pathRow(report, path));
  const origin = baseline[analysis]?.origin ?? paths[0]?.origin ?? context.origin ?? 'unknown';
  const design = report.manifest?.design ?? 'Timing closure';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(design)} · sign-off review</title><style>${STYLES}</style></head>
<body><h1>${escapeHtml(design)} timing closure sign-off review</h1>
<p>Exported at: ${escapeHtml(report.exportedAt)} · snapshot: ${escapeHtml(report.manifest?.snapshotId)}</p>
<p class="notice"><strong>Report signoffEligible: ${escapeHtml(text(report.signoffEligible, 'unknown'))}</strong> · Closure status: ${escapeHtml(report.closureStatus)}. Prototype timing eligibility is not silicon certification. No real silicon sign-off claim is made.</p>
${section('manifest', 'Run manifest', table('manifest-metadata', ['Field', 'Value'], Object.entries(report.manifest ?? {}).filter(([key]) => key !== 'sourceReports')))}
${section('context', 'Analysis context and origin', `
  ${table('analysis-context', ['Field', 'Value'], [...Object.entries(context), ['selectedAnalysis', analysis], ['origin', origin]])}
  <p class="${origin === 'derived' ? 'derived' : 'note'}">${origin === 'derived' ? 'DERIVED CONTEXT: locally transformed values, not independently reported STA.' : 'Reported, derived, and modeled origins are labeled on every path.'}</p>
`)}
${evidenceHtml(report)}
${section('summaries', 'Setup and hold summaries', `<h3>Setup</h3>${summaryTable('setup-summary', baseline.setup)}<h3>Hold</h3>${summaryTable('hold-summary', baseline.hold)}`)}
${section('selected-analysis', `Selected analysis paths · ${analysis}`, pathTable('selected-paths', paths))}
${section('negative-timing', 'Observed negative slack · non-excluded paths', `
  <p>Negative slack on non-excluded baseline paths. Evidence freshness and exception review are shown separately; derived or modeled origins remain labeled.</p>
  ${pathTable('negative-violations', paths.filter((path) => path.negative && !path.classification.excluded))}
`, 'violations')}
${exceptionsHtml(report)}
${physicalHtml(report)}
${candidateHtml(report)}
<footer><p class="note">Prototype export only. This report does not run extraction, STA, DRC, LVS, or routing and does not certify real silicon sign-off.</p></footer>
</body></html>`;
}

function csvCell(value) {
  // Numeric slack stays numeric, including negative values. All text fields are
  // quoted and formula-prefixed, including formulas concealed by whitespace.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const raw = text(value, '');
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(raw) || /^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

const CSV_COLUMNS = [
  ['row_type', (path) => path.rowType], ['analysis', (path) => path.analysis], ['path_id', (path) => path.id],
  ['status', (path) => path.status], ['slack', (path) => path.slack],
  ['classification', (path) => path.classification.label], ['disposition', (path) => path.classification.disposition],
  ['excluded', (path) => path.classification.excluded], ['review', (path) => path.classification.review],
  ['exception', (path) => path.exception], ['exception_kind', (path) => path.classification.kind ?? exceptionKind(path.exception)],
  ['exception_status', (path) => path.classification.status], ['source', (path) => path.source],
  ['exception_source', (path) => path.classification.source],
  ['launch_clock', (path) => path.launchClock], ['capture_clock', (path) => path.captureClock], ['clock_relation', (path) => path.clockRelation],
  ['timing_freshness', (path) => path.timingFreshness], ['constraint_freshness', (path) => path.constraintFreshness],
  ['timing_reasons', (path) => path.timingReasons.join('|')], ['constraint_reasons', (path) => path.constraintReasons.join('|')],
  ['freshness_reasons', (path) => path.freshnessReasons.join('|')],
  ['context', (path, report) => report.context], ['origin', (path) => path.origin],
  ['overall_evidence', (path, report) => report.evidence?.overall ?? 'unknown'],
  ['overall_evidence_reasons', (path, report) => overallReasons(report).join('|')],
  ['signoff_eligible', (path, report) => report.signoffEligible],
  ['candidate_id', (path, report) => path.rowType === 'modeled_candidate' ? report.candidate.id : ''],
  ['candidate_title', (path, report) => path.rowType === 'modeled_candidate' ? report.candidate.title : ''],
  ['startpoint', (path) => path.startpoint], ['endpoint', (path) => path.endpoint], ['reason', (path) => path.reason],
  ['snapshot_id', (path, report) => report.manifest?.snapshotId], ['exported_at', (path, report) => report.exportedAt]
];

/** Serialize every selected-analysis row and, when present, the modeled candidate rows. */
export function signoffCsv(report = {}) {
  const rows = [
    ...(report.baseline?.worstPaths ?? []).map((path) => pathRow(report, path)),
    ...(report.candidate?.paths ?? []).map((path) => pathRow(report, path, true))
  ];
  return [
    CSV_COLUMNS.map(([name]) => name).join(','),
    ...rows.map((path) => CSV_COLUMNS.map(([, value]) => csvCell(value(path, report))).join(','))
  ].join('\r\n') + '\r\n';
}
