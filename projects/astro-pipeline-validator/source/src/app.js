import {
  createDashboardModel,
  formatValidationJsonReport,
  formatValidationReport,
  sampleBundle,
  validateBundle,
} from './validator.js';
import { boundaryRegressionBundle } from './regression-bundle.js';

const bundles = {
  sample: sampleBundle,
  boundary: boundaryRegressionBundle,
};

const state = {
  bundle: sampleBundle,
  result: validateBundle(sampleBundle),
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function displayValue(value, empty = '—') {
  if (value === null || value === undefined || value === '') return empty;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatDate(value) {
  if (!value) return '—';
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : String(value);
}

function formatUtc(value) {
  if (!value) return '—';
  return String(value).replace('.000Z', 'Z');
}

function formatExposure(seconds, unit = 's') {
  if (seconds === null || seconds === undefined) return '—';
  return `${formatNumber(seconds, 3)} ${unit}`;
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = displayValue(value);
}

function qualityScore(summary) {
  const score = 100 - (summary.errors ?? 0) * 10 - (summary.warnings ?? 0) * 4 - (summary.infos ?? 0);
  return Math.max(0, Math.min(100, score));
}

function scoreSummary(summary, score) {
  if (summary.status === 'pass') return 'Every active validation lens passed. This run is ready for downstream review.';
  if (summary.status === 'warn') return `The run is usable, with ${summary.warnings} finding${summary.warnings === 1 ? '' : 's'} to review before handoff.`;
  return `${summary.errors} blocking finding${summary.errors === 1 ? '' : 's'} need attention before this run is ready for downstream science.`;
}

function renderHeaderMetadata(bundle, normalized) {
  setText('#meta-target', normalized.target.name);
  setText('#meta-observatory', bundle.metadata?.OBSERVAT ?? bundle.observatory?.name);
  setText('#meta-date', formatDate(normalized.metadata.dateObsUtc ?? bundle.metadata?.['DATE-OBS']));
  setText('#meta-exposures', normalized.exposureLogs.length);
  setText('#meta-calibrations', normalized.calibrationFrames.length);
}

function renderOverview(result) {
  const { summary } = result;
  const score = qualityScore(summary);
  const statusLabel = summary.status === 'fail' ? 'Failing' : summary.status === 'warn' ? 'Warning' : 'Passing';
  const statusColor = summary.status === 'fail' ? 'error' : summary.status === 'warn' ? 'warning' : 'pass';

  setText('#score-value', score);
  setText('#status-word', statusLabel);
  setText('#score-summary', scoreSummary(summary, score));
  setText('#score-footnote', `${summary.totalFindings} finding${summary.totalFindings === 1 ? '' : 's'} · ${summary.checksPassed}/${result.checks.length} checks passed`);
  setText('#error-count', summary.errors);
  setText('#warning-count', summary.warnings);
  setText('#info-count', summary.infos);
  setText('#checks-summary', `${summary.checksPassed} passed · ${summary.checksFailed} failed · ${summary.checksWarned} warned`);
  setText('#findings-summary', `${summary.totalFindings} total · ${summary.errors} errors`);

  const fill = $('#score-meter-fill');
  if (fill) fill.style.width = `${score}%`;
  const statusWord = $('#status-word');
  if (statusWord) statusWord.dataset.status = statusColor;
}

function renderChecks(checks) {
  const container = $('#checks-grid');
  if (!container) return;
  container.innerHTML = checks.map((check) => {
    const status = check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : 'pass';
    const label = status === 'fail' ? 'Failed' : status === 'warn' ? 'Review' : 'Passed';
    const findingCount = check.findingIds.length;
    return `
      <article class="check-card" data-status="${status}">
        <div class="check-card-top">
          <span class="check-category">${escapeHtml(check.category)}</span>
          <span class="check-status">${label}</span>
        </div>
        <h4>${escapeHtml(check.title)}</h4>
        <div class="check-card-footer">
          <span>${findingCount} finding${findingCount === 1 ? '' : 's'}</span>
          <span aria-hidden="true">${status === 'pass' ? '✓' : '→'}</span>
        </div>
      </article>`;
  }).join('');
}

function renderFindings(findings) {
  const container = $('#findings-list');
  if (!container) return;
  if (findings.length === 0) {
    container.innerHTML = '<div class="empty-state">No findings. The bundle satisfies the active local validation profile.</div>';
    return;
  }

  container.innerHTML = findings.map((finding, index) => {
    const severity = finding.severity ?? 'warning';
    const evidence = JSON.stringify(finding.evidence ?? {}, null, 2);
    const standards = (finding.standards ?? []).map((standard) => `<span class="standards-tag">${escapeHtml(standard)}</span>`).join('');
    return `
      <details class="finding-card" ${index === 0 ? 'open' : ''}>
        <summary>
          <span class="finding-chevron" aria-hidden="true"></span>
          <span class="severity-tag ${escapeHtml(severity)}">${escapeHtml(severity)}</span>
          <span class="finding-title">${escapeHtml(finding.title)}</span>
          <span class="category-tag">${escapeHtml(finding.category)}</span>
          <span class="finding-id">${escapeHtml(finding.id)}</span>
        </summary>
        <div class="finding-content">
          <div>
            <h4>Why it matters</h4>
            <p>${escapeHtml(finding.explanation)}</p>
          </div>
          <div class="evidence-block">
            <h4>Evidence</h4>
            <pre>${escapeHtml(evidence)}</pre>
          </div>
          <div>
            <h4>Remediation</h4>
            <p>${escapeHtml(finding.remediation)}</p>
          </div>
          <div class="finding-standards">
            <span class="standards-label">Standards</span>
            ${standards}
          </div>
        </div>
      </details>`;
  }).join('');
}

function renderTarget(bundle, normalized) {
  const sourceTarget = bundle.target ?? {};
  setText('#target-name', normalized.target.name);
  setText('#target-ra', normalized.target.raDeg === null ? null : `${formatNumber(normalized.target.raDeg, 4)}°`);
  setText('#target-dec', normalized.target.decDeg === null ? null : `${formatNumber(normalized.target.decDeg, 4)}°`);
  setText('#target-frame', sourceTarget.coordinates?.frame ?? sourceTarget.frame ?? 'ICRS');
  setText('#target-aliases', normalized.target.aliases.length > 0 ? normalized.target.aliases.join(' · ') : 'None recorded');
}

function renderNormalizedMetadata(metadata) {
  const fields = [
    ['Time system', metadata.timeSystem],
    ['DATE-OBS → UTC', formatUtc(metadata.dateObsUtc)],
    ['Derived MJD', metadata.dateObsMjd],
    ['Leap second', metadata.dateObsLeapSecond],
    ['Exposure units', state.result.normalized.exposureUnits.join(', ') || 'None recorded'],
    ['Time scales observed', state.result.normalized.timeSystems.join(', ') || 'None recorded'],
  ];
  const container = $('#normalized-metadata');
  if (!container) return;
  container.innerHTML = fields.map(([label, value]) => `
    <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(displayValue(value))}</dd></div>
  `).join('');
}

function renderObservations(exposureLogs) {
  const body = $('#observations-body');
  setText('#observation-count', exposureLogs.length);
  if (!body) return;
  body.innerHTML = exposureLogs.length === 0
    ? '<tr><td class="table-empty" colspan="7">No normalized science exposures recorded.</td></tr>'
    : exposureLogs.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.id)}</td>
        <td>${escapeHtml(formatUtc(entry.startUtc))}</td>
        <td>${escapeHtml(formatExposure(entry.exposureSeconds, entry.exposureUnit))}</td>
        <td>${escapeHtml(displayValue(entry.filter))}</td>
        <td>${escapeHtml(formatNumber(entry.airmass, 2))}</td>
        <td>${escapeHtml(entry.altitudeDeg === null ? '—' : `${formatNumber(entry.altitudeDeg, 1)}°`)}</td>
        <td>${escapeHtml(displayValue(entry.timeSystem))}</td>
      </tr>`).join('');
}

function renderCalibrations(frames) {
  const body = $('#calibrations-body');
  setText('#calibration-count', frames.length);
  if (!body) return;
  body.innerHTML = frames.length === 0
    ? '<tr><td class="table-empty" colspan="5">No calibration frames recorded.</td></tr>'
    : frames.map((frame) => `
      <tr>
        <td>${escapeHtml(frame.id)}</td>
        <td>${escapeHtml(displayValue(frame.type))}</td>
        <td>${escapeHtml(formatExposure(frame.exposureSeconds, frame.exposureUnit))}</td>
        <td>${escapeHtml(displayValue(frame.filter))}</td>
        <td>${escapeHtml(frame.temperatureC === null ? '—' : `${formatNumber(frame.temperatureC, 1)}°C`)}</td>
      </tr>`).join('');
}

function renderWeather(records) {
  const container = $('#weather-list');
  setText('#weather-count', records.length);
  if (!container) return;
  container.innerHTML = records.length === 0
    ? '<div class="table-empty">No weather records recorded.</div>'
    : records.map((record) => `
      <div class="weather-record">
        <div class="weather-record-header"><strong>${escapeHtml(record.id)}</strong><span>local record</span></div>
        <div class="weather-values">
          <div class="weather-value"><span class="mini-label">Temp.</span><strong>${escapeHtml(record.temperatureC === null ? '—' : `${formatNumber(record.temperatureC, 1)} °C`)}</strong></div>
          <div class="weather-value"><span class="mini-label">Humidity</span><strong>${escapeHtml(record.humidityPct === null ? '—' : `${formatNumber(record.humidityPct, 1)} %`)}</strong></div>
          <div class="weather-value"><span class="mini-label">Wind</span><strong>${escapeHtml(record.windSpeedMps === null ? '—' : `${formatNumber(record.windSpeedMps, 1)} m/s`)}</strong></div>
          <div class="weather-value"><span class="mini-label">Pressure</span><strong>${escapeHtml(record.pressureHpa === null ? '—' : `${formatNumber(record.pressureHpa, 1)} hPa`)}</strong></div>
        </div>
      </div>`).join('');
}

function render() {
  const { bundle, result } = state;
  const dashboard = createDashboardModel(result);
  const { normalized } = dashboard;
  // Render the same canonical projection that JSON and Markdown export use.
  renderHeaderMetadata(bundle, normalized);
  renderOverview(dashboard);
  renderChecks(dashboard.checks);
  renderFindings(dashboard.findings);
  renderTarget(bundle, normalized);
  renderNormalizedMetadata(normalized.metadata);
  renderObservations(normalized.exposureLogs);
  renderCalibrations(normalized.calibrationFrames);
  renderWeather(normalized.weather);
}

function exportReport() {
  const report = formatValidationReport(state.result);
  const jsonReport = formatValidationJsonReport(state.result);
  const target = state.result.normalized.target.name ?? 'observation-run';
  const filenameBase = `astro-pipeline-validation-${String(target).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filenameBase}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
  const jsonLink = document.createElement('a');
  jsonLink.href = URL.createObjectURL(new Blob([jsonReport], { type: 'application/json;charset=utf-8' }));
  jsonLink.download = `${filenameBase}.json`;
  document.body.append(jsonLink);
  jsonLink.click();
  jsonLink.remove();
  setTimeout(() => URL.revokeObjectURL(jsonLink.href), 0);
  const status = $('#export-status');
  if (status) status.textContent = `Saved ${filenameBase}.md + .json`;
}

$('#export-report')?.addEventListener('click', exportReport);
$('#run-selector')?.addEventListener('change', () => {
  const selectedBundle = bundles[$('#run-selector')?.value] ?? sampleBundle;
  state.bundle = selectedBundle;
  state.result = validateBundle(selectedBundle);
  render();
});

render();
