/** URL-safe and collision-free IDs, independent of declaration line numbers. */
export function stableAnchor(value: string): string {
  return encodeURIComponent(value);
}

/** Source movement must not create a release change. Sort object keys and members. */
export function comparableApi(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(comparableApi);
    if (value.every(item => item && typeof item === 'object' && 'id' in item)) {
      items.sort((a, b) => {
        const left = String((a as { id: string }).id);
        const right = String((b as { id: string }).id);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    }
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'source')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, comparableApi(item)]));
}

export function compareVersions<T extends { id: string }>(
  latest: { symbols: T[] }, previous: { symbols: T[] },
): { added: string[]; removed: string[]; changed: string[]; common: string[] } {
  const current = new Map(latest.symbols.map(symbol => [symbol.id, symbol]));
  const old = new Map(previous.symbols.map(symbol => [symbol.id, symbol]));
  const added = [...current.keys()].filter(id => !old.has(id));
  const removed = [...old.keys()].filter(id => !current.has(id));
  const shared = [...current.keys()].filter(id => old.has(id));
  const changed = shared.filter(id =>
    JSON.stringify(comparableApi(current.get(id))) !== JSON.stringify(comparableApi(old.get(id))));
  return { added, removed, changed, common: shared.filter(id => !changed.includes(id)) };
}
