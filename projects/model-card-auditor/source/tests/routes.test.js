import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, routeHref } from '../src/lib/routes.js';
import { modelCards } from '../src/data/modelCards.js';

test('known deep links preserve every selected model and round-trip URLs', () => {
  for (const page of ['audit', 'risk-tradeoffs', 'packet-preview']) {
    for (const card of modelCards) {
      const url = new URL(routeHref(page, card.id), 'http://localhost');
      assert.deepEqual(resolveRoute(url.pathname, url.search, modelCards), { page, modelId: card.id, problem: null });
      assert.deepEqual(resolveRoute(`${url.pathname === '/' ? '' : url.pathname}/`, url.search, modelCards), { page, modelId: card.id, problem: null });
    }
  }
});

test('a missing model parameter uses the default synthetic card', () => {
  for (const [path, page] of [['/', 'audit'], ['/risk-tradeoffs', 'risk-tradeoffs'], ['/packet-preview', 'packet-preview']]) {
    assert.deepEqual(resolveRoute(path, '', modelCards), { page, modelId: 'atlas-assist', problem: null });
  }
});

test('unknown, blank, and ambiguous model IDs fail instead of substituting a card', () => {
  for (const search of ['?model=unknown-card', '?model=', '?model=atlas-assist&model=harbor-screen', '?model=%3Cscript%3E']) {
    const route = resolveRoute('/packet-preview', search, modelCards);
    assert.equal(route.page, 'not-found');
    assert.equal(route.problem, 'unknown-model');
  }
});

test('unknown paths cannot expose a packet and route construction rejects unknown pages', () => {
  for (const path of ['/not-a-route', '/packet-preview/extra', '/RISK-TRADEOFFS']) {
    assert.equal(resolveRoute(path, '?model=harbor-screen', modelCards).problem, 'unknown-page');
  }
  assert.throws(() => routeHref('unknown', 'atlas-assist'), /Unknown workspace route/);
});

test('model IDs are safely encoded and not mixed with extra query parameters', () => {
  const id = 'fictional + name & punctuation?';
  const url = new URL(routeHref('packet-preview', id), 'http://localhost');
  assert.equal(url.searchParams.get('model'), id);
  assert.equal([...url.searchParams].length, 1);
  assert.deepEqual(resolveRoute('/packet-preview', url.search, [{ id }]), { page: 'packet-preview', modelId: id, problem: null });
});
