import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STATUS, PRIORITY, PRIORITY_STYLE, LEGEND, priorityBadge, renderLegend,
} from '../src/presentation.js';
import { scenario } from '../src/data.js';
import { allocate } from '../src/planner.js';
import { renderReport } from '../src/report.js';
import { contrastRatio, parseTokens } from './helpers/contrast.js';

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function legendEntries(html) {
  return [...html.matchAll(/<li\b[^>]*data-legend-status="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)]
    .map(([, key, entry]) => ({ key, entry }));
}

function shelterTable(html) {
  const start = html.indexOf('<section id="report-shelters"');
  assert.ok(start >= 0, 'missing shelter report section');
  const end = html.indexOf('</section>', start);
  const section = html.slice(start, end);
  const table = section.match(/<table\b[\s\S]*?<\/table>/)?.[0];
  assert.ok(table, 'missing shelter report table');
  return table;
}

function cells(row) {
  return [...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/g)].map(([, cell]) => cell);
}

test('priority vocabulary, styles, legend order and phase-aware descriptions are complete', () => {
  assert.deepEqual(PRIORITY, { critical: 'Critical', high: 'High', moderate: 'Moderate' });
  assert.deepEqual(PRIORITY_STYLE, {
    critical: { rank: 1, foreground: '--priority-critical-fg', background: '--priority-critical-bg' },
    high: { rank: 2, foreground: '--priority-high-fg', background: '--priority-high-bg' },
    moderate: { rank: 3, foreground: '--priority-moderate-fg', background: '--priority-moderate-bg' },
  });
  assert.deepEqual(LEGEND.priority, { title: 'Priority legend', keys: ['critical', 'high', 'moderate'] });

  for (const key of LEGEND.priority.keys) {
    assert.equal(STATUS[key].label, PRIORITY[key]);
    assert.match(STATUS[key].description, /equity/i, `${key} description must explain the equity phase`);
    assert.match(STATUS[key].description, /priority\s+fill/i, `${key} description must explain priority fill`);
    assert.ok(Object.isFrozen(STATUS[key]), `${key} status must be frozen`);
  }
});

test('priority tokens alias the intended status tones and pass independent contrast checks', () => {
  const tokens = parseTokens(source('tokens.css'));
  const toneByPriority = { critical: 'warn', high: 'caution', moderate: 'info' };
  for (const [key, tone] of Object.entries(toneByPriority)) {
    const style = PRIORITY_STYLE[key];
    assert.equal(tokens[style.foreground], tokens[`--status-${tone}-fg`], `${key} foreground alias`);
    assert.equal(tokens[style.background], tokens[`--status-${tone}-bg`], `${key} background alias`);
    for (const background of ['white', 'surface-hover', 'surface-stripe']) {
      const ratio = contrastRatio(tokens[style.foreground], tokens[`--${background}`]);
      assert.ok(ratio >= 4.5, `${key} foreground on ${background}: ${ratio.toFixed(3)}:1`);
    }
    const badgeRatio = contrastRatio(tokens[style.foreground], tokens[style.background]);
    assert.ok(badgeRatio >= 4.5, `${key} badge: ${badgeRatio.toFixed(3)}:1`);
  }
});

test('priority badges and legend markup expose rank, label and description in registry order', () => {
  const html = renderLegend('priority');
  assert.deepEqual(legendEntries(html).map(({ key }) => key), LEGEND.priority.keys);
  assert.equal((html.match(/data-legend="priority"/g) || []).length, 1);

  for (const key of LEGEND.priority.keys) {
    const definition = PRIORITY_STYLE[key];
    const entry = legendEntries(html).find((item) => item.key === key).entry;
    const expectedBadge = `<span class="priority ${key}" data-priority="${key}" title="${STATUS[key].description}"><span class="priority-rank" aria-hidden="true">${definition.rank}</span>${PRIORITY[key]}</span>`;
    assert.ok(entry.includes(expectedBadge), `${key} legend badge must contain its rank and label`);
    assert.equal(priorityBadge(key), expectedBadge, `${key} report badge must reuse the legend badge markup`);
    assert.match(entry, new RegExp(`<small>${STATUS[key].description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/small>`));
    assert.equal(text(entry).includes(STATUS[key].description), true);
  }
});

test('priority phase begins only after equity attempts and report priority rows preserve numeric columns', () => {
  const plan = allocate(scenario);
  const phases = plan.allocations.map(({ phase }) => phase);
  const lastEquity = phases.lastIndexOf('equity');
  const firstPriority = phases.indexOf('priority');
  assert.ok(lastEquity >= 0, 'baseline scenario must attempt equity allocation');
  assert.ok(firstPriority > lastEquity, 'priority fill must follow every equity attempt');

  const html = renderReport(scenario, plan);
  const legendStart = html.indexOf('data-legend="priority"');
  const sheltersStart = html.indexOf('<section id="report-shelters"');
  assert.ok(legendStart >= 0 && legendStart < sheltersStart, 'priority legend must occur once before report sections');
  assert.equal((html.match(/data-legend="priority"/g) || []).length, 1);

  const table = shelterTable(html);
  const headers = [...table.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)];
  assert.deepEqual(headers.flatMap(([, attributes], index) => /\breport-number\b/.test(attributes) ? [index] : []), [2, 4, 6, 7, 8]);
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].slice(1).map(([, row]) => cells(row));
  assert.equal(rows.length, scenario.shelters.length * scenario.resources.length);
  for (const row of rows) {
    const id = text(row[0]).match(/\(([^)]+)\)/)?.[1];
    const shelter = scenario.shelters.find((item) => item.id === id);
    assert.ok(shelter, `missing source shelter for ${text(row[0])}`);
    const badge = row[1].match(/<span\b([^>]*)>([\s\S]*?)<\/span>/)?.[0];
    assert.ok(badge, `${shelter.id} resource row needs a priority badge`);
    assert.equal(attribute(badge, 'data-priority'), shelter.priority);
    assert.match(badge, new RegExp(`class="priority ${shelter.priority}"`));
  }
});
