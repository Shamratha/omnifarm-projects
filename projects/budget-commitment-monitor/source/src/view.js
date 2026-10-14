import { summarizeAnalyzed } from './finance.js';

export function toggleFilter(filters, filter) {
  if (filter === 'all') return [];
  return filters.includes(filter)
    ? filters.filter((value) => value !== filter)
    : [...filters, filter];
}

function matchesFilter(request, filter) {
  return filter === 'attention'
    ? request.flags.length > 0
    : request.flags.some((flag) => flag.type === filter);
}

// Always pass rows analyzed against the entire snapshot, before any filtering.
export function filterRequests(analyzed, { filters = [], query = '' } = {}) {
  const search = query.trim().toLowerCase();
  return analyzed.filter((request) => filters.every((filter) => matchesFilter(request, filter))
    && (!search || [request.title, request.department, request.vendor?.name, request.id]
      .some((value) => value?.toLowerCase().includes(search))));
}

// Counts describe the current intersection, not hypothetical broader views.
export function facetCounts(rows) {
  return Object.fromEntries([
    ['all', rows.length],
    ...['attention', 'untracked', 'overdue', 'policy']
      .map((filter) => [filter, rows.filter((request) => matchesFilter(request, filter)).length]),
  ]);
}

export function createView(analyzed, { filters = [], query = '', sortAscending = true } = {}) {
  const rows = filterRequests(analyzed, { filters, query })
    .sort((a, b) => a.title.localeCompare(b.title) * (sortAscending ? 1 : -1));
  return { rows, summary: summarizeAnalyzed(rows), counts: facetCounts(rows) };
}
