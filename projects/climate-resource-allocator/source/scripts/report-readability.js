import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scenario } from '../src/data.js';
import { allocate } from '../src/planner.js';
import { REPORT, LEGEND, STATUS } from '../src/presentation.js';
import { renderReport } from '../src/report.js';

const plan = allocate(scenario);
const originalScenario = structuredClone(scenario);
const originalPlan = structuredClone(plan);
const html = renderReport(scenario, plan);
const bodyText = (value) => value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

assert.doesNotMatch(html, /NaN|Infinity/);
assert.equal((html.match(/data-legend="priority"/g) || []).length, 1);
assert.equal((html.match(/data-legend="report"/g) || []).length, 1);
for (const section of REPORT.sections) {
  const opening = `<section id="report-${section.id}"`;
  const start = html.indexOf(opening);
  assert.ok(start >= 0, `missing ${section.title}`);
  const end = html.indexOf('</section>', start);
  const markup = html.slice(start, end);
  assert.match(markup, new RegExp(`<h3[^>]*>${section.title}</h3>`));
  const tables = [...markup.matchAll(/<table\b[\s\S]*?<\/table>/g)].map(([table]) => table);
  assert.ok(tables.length > 0, `${section.title} needs a table`);
  for (const table of tables) {
    assert.match(table, /<caption>[^<]+<\/caption>/);
    assert.match(table, /<th scope="col">/);
    assert.match(table, /<th scope="row">|report-empty/);
  }
}
const priorityBadges = [...html.matchAll(/<span class="priority ([^"]+)" data-priority="([^"]+)"[^>]*>/g)];
assert.equal(priorityBadges.length, scenario.shelters.length * scenario.resources.length + 3);
for (const [, className, key] of priorityBadges) {
  assert.equal(className, key);
  assert.ok(STATUS[key] || key in { critical: 1, high: 1, moderate: 1 });
}
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
for (const selector of ['.priority {', '.priority-legend', '.priority-rank']) assert.ok(css.includes(selector), `missing readable priority style ${selector}`);
assert.ok(bodyText(html).includes('Critical') && bodyText(html).includes('High') && bodyText(html).includes('Moderate'));
const priorityLegend = html.match(/<section\b[^>]*data-legend="priority"[^>]*>([\s\S]*?)<\/section>/);
assert.ok(priorityLegend, 'report must include its priority legend');
for (const priority of LEGEND.priority.keys) {
  assert.match(bodyText(priorityLegend[1]), new RegExp(`\\b${STATUS[priority].label}\\b`), `priority legend must explain ${STATUS[priority].label}`);
}
assert.deepEqual(scenario, originalScenario, 'report rendering must not mutate the scenario');
assert.deepEqual(plan, originalPlan, 'report rendering must not mutate the plan');
console.log(`Report markup readability check passed.\n  Sections: ${REPORT.sections.length}\n  Tables: ${tablesCount(html)}\n  Priority badges: ${priorityBadges.length}`);

function tablesCount(markup) {
  return (markup.match(/<table\b/g) || []).length;
}
