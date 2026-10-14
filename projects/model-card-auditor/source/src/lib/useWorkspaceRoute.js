import { useCallback, useEffect, useState } from 'react';
import { resolveRoute, routeHref } from './routes.js';
import { modelCards } from '../data/modelCards.js';

const readRoute = () => resolveRoute(window.location.pathname, window.location.search, modelCards);

export function useWorkspaceRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = useCallback((page, modelId) => {
    const href = routeHref(page, modelId);
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.pushState(null, '', href);
    setRoute(readRoute());
  }, []);
  return [route, navigate];
}
