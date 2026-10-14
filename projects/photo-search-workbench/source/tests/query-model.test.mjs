import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, createRule, emptyQuery } from '../src/query-model.js';

test('query model creates typed nested group and rule shapes', () => {
  const root = emptyQuery();
  const nested = createGroup();
  nested.operator = 'OR';
  nested.children.push(createRule('tag', 'mountain'));
  root.children.push(nested);

  assert.deepEqual(root, {
    id: 'group-root',
    type: 'group',
    operator: 'AND',
    children: [{
      id: nested.id,
      type: 'group',
      operator: 'OR',
      children: [{ id: nested.children[0].id, type: 'rule', field: 'tag', operator: 'is', value: 'mountain' }],
    }],
  });
});
