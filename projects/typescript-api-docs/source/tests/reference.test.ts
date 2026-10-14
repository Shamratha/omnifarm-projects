import assert from 'node:assert/strict';
import test from 'node:test';
import { comparableApi, compareVersions, stableAnchor } from '../src/reference';

test('classifies additions, removals, generic/overload/documentation changes', () => {
  const old = { symbols: [
    { id: 'left.Entry', description: '**Old**', overloads: [{ signature: 'get<T>(value?: T): T', source: { line: 1 } }] },
    { id: 'removed', description: '' },
    { id: 'same', description: '', source: { line: 20 } },
  ] };
  const latest = { symbols: [
    { id: 'left.Entry', description: '**New**', overloads: [{ signature: 'get<T extends string>(value?: T): T', source: { line: 30 } }] },
    { id: 'right.Entry', description: '' },
    { id: 'same', description: '', source: { line: 50 } },
  ] };
  assert.deepEqual(compareVersions(latest, old), {
    added: ['right.Entry'], removed: ['removed'], changed: ['left.Entry'], common: ['same'],
  });
});

test('ignores source locations and member order but preserves overload order', () => {
  const a = { id: 'Box', members: [{ id: 'Box.a', source: { line: 1 } }, { id: 'Box.b' }], overloads: ['first', 'second'] };
  const b = { id: 'Box', members: [{ id: 'Box.b' }, { id: 'Box.a', source: { line: 8 } }], overloads: ['first', 'second'] };
  assert.deepEqual(comparableApi(a), comparableApi(b));
  assert.notDeepEqual(comparableApi(a), comparableApi({ ...b, overloads: ['second', 'first'] }));
});

test('anchors are stable and do not collide for namespace and escaped member names', () => {
  const values = ['cache.Store', 'stores.Store', 'Box.static:read', 'Box.static-3Aread', 'Box."a.b"'];
  assert.equal(new Set(values.map(stableAnchor)).size, values.length);
  for (const value of values) assert.equal(decodeURIComponent(stableAnchor(value)), value);
});
