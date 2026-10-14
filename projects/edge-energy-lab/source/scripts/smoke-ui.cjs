#!/usr/bin/env node
'use strict';

// Local only. No installation is needed for --vm or npm test.
// node scripts/smoke-ui.cjs --vm
// node scripts/smoke-ui.cjs --browser chromium [--output /tmp/omnirush/ui-smoke-chromium]
// node scripts/smoke-ui.cjs --browser firefox
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.js can select existing tooling.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');

function sources() {
  return Object.fromEntries(['index.html', 'lab-core.js', 'app.js', 'styles.css']
    .map(name => [name, fs.readFileSync(path.join(ROOT, name), 'utf8')]));
}

function fingerprints(source) {
  return Object.fromEntries(['app.js', 'lab-core.js'].map(name => [name,
    crypto.createHash('sha256').update(source[name]).digest('hex')]));
}

function byteHash(text) {
  let hash = 2166136261;
  for (const byte of Buffer.from(text, 'utf8')) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function loadLab(source) {
  const context = vm.createContext({ TextEncoder });
  context.window = context;
  vm.runInContext(source['lab-core.js'], context, { filename: 'lab-core.js' });
  return context.EdgeLab;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function defaults(Lab) { return Object.fromEntries(Lab.MODELS.map(m => [m.id, m.defaultThreshold])); }
function text(html) { return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }

function modelCardText(snapshot, model) {
  const card = [...snapshot.cards.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)]
    .map(match => match[1]).find(html => text(html).includes(model.name));
  assert.ok(card, `visible model card for ${model.name}`);
  return text(card);
}

function frontierLegendText(snapshot, model) {
  const legend = [...snapshot.legend.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)]
    .map(match => text(match[1])).find(value => value.includes(model.name));
  assert.ok(legend, `visible frontier legend entry for ${model.name}`);
  return legend;
}

function assertSimulationLabels(snapshot, Lab, scenario) {
  const card = JSON.parse(snapshot.preview);
  assert.equal(card.dataset.scenario, scenario, 'simulation label scenario');
  for (const model of Lab.MODELS) {
    assert.match(modelCardText(snapshot, model), /\bSIMULATED\b/i, `${scenario}/${model.id}: model card needs a visible SIMULATED label`);
  }
  assert.match(text(snapshot.frontier), /SIMULATED LATENCY\s*\/\s*WINDOW/i, `${scenario}: frontier needs a visible simulated latency axis label`);
  const assumptions = text(snapshot.tradeoff);
  assert.match(assumptions, /not necessarily a better detector/i, 'comparison warns faster is not necessarily better');
  assert.match(assumptions, /Threshold tuning changes decisions, not the fixed cost estimate/i, 'comparison warns costs do not track threshold/alerts');
  assert.match(assumptions, /alert transmission and actuation energy are excluded/i, 'comparison warns alert energy is excluded');
  assert.match(assumptions, /Neither is hardware measured/i, 'comparison assumptions warn latency/p95 are not measured');
  assert.match(assumptions, /not measured peak RAM or flash/i, 'comparison memory assumption is visible');
  assert.match(assumptions, /4\.44 Wh; acquisition \+ inference only; no radio, idle, peripherals, losses/i, 'comparison battery scope is visible');
  assert.match(snapshot.context, /SIMULATED/, 'inspector context identifies simulated decisions');
  assert.match(text(snapshot.detail), /SIMULATED/, 'selected detail needs a visible SIMULATED label (not just an aria-label)');
  assert.match(text(snapshot.deployment), /SIMULATED/, 'deployment summary identifies simulated cost');
  assert.match(card.simulation.results, /SIMULATED/, 'JSON simulation.results identifies simulated results');
  assert.match(card.simulation.results, /not hardware measurements/i, 'JSON simulation.results warns results are not measured');
  assert.match(card.simulation.results, /not .*trained model benchmark/i, 'JSON simulation.results warns results are not a trained benchmark');
}

function assertFrontierUi(snapshot, Lab, thresholds, expectedFlags) {
  const dataset = Lab.createFixture('baseline');
  const points = Lab.MODELS.map(model => ({
    accuracy: Lab.evaluate(dataset, model, thresholds[model.id]).metrics.accuracy,
    latencyMs: Lab.estimateCost(model).latencyMsPerWindow
  }));
  const flags = Array.from(Lab.isParetoFrontier(points));
  assert.deepEqual(flags, expectedFlags, 'independent baseline accuracy/latency frontier membership');
  Lab.MODELS.forEach((model, index) => {
    const badge = modelCardText(snapshot, model).match(/PARETO FRONTIER|DOMINATED/g);
    assert.deepEqual(badge, [flags[index] ? 'PARETO FRONTIER' : 'DOMINATED'], `${model.name} card badge membership`);
    const membership = frontierLegendText(snapshot, model).match(/Efficient|Dominated/g);
    assert.deepEqual(membership, [flags[index] ? 'Efficient' : 'Dominated'], `${model.name} legend membership`);
    assert.ok(text(snapshot.frontier).includes(`${model.shortName} ${(points[index].accuracy * 100).toFixed(1)}%`), `${model.name} chart accuracy`);
  });
  const circles = [...snapshot.frontier.matchAll(/<circle\b[^>]*cx="([^"]+)"[^>]*cy="([^"]+)"/g)]
    .map(match => `${match[1]},${match[2]}`);
  assert.equal(circles.length, Lab.MODELS.length, 'frontier plots both profiles, including dominated ones');
  const line = /<polyline\b[^>]*points="([^"]*)"/.exec(snapshot.frontier);
  assert.ok(line, 'frontier chart has a membership line');
  assert.deepEqual(line[1].trim().split(/\s+/), circles.filter((_, index) => flags[index]), 'frontier line connects only efficient rendered profile points');
}

// Compare real rendered table cells, not private render functions.
function assertComparison(snapshot, Lab, scenario, thresholds, modelId) {
  const card = JSON.parse(snapshot.preview);
  const dataset = Lab.createFixture(scenario);
  const expected = plain(Lab.compareProfiles(dataset, Lab.MODELS, thresholds));
  assert.equal(card.dataset.scenario, scenario);
  assert.equal(card.model.id, modelId);
  assert.equal(card.threshold, thresholds[modelId]);
  assert.deepEqual(card.fasterProfileComparison, expected, 'comparison export must track both independent thresholds');
  assert.ok(expected.faster.costEstimate.latencyMs < expected.baseline.costEstimate.latencyMs);
  const fasterPercent = Math.abs(expected.deltas.latencyMs / expected.baseline.costEstimate.latencyMs * 100).toFixed(1);
  assert.ok(text(snapshot.tradeoff).includes(`${expected.faster.model.name} is ${fasterPercent}% faster.`));
  const headers = [...snapshot.tradeoff.matchAll(/<thead[^>]*>([\s\S]*?)<\/thead>/g)]
    .map(match => text(match[1])).join(' ');
  assert.ok(headers.includes(expected.faster.model.name + 'FASTER'), 'faster column label');
  assert.ok(headers.includes(expected.baseline.model.name + 'BASELINE'), 'baseline column label');
  const rows = new Map([...snapshot.tradeoff.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(match => {
    const heading = /<th[^>]*>([\s\S]*?)<\/th>/.exec(match[1]);
    return [heading && text(heading[1]), [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => text(cell[1]))];
  }));
  const numeric = value => Number(value.replace(/,/g, '').match(/[+-]?\d+(?:\.\d+)?/)[0]);
  for (const [label, field, group, digits, scale] of [
    ['Latency / window', 'latencyMs', 'costEstimate', 3, 1],
    ['Simulated p95', 'p95LatencyMs', 'costEstimate', 4, 1],
    ['Energy / window', 'energyMicroJPerWindow', 'costEstimate', 3, 1],
    ['Memory footprint', 'memoryBytes', 'costEstimate', 0, 1],
    ['Battery / 1,000', 'batteryPercentPer1000Windows', 'costEstimate', 6, 1],
    ['False alarms', 'falsePositives', 'metrics', 0, 1],
    ['Missed events', 'falseNegatives', 'metrics', 0, 1],
    ['Recall', 'recall', 'metrics', 1, 100]
  ]) {
    const cells = rows.get(label);
    assert.ok(cells && cells.length === 3, `comparison row: ${label}`);
    const values = [expected.faster[group][field], expected.baseline[group][field], expected.deltas[field]];
    cells.forEach((cell, index) => assert.equal(numeric(cell), Number((values[index] * scale).toFixed(digits)), `${label}, column ${index}`));
  }
  for (const [index, profile] of [expected.faster, expected.baseline].entries()) {
    const metrics = profile.metrics;
    assert.equal(rows.get('False alarms')[index], `${metrics.falsePositives} / ${metrics.trueNegatives + metrics.falsePositives} normal`);
    assert.equal(rows.get('Missed events')[index], `${metrics.falseNegatives} / ${metrics.truePositives + metrics.falseNegatives} anomalies`);
  }
  const { checksum, ...body } = card;
  assert.equal(checksum.algorithm, 'FNV-1a-32');
  assert.equal(checksum.value, byteHash(JSON.stringify(body)), 'independent UTF-8 checksum roundtrip');
  const model = Lab.MODELS.find(m => m.id === modelId);
  const replay = Lab.deploymentCard({ ...Lab.FIXTURE, scenario }, model, thresholds[modelId],
    Lab.evaluate(dataset, model, thresholds[modelId]).metrics, Lab.estimateCost(model),
    Lab.compareProfiles(dataset, Lab.MODELS, thresholds));
  assert.deepEqual(body, plain(replay), 'JSON export replays from local fixture and independent thresholds');
  assert.ok(snapshot.deployment.includes(checksum.value), 'visible checksum matches exported checksum');
  assertSimulationLabels(snapshot, Lab, scenario);
  return card;
}

function tableRows(html) {
  return [...html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)].map(match => ({
    id: /data-id="([^"]+)"/.exec(match[1])?.[1],
    model: /data-model="([^"]+)"/.exec(match[1])?.[1],
    cells: [...match[2].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => text(cell[1]))
  }));
}

// Expectations come from evaluation, independently of the new inspector projection/rendering.
function assertInspector(snapshot, Lab, scenario, thresholds, modelId, filter, selectedId) {
  const dataset = plain(Lab.createFixture(scenario));
  const model = Lab.MODELS.find(entry => entry.id === modelId);
  const result = plain(Lab.evaluate(dataset, model, thresholds[modelId]));
  const usable = new Set(result.rows.map(row => row.id));
  const expected = filter === 'all' ? dataset : filter === 'missing' ? dataset.filter(row => !usable.has(row.id))
    : result.rows.filter(row => filter === 'falsePositives' ? row.isFalsePositive
      : filter === 'falseNegatives' ? row.isFalseNegative : row.predicted === 1);
  assert.deepEqual(tableRows(snapshot.rows).map(row => row.id), expected.map(row => row.id),
    `${filter}: full filtered list, including windows beyond an initial page`);
  assert.equal(snapshot.filter, filter, 'active filter');
  assert.deepEqual(snapshot.timeline.map(cell => cell.id), dataset.map(row => row.id), 'all 256 timeline IDs in order');
  assert.ok(snapshot.timeline.every(cell => cell.tag === 'BUTTON' && ['true', 'false'].includes(cell.pressed)),
    'timeline consists of accessible pressed-state buttons');
  for (const [id, value] of Object.entries({ 'fp-count': result.metrics.falsePositives,
    'fn-count': result.metrics.falseNegatives, 'alert-count': result.metrics.truePositives + result.metrics.falsePositives,
    'window-count': dataset.length, 'missing-count': result.metrics.missingSamples })) {
    assert.equal(Number(snapshot.counts[id]), value, `${id} tracks current scenario/profile/threshold`);
  }
  assert.ok(snapshot.context.includes(model.name), 'inspector names active profile');
  assert.ok(snapshot.context.includes(thresholds[modelId].toFixed(2)), 'inspector shows current threshold');
  assert.ok(snapshot.context.includes(Lab.SCENARIOS.find(entry => entry.id === scenario).name), 'inspector names scenario');
  assert.match(snapshot.context, new RegExp(`${result.metrics.evaluated}\\s*/\\s*256`), 'inspector shows evaluated coverage');
  if (!selectedId) return;
  assert.deepEqual(snapshot.timeline.filter(cell => cell.pressed === 'true').map(cell => cell.id), [selectedId],
    'selection remains on the exact stable timeline ID');
  assert.ok(text(snapshot.detail).includes(selectedId), 'detail keeps stable window ID');
  const sample = dataset.find(row => row.id === selectedId);
  for (const [field, digits] of [['temperatureC', 2], ['vibrationG', 3], ['currentMa', 1]]) {
    if (sample[field] !== null) assert.ok(text(snapshot.detail).includes(sample[field].toFixed(digits)), `raw ${field}`);
    else assert.match(text(snapshot.detail), /null|missing|unavailable|—/i, 'missing raw value is explicit');
  }
  const comparison = /<table\b[^>]*class="[^"]*\bdecision-comparison\b[^"]*"[^>]*>([\s\S]*?)<\/table>/.exec(snapshot.detail);
  assert.ok(comparison, 'detail has a cross-profile decision-comparison table');
  const rows = tableRows(comparison[1]).filter(row => row.model);
  assert.deepEqual(rows.map(row => row.model).sort(), Array.from(Lab.MODELS, entry => entry.id).sort(), 'one decision per profile');
  for (const profile of Lab.MODELS) {
    const row = rows.find(entry => entry.model === profile.id);
    assert.equal(row.cells.length, 5, 'decision columns: name, score, threshold, margin, status');
    const [name, score, threshold, margin, status] = row.cells;
    assert.ok(name.includes(profile.name), 'decision profile name');
    assert.equal(Number(threshold), thresholds[profile.id], 'independent current decision threshold');
    const evaluated = Lab.evaluate(dataset, profile, thresholds[profile.id]).rows.find(entry => entry.id === selectedId);
    const expectedStatus = !evaluated ? 'skipped' : evaluated.isFalsePositive ? 'false-alarm'
      : evaluated.isFalseNegative ? 'missed-event' : evaluated.predicted ? 'correct-alert' : 'correct-reject';
    assert.equal(status.toLowerCase().replace(/\s+/g, '-'), expectedStatus, `status for ${profile.id}`);
    if (!evaluated) {
      assert.doesNotMatch(score, /\d/, 'skipped score must not be a fabricated numeric score');
      assert.doesNotMatch(margin, /\d/, 'skipped margin must not be a fabricated numeric margin');
    } else {
      assert.equal(Number(score), Number(evaluated.score.toFixed(3)), `score for ${profile.id}`);
      assert.equal(Number(margin.replace('−', '-')), Number((evaluated.score - thresholds[profile.id]).toFixed(3)), `margin for ${profile.id}`);
    }
  }
}

function createHarness(options = {}) {
  const source = sources();
  const elements = new Map();
  const created = [];
  const writes = [];
  const urls = [];
  const revoked = [];
  const downloads = [];
  const timers = [];
  const commands = [];
  const collections = new Map();
  let selected = null;
  let focused = null;
  class Element {
    constructor(tag, attributes = {}) {
      this.tagName = tag.toUpperCase();
      this.attributes = attributes;
      this.dataset = {};
      for (const [name, value] of Object.entries(attributes)) {
        if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
      }
      this.value = attributes.value || '';
      this.textContent = '';
      this.innerHTML = '';
      this.style = {};
      this.children = [];
      this.listeners = new Map();
      const classes = new Set((attributes.class || '').split(/\s+/));
      this.classList = { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } };
    }
    get innerHTML() { return this.html || ''; }
    set innerHTML(value) {
      this.html = value;
      for (const [selector, entry] of collections) if (entry.container === this) collections.delete(selector);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    async dispatch(type, properties = {}) {
      const event = { target: this, currentTarget: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...properties };
      for (const listener of this.listeners.get(type) || []) await listener(event);
      return event;
    }
    click() {
      if (this.tagName === 'A') {
        assert.ok(this.parentNode, 'download link attached before click');
        downloads.push({ href: this.href, filename: this.download });
      }
      return this.dispatch('click');
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    select() { selected = this; }
    focus() { focused = this; }
    scrollIntoView() {}
  }
  const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  const tabs = [];
  const filters = [];
  for (const match of source['index.html'].matchAll(/<([a-z][\w-]*)\b([^>]*)>/g)) {
    const attrs = attributes(match[2]);
    const element = new Element(match[1], attrs);
    if (attrs.id) elements.set('#' + attrs.id, element);
    if ((attrs.class || '').split(' ').includes('tab')) tabs.push(element);
    if ((attrs.class || '').split(' ').includes('filter')) filters.push(element);
  }
  const body = new Element('body');
  const inspector = new Element('section');
  function collection(selector) {
    if (selector === '.tab') return tabs;
    if (selector === '.filter') return filters;
    const spec = {
      '.inspect-model': ['#model-cards', 'button', 'inspect-model'],
      '.window-cell': ['#window-timeline', 'button', 'window-cell'],
      '#error-table tr': ['#error-table', 'tr']
    }[selector];
    assert.ok(spec, `unsupported collection ${selector}`);
    const [id, tag, className] = spec;
    const container = elements.get(id);
    assert.ok(container, `DOM stub needs real container ${id}`);
    // Keep nodes/listeners for a render. Re-querying must not return fresh, inert buttons.
    const cached = collections.get(selector);
    if (cached && cached.html === container.innerHTML) return cached.nodes;
    const nodes = [...container.innerHTML.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))]
      .filter(m => !className || (attributes(m[1]).class || '').split(/\s+/).includes(className))
      .map(m => new Element(tag, attributes(m[1])));
    collections.set(selector, { html: container.innerHTML, nodes, container });
    return nodes;
  }
  const document = {
    body,
    get activeElement() { return focused; },
    querySelector(selector) {
      if (selector === '.inspector') return inspector;
      const dynamic = /^(#error-table tr|\.window-cell|#window-timeline (?:button|\.window-cell))\[data-id="([^"]+)"\]$/.exec(selector);
      if (dynamic) return collection(dynamic[1].startsWith('#window-timeline') ? '.window-cell' : dynamic[1])
        .find(element => element.dataset.id === dynamic[2]) || null;
      const element = elements.get(selector);
      assert.ok(element, `DOM stub needs real selector ${selector}`);
      return element;
    },
    querySelectorAll: collection,
    createElement(tag) { const element = new Element(tag); created.push(element); return element; },
    execCommand(command) {
      assert.equal(command, 'copy');
      assert.ok(selected && selected.parentNode === body, 'fallback selects an attached textarea');
      commands.push({ command, text: selected.value });
      return options.execResult !== false;
    }
  };
  const navigator = {};
  if (options.clipboard !== 'absent') navigator.clipboard = { async writeText(value) {
    writes.push(value);
    if (options.clipboard === 'reject') throw new Error('Permission denied');
  } };
  const context = vm.createContext({ document, navigator, TextEncoder, Blob,
    URL: {
      createObjectURL(blob) { const url = `blob:local-smoke/${urls.length}`; urls.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
  });
  context.window = context;
  vm.runInContext(source['lab-core.js'], context, { filename: 'lab-core.js' });
  vm.runInContext(source['app.js'], context, { filename: 'app.js' });
  return {
    Lab: context.EdgeLab, source, writes, urls, revoked, downloads, timers, commands, created, body,
    element: selector => document.querySelector(selector),
    elements: selector => document.querySelectorAll(selector),
    get focused() { return focused; },
    click: selector => document.querySelector(selector).click(),
    window(id) {
      const button = collection('.window-cell').find(element => element.dataset.id === id);
      assert.ok(button, `timeline window ${id}`);
      return button;
    },
    row(id) {
      const row = document.querySelector(`#error-table tr[data-id="${id}"]`);
      assert.ok(row, `filtered row ${id}`);
      return row;
    },
    async filter(name) {
      const button = filters.find(element => element.dataset.filter === name);
      assert.ok(button, `real inspector filter ${name}`);
      await button.click();
      assert.equal(button.getAttribute('aria-pressed'), 'true');
    },
    async selectModel(id) {
      const tab = tabs.find(button => button.dataset.model === id);
      assert.ok(tab, `real profile tab ${id}`);
      await tab.click();
      assert.equal(tab.attributes['aria-selected'], 'true');
    },
    async threshold(value) { const element = elements.get('#threshold-slider'); element.value = String(value); await element.dispatch('input'); },
    async scenario(value) { const element = elements.get('#scenario-select'); element.value = value; await element.dispatch('change'); },
    inspectorSnapshot() {
      return { rows: elements.get('#error-table').innerHTML, detail: elements.get('#detail-panel').innerHTML,
        context: document.querySelector('#inspector-context').textContent,
        filter: filters.find(button => button.getAttribute('aria-pressed') === 'true')?.dataset.filter,
        counts: Object.fromEntries(['fp-count', 'fn-count', 'alert-count', 'window-count', 'missing-count']
          .map(id => [id, document.querySelector('#' + id).textContent])),
        timeline: collection('.window-cell').map(button => ({ id: button.dataset.id,
          tag: button.tagName, pressed: button.getAttribute('aria-pressed') })) };
    },
     snapshot() { return { preview: elements.get('#json-preview').textContent,
       cards: elements.get('#model-cards').innerHTML, frontier: elements.get('#frontier-chart').innerHTML,
       legend: elements.get('#frontier-legend').innerHTML, tradeoff: elements.get('#profile-tradeoff').innerHTML,
       deployment: elements.get('#deployment-card').innerHTML,
       context: elements.get('#inspector-context').textContent, detail: elements.get('#detail-panel').innerHTML,
       summary: elements.get('#threshold-summary').innerHTML }; }
  };
}

async function inspectorDefaults(ui) {
  await ui.scenario('field-noise');
  for (const model of ui.Lab.MODELS) { await ui.selectModel(model.id); await ui.click('#reset-threshold'); }
  await ui.selectModel(ui.Lab.MODELS[0].id);
  await ui.filter('falsePositives');
  return defaults(ui.Lab);
}

// These same observable flows run in the VM and actual browser.
const inspectorCases = [
  ['Inspector filters show full lists and timeline selections compare both default decisions', async ui => {
    const thresholds = await inspectorDefaults(ui);
    const modelId = ui.Lab.MODELS[0].id;
    await ui.rowClick('W0008');
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, modelId, 'falsePositives', 'W0008');
    for (const filter of ['falseNegatives', 'predicted', 'all', 'missing', 'falsePositives']) {
      await ui.filter(filter);
      assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, modelId, filter);
    }
    await ui.windowClick('W0008');
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, modelId, 'all', 'W0008');
    await ui.windowClick('W0024');
    const snapshot = await ui.inspectorSnapshot();
    assertInspector(snapshot, ui.Lab, 'field-noise', thresholds, modelId, 'all', 'W0024');
    const decisions = tableRows(snapshot.detail).filter(row => row.model);
    assert.notEqual(decisions[0].cells[1], decisions[1].cells[1], 'W0024 shows different per-profile scores');
    assert.notEqual(decisions[0].cells[2], decisions[1].cells[2], 'W0024 shows independent default thresholds');
    assert.notEqual(decisions[0].cells[3], decisions[1].cells[3], 'W0024 shows different signed decision margins');
  }],
  ['Inspector preserves window identity through tuning, reset, recommendation, profiles, and scenarios', async ui => {
    const thresholds = await inspectorDefaults(ui);
    const [first, second] = ui.Lab.MODELS;
    await ui.rowClick('W0008');
    await ui.threshold(0.73);
    thresholds[first.id] = 0.73;
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, first.id, 'falsePositives', 'W0008');
    await ui.windowClick('W0024');
    const tuned = await ui.inspectorSnapshot();
    assertInspector(tuned, ui.Lab, 'field-noise', thresholds, first.id, 'all', 'W0024');
    assert.match(text(tuned.detail), /MISSED[ -]EVENT/i, 'tuning Micro Threshold changes W0024 to a miss');
    assert.match(text(tuned.detail), /CORRECT[ -]ALERT/i, 'Tiny Linear still alerts at its independent default threshold');
    await ui.selectModel(second.id);
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, second.id, 'all', 'W0024');
    await ui.threshold(0.19);
    thresholds[second.id] = 0.19;
    await ui.selectModel(first.id);
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, first.id, 'all', 'W0024');
    await ui.click('#reset-threshold');
    thresholds[first.id] = first.defaultThreshold;
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, first.id, 'all', 'W0024');
    await ui.click('#apply-recommended');
    thresholds[first.id] = ui.Lab.recommendedThreshold(ui.Lab.thresholdSweep(ui.Lab.createFixture('field-noise'), first)).threshold;
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'field-noise', thresholds, first.id, 'all', 'W0024');
    for (const scenario of ['baseline', 'dropouts', 'field-noise']) {
      await ui.scenario(scenario);
      assertInspector(await ui.inspectorSnapshot(), ui.Lab, scenario, thresholds, first.id, 'all', 'W0024');
    }
  }],
  ['Inspector dropout gaps stay selectable with skipped decisions and Enter/Space row selection', async ui => {
    const thresholds = await inspectorDefaults(ui);
    const [first, second] = ui.Lab.MODELS;
    await ui.scenario('dropouts');
    const gap = ui.Lab.inspectWindows(ui.Lab.createFixture('dropouts'), ui.Lab.MODELS, thresholds)
      .find(entry => entry.id === 'W0007');
    assert.equal(gap.vibrationG, null, 'gap retains null raw vibration');
    assert.deepEqual(plain(gap.decisions.map(decision => ({ status: decision.status, score: decision.score,
      margin: decision.margin, predicted: decision.predicted }))), Array.from(ui.Lab.MODELS, () => ({
      status: 'skipped', score: null, margin: null, predicted: null })), 'both gap decisions stay null, never scored');
    await ui.windowClick('W0007');
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'dropouts', thresholds, first.id, 'missing', 'W0007');
    await ui.threshold(0.73);
    thresholds[first.id] = 0.73;
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'dropouts', thresholds, first.id, 'missing', 'W0007');
    await ui.selectModel(second.id);
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'dropouts', thresholds, second.id, 'missing', 'W0007');
    for (const [id, key] of [['W0036', 'Enter'], ['W0007', ' ']]) {
      await ui.rowKey(id, key);
      assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'dropouts', thresholds, second.id, 'missing', id);
      assert.equal(await ui.focusedRow(), id, 'keyboard selection restores focus to the re-rendered row');
    }
    await ui.filter('all');
    assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'dropouts', thresholds, second.id, 'all');
    for (const filter of ['falsePositives', 'falseNegatives', 'predicted', 'missing']) {
      await ui.filter(filter);
      assertInspector(await ui.inspectorSnapshot(), ui.Lab, 'dropouts', thresholds, second.id, filter);
    }
  }]
];

const inspectorVmCases = inspectorCases.map(([name, run]) => [name, async () => {
  const ui = createHarness();
  await run({ ...ui, windowClick: id => ui.window(id).click(), rowClick: id => ui.row(id).click(),
    rowKey: (id, key) => ui.row(id).dispatch('keydown', { key }), focusedRow: () => ui.focused?.dataset.id });
}]);

const presentationCases = [
  ['Baseline imbalance and current-threshold Pareto badges/legend reflect true membership', async ui => {
    const thresholds = defaults(ui.Lab);
    const [micro, linear] = ui.Lab.MODELS;
    await ui.scenario('baseline');
    // Establish both independent thresholds via UI input, regardless of prior cases.
    await ui.selectModel(linear.id);
    await ui.threshold(1);
    thresholds[linear.id] = 1;
    await ui.selectModel(micro.id);
    await ui.threshold(1);
    thresholds[micro.id] = 1;
    let snapshot = await ui.snapshot();
    const card = assertComparison(snapshot, ui.Lab, 'baseline', thresholds, micro.id);
    assert.equal(card.threshold, 1, 'Micro is selected at threshold 1');
    assert.equal(card.metrics.accuracy, 0.875, 'majority-class accuracy is misleadingly high');
    assert.equal(card.metrics.recall, 0, 'zero anomaly recall');
    assert.equal(card.metrics.f1, 0, 'zero F1');
    assert.equal(card.metrics.falseNegatives, 32, 'every anomaly is missed');
    assert.match(modelCardText(snapshot, micro), /ACCURACY\s*87\.5%/, 'visible Micro accuracy is 87.5%');
    assert.match(modelCardText(snapshot, micro), /RECALL\s*0\.0%/, 'visible Micro recall is zero');
    assert.match(modelCardText(snapshot, micro), /F1 SCORE\s*0\.0%/, 'visible Micro F1 is zero');
    assert.match(text(snapshot.summary), /32\s*MISSED EVENTS/, 'selected workbench shows 32 misses');
    assert.match(text(snapshot.deployment), /32 misses/, 'deployment summary shows 32 misses');
    await ui.filter('falseNegatives');
    const inspector = await ui.inspectorSnapshot();
    assertInspector(inspector, ui.Lab, 'baseline', thresholds, micro.id, 'falseNegatives', 'W0024');
    assert.equal(tableRows(inspector.rows).length, 32, 'all 32 misses are inspectable');
    assertFrontierUi(snapshot, ui.Lab, thresholds, [true, false]);

    await ui.selectModel(linear.id);
    await ui.threshold(0.5);
    thresholds[linear.id] = 0.5;
    snapshot = await ui.snapshot();
    assertComparison(snapshot, ui.Lab, 'baseline', thresholds, linear.id);
    assertFrontierUi(snapshot, ui.Lab, thresholds, [true, true]);

    await ui.selectModel(micro.id);
    await ui.threshold(0.01);
    thresholds[micro.id] = 0.01;
    snapshot = await ui.snapshot();
    assertComparison(snapshot, ui.Lab, 'baseline', thresholds, micro.id);
    assertFrontierUi(snapshot, ui.Lab, thresholds, [true, false]);
  }],
  ['Visible simulation labels, comparison warnings, and selection-neutral exports cover every scenario/profile', async ui => {
    const thresholds = defaults(ui.Lab);
    for (const [index, model] of ui.Lab.MODELS.entries()) {
      await ui.selectModel(model.id);
      thresholds[model.id] = index ? 0.73 : 0.19;
      await ui.threshold(thresholds[model.id]);
    }
    for (const scenario of ['baseline', 'field-noise', 'dropouts']) {
      await ui.scenario(scenario);
      for (const model of ui.Lab.MODELS) {
        await ui.selectModel(model.id);
        await ui.filter('all');
        const before = (await ui.snapshot()).preview;
        const beforeHash = JSON.parse(before).checksum.value;
        const unchanged = async action => {
          const snapshot = await ui.snapshot();
          assert.equal(snapshot.preview, before, `${scenario}/${model.id}/${action}: selection leaves exact payload bytes unchanged`);
          assert.equal(JSON.parse(snapshot.preview).checksum.value, beforeHash, `${action}: checksum unchanged`);
          assertComparison(snapshot, ui.Lab, scenario, thresholds, model.id);
        };
        for (const id of ['W0024', 'W0008']) {
          await ui.windowClick(id);
          assertInspector(await ui.inspectorSnapshot(), ui.Lab, scenario, thresholds, model.id, 'all', id);
          await unchanged(`timeline ${id}`);
        }
        await ui.rowClick('W0025');
        await unchanged('row click');
        for (const [id, key] of [['W0026', 'Enter'], ['W0027', ' ']]) {
          await ui.rowKey(id, key);
          await unchanged(`row ${key === ' ' ? 'Space' : key}`);
        }
        if (scenario === 'dropouts') {
          await ui.windowClick('W0007');
          assertInspector(await ui.inspectorSnapshot(), ui.Lab, scenario, thresholds, model.id, 'missing', 'W0007');
          await unchanged('missing gap');
        }
      }
    }
  }]
];

function vmUi() {
  const ui = createHarness();
  return { ...ui, windowClick: id => ui.window(id).click(), rowClick: id => ui.row(id).click(),
    rowKey: (id, key) => ui.row(id).dispatch('keydown', { key }), focusedRow: () => ui.focused?.dataset.id };
}

const presentationVmCases = presentationCases.map(([name, run]) => [name, () => run(vmUi())]);

const vmCases = [
  ...presentationVmCases,
  ['Copy JSON writes the exact current preview, including after scenario/profile/threshold changes', async () => {
    const ui = createHarness();
    await ui.click('#copy-json');
    assert.equal(ui.writes[0], ui.snapshot().preview);
    assert.equal(ui.element('#copy-status').textContent, 'Deployment JSON copied.');
    const initial = ui.writes[0];
    await ui.scenario('dropouts');
    await ui.selectModel(ui.Lab.MODELS[1].id);
    await ui.threshold(0.73);
    assert.equal(ui.element('#copy-status').textContent, '', 'render clears stale copy status');
    await ui.click('#copy-json');
    assert.notEqual(ui.writes[1], initial);
    assert.equal(ui.writes[1], ui.snapshot().preview, 'no stale JSON or added newline');
    assert.equal(ui.commands.length, 0);
  }],
  ['Clipboard rejection reports an honest download/select fallback', async () => {
    const ui = createHarness({ clipboard: 'reject' });
    await ui.click('#copy-json');
    assert.deepEqual(ui.writes, [ui.snapshot().preview]);
    assert.equal(ui.element('#copy-status').textContent, 'Clipboard unavailable. Download JSON or select the preview.');
    assert.equal(ui.commands.length, 0, 'denied Clipboard API does not claim legacy copy succeeded');
  }],
  ...[true, false].map(execResult => [
    `Absent Clipboard API checks execCommand=${execResult} and removes its selected textarea`, async () => {
      const ui = createHarness({ clipboard: 'absent', execResult });
      await ui.click('#copy-json');
      assert.deepEqual(ui.commands, [{ command: 'copy', text: ui.snapshot().preview }]);
      assert.equal(ui.writes.length, 0);
      assert.equal(ui.body.children.length, 0, 'temporary textarea removed on success and failure');
      assert.equal(ui.element('#copy-status').textContent, execResult
        ? 'Deployment JSON copied.' : 'Clipboard unavailable. Download JSON or select the preview.');
    }
  ]),
  ['Download uses preview + newline, JSON Blob, exact filename, and deferred object-URL revocation', async () => {
    const ui = createHarness();
    for (const [index, model] of ui.Lab.MODELS.entries()) {
      await ui.scenario(index ? 'dropouts' : 'baseline');
      await ui.selectModel(model.id);
      await ui.threshold(index ? 0.73 : 0.19);
      const preview = ui.snapshot().preview;
      const card = JSON.parse(preview);
      await ui.click('#download-json');
      const { blob, url } = ui.urls[index];
      assert.equal(blob.type, 'application/json');
      assert.equal(await blob.text(), preview + '\n');
      assert.deepEqual(ui.downloads[index], { href: url,
        filename: `deployment-card-${card.dataset.scenario}-${model.id}-${card.threshold.toFixed(2).replace('.', '-')}.json` });
      assert.equal(ui.body.children.length, 0, 'temporary anchor removed');
      assert.equal(ui.revoked.length, 0, 'URL remains valid after click/microtasks');
      assert.equal(ui.element('#copy-status').textContent, 'Deployment card download requested.');
    }
    assert.equal(ui.timers.length, 2, 'each download has deferred cleanup');
    for (const timer of ui.timers) {
      assert.ok(timer.delay > 0, 'revocation must be deferred');
      timer.callback();
    }
    assert.deepEqual(ui.revoked, ui.urls.map(item => item.url));
  }],
  ['Faster-profile table/export update for every scenario and both independent thresholds; checksum replays', async () => {
    const ui = createHarness();
    const thresholds = defaults(ui.Lab);
    const [faster, baseline] = [...ui.Lab.MODELS].sort((a, b) => ui.Lab.estimateCost(a).latencyMsPerWindow - ui.Lab.estimateCost(b).latencyMsPerWindow);
    const initial = ui.snapshot().preview;
    assertComparison(ui.snapshot(), ui.Lab, 'field-noise', thresholds, ui.Lab.MODELS[0].id);
    await ui.selectModel(faster.id);
    await ui.threshold(0.19);
    thresholds[faster.id] = 0.19;
    assertComparison(ui.snapshot(), ui.Lab, 'field-noise', thresholds, faster.id);
    await ui.selectModel(baseline.id);
    assert.equal(Number(ui.element('#threshold-slider').value), thresholds[baseline.id]);
    await ui.threshold(0.73);
    thresholds[baseline.id] = 0.73;
    assertComparison(ui.snapshot(), ui.Lab, 'field-noise', thresholds, baseline.id);
    await ui.selectModel(faster.id);
    assert.equal(Number(ui.element('#threshold-slider').value), 0.19, 'other profile threshold preserved');
    const previews = new Set();
    for (const scenario of ui.Lab.SCENARIOS) {
      await ui.scenario(scenario.id);
      assertComparison(ui.snapshot(), ui.Lab, scenario.id, thresholds, faster.id);
      previews.add(ui.snapshot().preview);
    }
    assert.equal(previews.size, ui.Lab.SCENARIOS.length, 'scenario changes exported fixture and comparison');
    await ui.scenario('field-noise');
    for (const model of ui.Lab.MODELS) {
      await ui.selectModel(model.id);
      await ui.click('#reset-threshold');
    }
    await ui.selectModel(ui.Lab.MODELS[0].id);
    assert.equal(ui.snapshot().preview, initial, 'scenario/threshold roundtrip is byte-for-byte repeatable');
  }],
  ...inspectorVmCases
];

function existingPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/tmp/omnirush/node_modules/playwright'];
  for (const candidate of candidates.filter(Boolean)) {
    try { return { api: require(candidate), modulePath: require.resolve(candidate) }; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error('No existing Playwright package found. Run --vm, or set PLAYWRIGHT_MODULE to an installed package.');
}

async function browserSmoke(browserName, output) {
  assert.ok(['chromium', 'firefox', 'webkit'].includes(browserName), 'choose chromium, firefox, or webkit');
  const { api, modulePath } = existingPlaywright();
  const source = sources();
  const Lab = loadLab(source);
  const http = require('node:http');
  const errors = [];
  const external = [];
  const checks = [];
  const server = http.createServer((request, response) => {
    const name = request.url === '/' ? 'index.html' : request.url.slice(1);
    if (!Object.hasOwn(source, name)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(source[name]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let context;
  try {
    browser = await api[browserName].launch({ headless: true,
      ...(browserName === 'chromium' ? { args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] } : {}) });
    context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
      external.push(url);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'load' });
    const snapshot = () => page.evaluate(() => ({ preview: document.querySelector('#json-preview').textContent,
      cards: document.querySelector('#model-cards').innerHTML,
      frontier: document.querySelector('#frontier-chart').innerHTML,
      legend: document.querySelector('#frontier-legend').innerHTML,
      tradeoff: document.querySelector('#profile-tradeoff').innerHTML,
      deployment: document.querySelector('#deployment-card').innerHTML,
      context: document.querySelector('#inspector-context').textContent,
      detail: document.querySelector('#detail-panel').innerHTML,
      summary: document.querySelector('#threshold-summary').innerHTML }));
    const selectModel = async id => {
      const tab = page.locator(`.tab[data-model="${id}"]`);
      await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
    };
    const threshold = value => page.locator('#threshold-slider').evaluate((element, number) => {
      element.value = String(number); element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    const thresholds = defaults(Lab);
    const first = (await snapshot()).preview;
    assertComparison(await snapshot(), Lab, 'field-noise', thresholds, Lab.MODELS[0].id);
    const paretoThresholds = defaults(Lab);
    await page.selectOption('#scenario-select', 'baseline');
    await selectModel(Lab.MODELS[1].id);
    await threshold(1);
    paretoThresholds[Lab.MODELS[1].id] = 1;
    await selectModel(Lab.MODELS[0].id);
    await threshold(1);
    paretoThresholds[Lab.MODELS[0].id] = 1;
    const majority = Lab.evaluate(Lab.createFixture('baseline'), Lab.MODELS[0], 1).metrics;
    assert.equal(majority.accuracy, 0.875, 'Micro threshold 1 majority-class accuracy');
    assert.equal(majority.recall, 0, 'Micro threshold 1 zero recall');
    assert.equal(majority.falseNegatives, 32, 'Micro threshold 1 misses every anomaly');
    assertFrontierUi(await snapshot(), Lab, paretoThresholds, [true, false]);
    await selectModel(Lab.MODELS[1].id);
    await threshold(0.5);
    paretoThresholds[Lab.MODELS[1].id] = 0.5;
    assertFrontierUi(await snapshot(), Lab, paretoThresholds, [true, true]);
    await selectModel(Lab.MODELS[0].id);
    await threshold(0.01);
    paretoThresholds[Lab.MODELS[0].id] = 0.01;
    assertFrontierUi(await snapshot(), Lab, paretoThresholds, [true, false]);
    checks.push('baseline imbalance and rendered Pareto badges/legend track current thresholds');
    for (const scenario of ['baseline', 'field-noise', 'dropouts']) {
      await page.selectOption('#scenario-select', scenario);
      const currentThresholds = defaults(Lab);
      for (const [index, model] of Lab.MODELS.entries()) {
        await selectModel(model.id);
        currentThresholds[model.id] = index ? 0.5 : 0.01;
        await threshold(currentThresholds[model.id]);
      }
      for (const model of Lab.MODELS) {
        await selectModel(model.id);
        const current = await snapshot();
        assertComparison(current, Lab, scenario, currentThresholds, model.id);
        const before = current.preview;
        await page.locator('.filter[data-filter="all"]').click();
        await page.locator('.window-cell[data-id="W0024"]').click();
        assert.equal((await snapshot()).preview, before, `${scenario}/${model.id} selection leaves preview bytes unchanged`);
      }
    }
    checks.push('all scenario/profile exports retain simulation labels and selection-neutral bytes/checksum');
    const inspectorUi = {
      Lab, selectModel, threshold, snapshot,
      scenario: value => page.selectOption('#scenario-select', value),
      click: selector => page.locator(selector).click(),
      filter: async name => {
        const button = page.locator(`.filter[data-filter="${name}"]`);
        await button.click();
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
      },
      windowClick: id => page.locator(`.window-cell[data-id="${id}"]`).click(),
      rowClick: id => page.locator(`#error-table tr[data-id="${id}"]`).click(),
      rowKey: async (id, key) => {
        const row = page.locator(`#error-table tr[data-id="${id}"]`);
        await row.focus();
        await row.press(key === ' ' ? 'Space' : key);
      },
      focusedRow: () => page.evaluate(() => document.activeElement?.dataset.id),
      inspectorSnapshot: () => page.evaluate(() => ({
        rows: document.querySelector('#error-table').innerHTML,
        detail: document.querySelector('#detail-panel').innerHTML,
        context: document.querySelector('#inspector-context').textContent,
        filter: document.querySelector('.filter[aria-pressed="true"]')?.dataset.filter,
        counts: Object.fromEntries(['fp-count', 'fn-count', 'alert-count', 'window-count', 'missing-count']
          .map(id => [id, document.getElementById(id).textContent])),
        timeline: [...document.querySelectorAll('.window-cell')].map(button => ({
          id: button.dataset.id, tag: button.tagName, pressed: button.getAttribute('aria-pressed') }))
      }))
    };
    for (const [name, run] of presentationCases) { await run(inspectorUi); checks.push(name); }
    for (const id of ['window-timeline', 'inspector-context', 'window-count', 'missing-count']) {
      assert.equal(await page.locator('#' + id).count(), 1, `inspector UI interface is not ready: missing #${id}`);
    }
    for (const [name, run] of inspectorCases) { await run(inspectorUi); checks.push(name); }
    const gapThresholds = await inspectorDefaults(inspectorUi);
    await inspectorUi.scenario('dropouts');
    await inspectorUi.windowClick('W0007');
    for (const [id, key] of [['W0036', 'Enter'], ['W0007', 'Space']]) {
      const button = page.locator(`.window-cell[data-id="${id}"]`);
      await button.focus();
      await button.press(key);
      assertInspector(await inspectorUi.inspectorSnapshot(), Lab, 'dropouts', gapThresholds, Lab.MODELS[0].id, 'missing', id);
    }
    checks.push('native timeline gap buttons activate with Enter and Space');
    await page.setViewportSize({ width: 375, height: 812 });
    await inspectorUi.windowClick('W0007');
    const mobile = await page.evaluate(() => ({ viewport: window.innerWidth,
      document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      timeline: document.querySelector('#window-timeline').getBoundingClientRect().toJSON(),
      detail: document.querySelector('#detail-panel').getBoundingClientRect().toJSON() }));
    assert.equal(mobile.viewport, 375);
    assert.ok(mobile.document <= 375 && mobile.body <= 375, `375px page overflow: ${JSON.stringify(mobile)}`);
    for (const name of ['timeline', 'detail']) {
      assert.ok(mobile[name].left >= 0 && mobile[name].right <= 375, `${name} stays within mobile viewport`);
    }
    assertInspector(await inspectorUi.inspectorSnapshot(), Lab, 'dropouts', gapThresholds, Lab.MODELS[0].id, 'missing', 'W0007');
    checks.push('375px viewport: no document/body horizontal overflow; timeline and detail stay in bounds');
    await page.setViewportSize({ width: 1280, height: 720 });
    await inspectorDefaults(inspectorUi);
    for (const [index, model] of Lab.MODELS.entries()) {
      await selectModel(model.id);
      assert.equal(Number(await page.locator('#threshold-slider').inputValue()), thresholds[model.id]);
      thresholds[model.id] = index ? 0.73 : 0.19;
      await threshold(thresholds[model.id]);
      assertComparison(await snapshot(), Lab, 'field-noise', thresholds, model.id);
    }
    const selectedId = Lab.MODELS[0].id;
    await selectModel(selectedId);
    assert.equal(Number(await page.locator('#threshold-slider').inputValue()), thresholds[selectedId]);
    const previews = new Set();
    for (const scenario of Lab.SCENARIOS) {
      await page.selectOption('#scenario-select', scenario.id);
      assertComparison(await snapshot(), Lab, scenario.id, thresholds, selectedId);
      previews.add((await snapshot()).preview);
    }
    assert.equal(previews.size, Lab.SCENARIOS.length);
    checks.push('scenario and both independent thresholds update visible faster-profile cells and replayable export');

    // Chromium can exercise the real OS clipboard in a permission-granted secure loopback context.
    // Other engines still exercise each app branch with controlled browser-side API boundaries.
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      const preview = (await snapshot()).preview;
      await page.click('#copy-json');
      await page.waitForFunction(() => document.querySelector('#copy-status').textContent === 'Deployment JSON copied.');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), preview);
      checks.push('native Clipboard API write/read equals preview exactly');
    }
    await page.evaluate(() => {
      window.__smokeWrites = [];
      window.__smokeCommands = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        async writeText(value) { window.__smokeWrites.push(value); }
      } });
    });
    await page.click('#copy-json');
    await page.waitForFunction(() => document.querySelector('#copy-status').textContent === 'Deployment JSON copied.');
    assert.deepEqual(await page.evaluate(() => window.__smokeWrites), [(await snapshot()).preview]);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { async writeText() { throw new DOMException('Denied', 'NotAllowedError'); } } }));
    await page.click('#copy-json');
    await page.waitForFunction(() => document.querySelector('#copy-status').textContent === 'Clipboard unavailable. Download JSON or select the preview.');
    for (const result of [true, false]) {
      await page.evaluate(result => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = command => {
          const area = document.querySelector('textarea');
          window.__smokeCommands.push({ command, text: area.value, connected: area.isConnected,
            selected: area.selectionStart === 0 && area.selectionEnd === area.value.length });
          return result;
        };
      }, result);
      await page.click('#copy-json');
      assert.equal(await page.locator('#copy-status').textContent(), result
        ? 'Deployment JSON copied.' : 'Clipboard unavailable. Download JSON or select the preview.');
      assert.equal(await page.locator('textarea').count(), 0);
    }
    const copiedPreview = (await snapshot()).preview;
    assert.deepEqual(await page.evaluate(() => window.__smokeCommands), [true, false].map(() => ({
      command: 'copy', text: copiedPreview, connected: true, selected: true
    })));
    checks.push('controlled Clipboard API success/rejection and absent API execCommand true/false');

    await page.evaluate(() => {
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      window.__smokeBlobs = [];
      window.__smokeRevoked = [];
      URL.createObjectURL = blob => {
        const url = create(blob);
        const item = { url, type: blob.type, createdAt: performance.now() };
        window.__smokeBlobs.push(item);
        item.ready = blob.text().then(bytes => { item.bytes = bytes; });
        return url;
      };
      URL.revokeObjectURL = url => {
        window.__smokeRevoked.push({ url, at: performance.now() });
        return revoke(url);
      };
      // Observe immediately after the app's handler, before any timer can run.
      // Checking after file I/O would be flaky on a slow machine with a 1s cleanup timer.
      document.querySelector('#download-json').addEventListener('click', () => {
        const item = window.__smokeBlobs[window.__smokeBlobs.length - 1];
        item.revokedAtClick = window.__smokeRevoked.some(entry => entry.url === item.url);
      });
    });
    const saved = [];
    if (output) {
      const relative = path.relative(ROOT, path.resolve(output));
      assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'artifacts must be outside the project');
      fs.mkdirSync(output, { recursive: true });
    }
    for (const [index, model] of Lab.MODELS.entries()) {
      const scenario = index ? 'dropouts' : 'baseline';
      await page.selectOption('#scenario-select', scenario);
      await selectModel(model.id);
      const current = await snapshot();
      const card = assertComparison(current, Lab, scenario, thresholds, model.id);
      const pending = page.waitForEvent('download');
      await page.click('#download-json');
      const download = await pending;
      const filename = `deployment-card-${scenario}-${model.id}-${card.threshold.toFixed(2).replace('.', '-')}.json`;
      assert.equal(download.suggestedFilename(), filename);
      assert.equal(await download.failure(), null);
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString('utf8'), current.preview + '\n', 'actual browser download bytes');
      const blob = await page.evaluate(async index => {
        const item = window.__smokeBlobs[index];
        await item.ready;
        return { url: item.url, type: item.type, bytes: item.bytes, createdAt: item.createdAt,
          revokedAtClick: item.revokedAtClick };
      }, index);
      assert.equal(blob.type, 'application/json');
      assert.equal(blob.bytes, current.preview + '\n');
      assert.equal(blob.revokedAtClick, false, 'object URL is not synchronously revoked by download handler');
      await page.waitForFunction(url => window.__smokeRevoked.some(entry => entry.url === url), blob.url);
      const revocation = await page.evaluate(url => window.__smokeRevoked.find(entry => entry.url === url), blob.url);
      assert.ok(revocation.at > blob.createdAt, 'native timer revokes URL later');
      assert.equal(await page.locator('#copy-status').textContent(), 'Deployment card download requested.');
      assert.equal(await page.locator('a[download]').count(), 0);
      if (output) { const destination = path.join(output, filename); await download.saveAs(destination); saved.push(destination); }
    }
    checks.push('native downloads: exact Blob/file bytes + newline, both filenames, deferred URL cleanup');

    await page.selectOption('#scenario-select', 'field-noise');
    for (const model of Lab.MODELS) { await selectModel(model.id); await page.click('#reset-threshold'); }
    await selectModel(Lab.MODELS[0].id);
    assert.equal((await snapshot()).preview, first, 'real UI roundtrip restores exact initial JSON/checksum');
    checks.push('byte-for-byte scenario/profile/threshold/checksum roundtrip');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(external, [], 'no external app requests (blocked if attempted)');
    assert.deepEqual(fingerprints(sources()), fingerprints(source), 'sources changed during run; rerun against latest app.js');
    const report = { browser: browserName, version: browser.version(), executable: api[browserName].executablePath(),
      playwright: modulePath, sourceSHA256: fingerprints(source), checks, externalRequests: external,
      pageErrors: errors, nativeClipboard: browserName === 'chromium',
      clipboardBoundaryLimit: 'rejection and execCommand true/false are controlled; only Chromium native clipboard write/read is asserted', saved };
    if (output) {
      const screenshot = path.join(output, 'ui-smoke.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      saved.push(screenshot, path.join(output, 'report.json'));
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { vmCases, inspectorVmCases, createHarness, assertComparison };

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/smoke-ui.cjs --vm | --browser chromium|firefox|webkit [--output /absolute/non-project/path]');
    return;
  }
  if (!args.length || (args.length === 1 && args[0] === '--vm')) {
    const before = fingerprints(sources());
    for (const [name, run] of vmCases) { await run(); console.log(`PASS ${name}`); }
    assert.deepEqual(fingerprints(sources()), before, 'sources changed during run; rerun against latest app.js');
    console.log(JSON.stringify({ runner: 'dependency-free Node vm DOM stub', tests: vmCases.length, sourceSHA256: before }, null, 2));
    return;
  }
  assert.equal(args[0], '--browser', 'use --vm or --browser');
  assert.ok(args.length === 2 || (args.length === 4 && args[2] === '--output'), 'unexpected arguments');
  await browserSmoke(args[1], args.length === 4 ? path.resolve(args[3]) : null);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
