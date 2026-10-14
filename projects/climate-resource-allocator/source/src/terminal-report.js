import { formatNumber, formatPercent, formatUtc } from './presentation.js';

const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Format checked planning results as plain text without changing the inputs. */
export function formatSampleSummary(scenario, baseline, report, { expanded, noInventory, hilltop }) {
  const totals = [
    ['Demand', formatNumber(baseline.totals.demand)],
    ['Allocated', formatNumber(baseline.totals.allocated)],
    ['Unmet', formatNumber(baseline.totals.unmet)],
    ['Expired', formatNumber(baseline.totals.expired)],
    ['Usable inventory', formatNumber(baseline.totals.available)],
    ['Coverage', formatPercent(baseline.totals.coverage)],
  ];
  const labelWidth = Math.max(...totals.map(([label]) => label.length + 1));
  const shelters = new Map(baseline.shelters.map((shelter) => [shelter.id, shelter]));
  const change = expanded.totals.allocated - baseline.totals.allocated;

  const sections = [
    [
      'Climate Resource Allocator - sample scenario',
      `Synthetic snapshot: ${formatUtc(scenario.asOf)}`,
      'Synthetic planning only; not an emergency dispatch system.',
    ],
    [
      'Baseline summary',
      ...totals.map(([label, value]) => `  ${`${label}:`.padEnd(labelWidth)} ${value}`),
    ],
    [
      'Shelter coverage',
      ...scenario.shelters.map((shelter) =>
        `  ${shelter.name ?? shelter.id} (${shelter.id}): ${formatPercent(shelters.get(shelter.id).coverage)}`),
    ],
    [
      'Resources (demand / allocated / unmet)',
      ...scenario.resources.map((resource) => {
        const demand = sum(scenario.shelters.map((shelter) => shelter.demand?.[resource.id] ?? 0));
        const allocated = sum(baseline.allocations
          .filter((allocation) => allocation.resource === resource.id)
          .map((allocation) => allocation.quantity));
        const unmet = sum(baseline.shelters.map((shelter) => shelter.unmet[resource.id] ?? 0));
        return `  ${resource.name ?? resource.id} (${resource.unit ?? 'units'}): ${[demand, allocated, unmet].map(formatNumber).join(' / ')}`;
      }),
    ],
    [
      'Constraints and equity',
      '  Bottlenecks:',
      ...(baseline.bottlenecks.length
        ? baseline.bottlenecks.map((road) => `    ${road.name ?? road.id} (${road.id})`)
        : ['    none']),
      `  Excluded expired stock: ${formatNumber(report.expired.length)} lots / ${formatNumber(baseline.totals.expired)} units`,
      `  Equity: ${formatNumber(report.equity.metCount)}/${formatNumber(baseline.shelters.length)} met (${formatPercent(report.equity.floor)} per-resource floor)`,
    ],
    [
      'What-if scenarios',
      `  Road capacity 1.5x: allocated ${formatNumber(expanded.totals.allocated)} (${change >= 0 ? '+' : ''}${formatNumber(change)})`,
      `    Unmet: ${formatNumber(expanded.totals.unmet)}`,
      `  Inventory 0x: allocated ${formatNumber(noInventory.totals.allocated)}`,
      `    Unmet: ${formatNumber(noInventory.totals.unmet)}`,
      '  Hill access closed (hill-access):',
      `    Hilltop (hilltop): reachable ${hilltop.reachable}, delivered ${formatNumber(sum(Object.values(hilltop.allocated)))}`,
    ],
  ];

  return sections.map((lines) => lines.join('\n')).join('\n\n');
}
