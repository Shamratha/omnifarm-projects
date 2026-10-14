const pagePaths = { audit: '/', 'risk-tradeoffs': '/risk-tradeoffs', 'packet-preview': '/packet-preview' };

/** Resolve known local routes without silently substituting an unknown card. */
export function resolveRoute(pathname, search, cards) {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  const page = Object.keys(pagePaths).find((key) => pagePaths[key] === path);
  const models = new URLSearchParams(search).getAll('model');
  const modelId = models.length ? models[0] : cards[0]?.id;
  const problem = !page ? 'unknown-page'
    : models.length > 1 || !cards.some((card) => card.id === modelId) ? 'unknown-model' : null;
  return { page: problem ? 'not-found' : page, modelId, problem };
}

export function routeHref(page, modelId) {
  if (!Object.hasOwn(pagePaths, page)) throw new Error('Unknown workspace route');
  return `${pagePaths[page]}?${new URLSearchParams({ model: modelId })}`;
}
