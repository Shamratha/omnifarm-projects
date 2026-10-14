import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, listPhotos } from '../server/catalog.mjs';
import { compileQuery, QueryValidationError } from '../server/query.mjs';
import { createDateInterval, createGroup, createLabel, createLocation, createTags, emptyQuery } from '../src/query-model.js';

const root = mkdtempSync(join(tmpdir(), 'photo-search-query-'));
const db = openCatalog(join(root, 'catalog.sqlite'));

after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const rule = (id, field, operator, value) => ({ id, type: 'rule', field, operator, value });
const group = (id, operator, children) => ({ id, type: 'group', operator, children });

function search(query, sort = 'newest') {
  const compiled = compileQuery(query, sort);
  return listPhotos(db, compiled.where, compiled.params, compiled.orderBy);
}

function ids(query, sort = 'newest') {
  return search(query, sort).map((photo) => photo.id);
}

test('mixed nested operators return exactly the expected metadata', () => {
  const query = group('root', 'OR', [
    group('mountains', 'AND', [
      rule('mountain', 'tag', 'is', 'mountain'),
      rule('year', 'date', 'is', '2024'),
      rule('not-favorite', 'favorite', 'is_not', 'true'),
    ]),
    group('old-kyoto', 'AND', [
      rule('kyoto', 'location', 'contains', 'Kyoto'),
      rule('before', 'date', 'before', '2024-01-01'),
    ]),
  ]);

  assert.deepEqual(search(query).map(({ id, title, date, favorite, tags }) => ({ id, title, date, favorite, tags })), [
    { id: 'lofoten-fishing', title: 'Red Cabins of Reine', date: '2024-10-06', favorite: false, tags: ['mountain', 'architecture', 'coast'] },
    { id: 'dolomites-lake', title: 'Mirror Lake in the Dolomites', date: '2024-07-05', favorite: false, tags: ['mountain', 'lake', 'reflection'] },
    { id: 'alps-glacier', title: 'Glacier Blue, Swiss Alps', date: '2024-01-30', favorite: false, tags: ['mountain', 'snow', 'glacier'] },
    { id: 'dolomites-dawn', title: 'Dawn over the Dolomites', date: '2024-01-18', favorite: false, tags: ['mountain', 'snow', 'sunrise'] },
    { id: 'kyoto-grove', title: 'Bamboo Dawn, Kyoto', date: '2023-04-09', favorite: false, tags: ['forest', 'bamboo', 'sunrise'] },
  ]);
});

test('empty groups have boolean identities and all values remain bound', () => {
  assert.equal(search(group('and-empty', 'AND', [])).length, 24);
  assert.equal(search(group('or-empty', 'OR', [])).length, 0);

  const injection = rule('injection', 'title', 'contains', "' OR 1=1 --");
  assert.deepEqual(ids(group('literal', 'AND', [injection])), []);
  assert.deepEqual(compileQuery(injection).params, ["%' OR 1=1 --%"]);
});

test('contains treats percent, underscore, and backslash as literal text for tags and scalars', () => {
  const literalDb = openCatalog(join(root, 'literal.sqlite'));
  literalDb.prepare('INSERT INTO photos (id,title,filename,url,location,date,tags,label,favorite,color,width,height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'literal-values',
    '100%_literal',
    'literal.svg',
    '/photos/literal.svg',
    'C:\\photos\\',
    '2022-02-02',
    JSON.stringify(['100%', 'under_score', 'C:\\photos\\']),
    'Literal',
    0,
    '#000000',
    100,
    100,
  );

  const run = (query) => {
    const compiled = compileQuery(query);
    return listPhotos(literalDb, compiled.where, compiled.params, compiled.orderBy).map((photo) => photo.id);
  };
  assert.deepEqual(run(rule('percent-tag', 'tag', 'contains', '100%')), ['literal-values']);
  assert.deepEqual(run(rule('underscore-tag', 'tag', 'contains', 'under_score')), ['literal-values']);
  assert.deepEqual(run(rule('backslash-tag', 'tag', 'contains', 'C:\\photos\\')), ['literal-values']);
  assert.deepEqual(run(rule('percent-scalar', 'title', 'contains', '100%_')), ['literal-values']);
  assert.deepEqual(run(rule('backslash-scalar', 'location', 'contains', 'C:\\photos\\')), ['literal-values']);
  assert.deepEqual(run(rule('wildcard-on-normal-data', 'tag', 'contains', '%')), ['literal-values']);
  literalDb.close();
});

test('date years and full dates use complementary and strict calendar semantics', () => {
  assert.deepEqual(ids(rule('year', 'date', 'is', '2024')), [
    'fjord-snow', 'forest-mist', 'lofoten-fishing', 'dolomites-larch', 'coast-boardwalk',
    'dolomites-lake', 'algarve-caves', 'alps-meadow', 'joshua-stars', 'kyoto-lanterns',
    'lofoten-ridge', 'alps-glacier', 'dolomites-dawn',
  ]);
  assert.deepEqual(ids(rule('not-year', 'date', 'is_not', '2024')), [
    'kyoto-hills', 'coast-pines', 'lofoten-summer', 'algarve-village', 'joshua-cactus', 'city-dolomite',
    'alps-cabin', 'joshua-arch', 'algarve-cliffs', 'desert-dunes', 'kyoto-grove',
  ]);
  assert.deepEqual(ids(rule('exact-date', 'date', 'is', '2024-01-18')), ['dolomites-dawn']);
  assert.equal(ids(rule('not-exact-date', 'date', 'is_not', '2024-01-18')).length, 23);
  assert.deepEqual(ids(rule('before', 'date', 'before', '2024-01-01')), ['alps-cabin', 'joshua-arch', 'algarve-cliffs', 'desert-dunes', 'kyoto-grove']);
  assert.deepEqual(ids(rule('after', 'date', 'after', '2025-01-01')), ['kyoto-hills', 'coast-pines', 'lofoten-summer', 'algarve-village', 'joshua-cactus', 'city-dolomite']);
});

test('invalid fields, operators, types, sorts, and dates are rejected', () => {
  assert.throws(() => compileQuery(rule('field', 'author', 'is', 'x')), QueryValidationError);
  assert.throws(() => compileQuery(rule('operator', 'tag', 'before', 'x')), QueryValidationError);
  assert.throws(() => compileQuery(rule('value-type', 'tag', 'is', 123)), QueryValidationError);
  assert.throws(() => compileQuery(null), QueryValidationError);
  assert.throws(() => compileQuery([]), QueryValidationError);
  assert.throws(() => compileQuery(group('children-type', 'AND', {})), QueryValidationError);
  assert.throws(() => compileQuery({ id: 123, type: 'group', operator: 'AND', children: [] }), QueryValidationError);
  assert.throws(() => compileQuery(group('root', 'XOR', [])), QueryValidationError);
  assert.throws(() => compileQuery(rule('sort', 'title', 'is', 'x'), '__proto__'), QueryValidationError);
  assert.throws(() => compileQuery(rule('sort-type', 'title', 'is', 'x'), {}), QueryValidationError);

  for (const value of ['0000', '10000', '2023-02-29', '2024-02-30', '2024-13-01', '2024-00-10', '2024-04-31']) {
    assert.throws(() => compileQuery(rule(`invalid-${value}`, 'date', 'is', value)), QueryValidationError, value);
  }
  for (const value of ['2024', '2024-02-30', '0000-01-01']) {
    assert.throws(() => compileQuery(rule(`invalid-before-${value}`, 'date', 'before', value)), QueryValidationError, value);
    assert.throws(() => compileQuery(rule(`invalid-after-${value}`, 'date', 'after', value)), QueryValidationError, value);
  }
  assert.doesNotThrow(() => compileQuery(rule('first-year', 'date', 'is', '0001')));
  assert.doesNotThrow(() => compileQuery(rule('last-year', 'date', 'is_not', '9999')));
});

test('node, depth, and child bounds are enforced', () => {
  assert.throws(() => compileQuery(group('too-many-children', 'AND', Array.from({ length: 101 }, (_, index) => rule(`rule-${index}`, 'tag', 'is', 'mountain')))), /100/);

  const manyNodes = group('many', 'AND', Array.from({ length: 6 }, (_, groupIndex) => group(`group-${groupIndex}`, 'AND', Array.from({ length: 100 }, (_, index) => rule(`rule-${groupIndex}-${index}`, 'tag', 'is', 'mountain')))));
  assert.throws(() => compileQuery(manyNodes), /500/);

  let tooDeep = group('depth-0', 'AND', []);
  const root = tooDeep;
  for (let depth = 1; depth <= 9; depth += 1) {
    const child = group(`depth-${depth}`, 'AND', []);
    tooDeep.children = [child];
    tooDeep = child;
  }
  assert.throws(() => compileQuery(root), /8/);
});

test('negative favorite and tag searches and allowlisted sorts have stable order', () => {
  assert.deepEqual(ids(rule('not-favorite', 'favorite', 'is_not', 'true')), [
    'kyoto-hills', 'coast-pines', 'lofoten-summer', 'algarve-village', 'joshua-cactus', 'city-dolomite',
    'forest-mist', 'lofoten-fishing', 'coast-boardwalk', 'dolomites-lake', 'alps-glacier', 'dolomites-dawn',
    'alps-cabin', 'joshua-arch', 'algarve-cliffs', 'desert-dunes', 'kyoto-grove',
  ]);
  assert.deepEqual(ids(rule('not-mountain', 'tag', 'is_not', 'mountain')), [
    'coast-pines', 'algarve-village', 'joshua-cactus', 'forest-mist', 'coast-boardwalk', 'algarve-caves',
    'joshua-stars', 'kyoto-lanterns', 'joshua-arch', 'algarve-cliffs', 'desert-dunes', 'kyoto-grove',
  ]);

  const oldest = ids({ id: 'all', type: 'group', operator: 'AND', children: [] }, 'oldest');
  assert.deepEqual(oldest.slice(0, 5), ['kyoto-grove', 'desert-dunes', 'algarve-cliffs', 'joshua-arch', 'alps-cabin']);
  assert.deepEqual(oldest.slice(-3), ['lofoten-summer', 'coast-pines', 'kyoto-hills']);
  const titled = search({ id: 'all', type: 'group', operator: 'AND', children: [] }, 'title');
  assert.deepEqual(titled.slice(0, 3).map((photo) => photo.title), ['Alpine Meadow in June', 'Bamboo Dawn, Kyoto', 'Blue Hills beyond Kyoto']);
  assert.ok(titled.every((photo, index) => index === 0 || titled[index - 1].title.localeCompare(photo.title) <= 0));
});

test('canonical filters search tags, labels, inclusive dates, and locations', () => {
  const photos = search(emptyQuery());
  const anyTags = createTags(['MOUNTAIN', 'desert'], 'any');
  assert.deepEqual(ids(anyTags), photos.filter((photo) => photo.tags.some((tag) => ['mountain', 'desert'].includes(tag))).map((photo) => photo.id));

  const allTags = createTags(['mountain', 'snow'], 'all');
  assert.deepEqual(new Set(ids(allTags)), new Set(['dolomites-dawn', 'lofoten-ridge', 'alps-glacier', 'alps-cabin', 'fjord-snow']));

  const noTags = createTags(['mountain', 'desert'], 'none');
  assert.deepEqual(ids(noTags), photos.filter((photo) => !photo.tags.includes('mountain') && !photo.tags.includes('desert')).map((photo) => photo.id));
  assert.equal(compileQuery(noTags).where.match(/NOT EXISTS/g)?.length, 2);
  for (const query of [anyTags, allTags, noTags]) {
    assert.match(compileQuery(query).where, /EXISTS \(SELECT 1 FROM json_each\(p.tags\)/);
  }
  assert.deepEqual(ids(createTags(['mount'], 'any')), []);
  assert.deepEqual(ids(createTags(['mountain', 'MOUNTAIN'], 'all')), ids(createTags(['mountain'])));

  assert.deepEqual(ids(createLabel('nAtUrE')), photos.filter((photo) => photo.label === 'Nature').map((photo) => photo.id));
  assert.deepEqual(ids(createLabel('Nat')), []);
  assert.deepEqual(ids(createDateInterval('2024-01-18', '2024-01-30')), ['alps-glacier', 'dolomites-dawn']);
  assert.deepEqual(ids(createLocation('kYoto, jApAn', 'is')), ['kyoto-hills', 'forest-mist', 'kyoto-lanterns', 'kyoto-grove']);
  assert.deepEqual(ids(createLocation('Kyoto', 'is')), []);
  assert.deepEqual(ids(createLocation('NORWAY', 'contains')), photos.filter((photo) => photo.location.includes('Norway')).map((photo) => photo.id));
  assert.deepEqual(ids(createLocation('japan', 'is_not')), photos.filter((photo) => !photo.location.includes('Japan')).map((photo) => photo.id));
  // Legacy is_not remains exact inequality; canonical is_not means not contains.
  assert.equal(ids(rule('legacy-location', 'location', 'is_not', 'Japan')).length, 24);
});

test('canonical date intervals support inclusive one-sided and same-day bounds', () => {
  assert.deepEqual(ids(createDateInterval(undefined, '2023-04-09')), ['kyoto-grove']);
  assert.deepEqual(ids(createDateInterval('2025-11-02')), ['kyoto-hills']);
  assert.deepEqual(ids(createDateInterval('2024-01-18', '2024-01-18')), ['dolomites-dawn']);
  assert.deepEqual(ids(createDateInterval('0001-01-01', '9999-12-31')), ids(emptyQuery()));
  for (const [query, params, predicates] of [
    [createDateInterval('2024-01-18'), ['2024-01-18'], ['p.date >= ?']],
    [createDateInterval(undefined, '2024-01-30'), ['2024-01-30'], ['p.date <= ?']],
    [createDateInterval('2024-01-18', '2024-01-30'), ['2024-01-18', '2024-01-30'], ['p.date >= ?', 'p.date <= ?']],
  ]) {
    const compiled = compileQuery(query);
    assert.deepEqual(compiled.params, params);
    assert.equal((compiled.where.match(/\?/g) ?? []).length, params.length);
    for (const predicate of predicates) assert.ok(compiled.where.includes(predicate));
    for (const value of params) assert.ok(!compiled.where.includes(value));
  }
});

test('canonical filters preserve nested mixed AND/OR semantics and empty identities', () => {
  const query = createGroup('OR', [
    createGroup('AND', [createTags(['mountain', 'snow'], 'all'), createDateInterval('2024-01-01', '2024-01-31')]),
    createGroup('AND', [createTags(['coast', 'architecture'], 'any'), createLocation('Portugal', 'contains')]),
  ]);

  assert.deepEqual(new Set(ids(query)), new Set(['alps-glacier', 'dolomites-dawn', 'algarve-caves', 'algarve-village', 'algarve-cliffs', 'coast-boardwalk']));
  assert.equal(ids({ id: 'empty-any', type: 'group', operator: 'AND', children: [createTags([], 'any')] }).length, 0);
  assert.equal(ids({ id: 'empty-all', type: 'group', operator: 'AND', children: [createTags([], 'all')] }).length, 24);
  assert.equal(ids(createTags([], 'none')).length, 24);
  assert.equal(search(emptyQuery()).length, 24);
  assert.equal(compileQuery({ id: 'empty-or', type: 'group', operator: 'OR', children: [] }).where, '1 = 0');
  for (const operator of ['AND', 'OR']) {
    const identity = operator === 'AND' ? createGroup('AND') : createGroup('OR');
    const annihilator = operator === 'AND' ? createGroup('OR') : createGroup('AND');
    assert.deepEqual(ids(createGroup(operator, [identity, query])), ids(query));
    assert.equal(ids(createGroup(operator, [annihilator, query])).length, operator === 'AND' ? 0 : 24);
  }
});

test('canonical and legacy operands retain their boolean grouping', () => {
  assert.deepEqual(ids(createGroup('AND', [
    rule('not-year', 'date', 'is_not', '2024'),
    createLocation('Japan', 'contains'),
  ])), ['kyoto-hills', 'kyoto-grove']);
  assert.deepEqual(ids(createGroup('OR', [
    createGroup('AND', [rule('year', 'date', 'is', '2024'), createTags(['snow'])]),
    createDateInterval('2025-11-02', '2025-11-02'),
  ])), ['kyoto-hills', 'fjord-snow', 'lofoten-ridge', 'alps-glacier', 'dolomites-dawn']);
});

test('canonical values are bound and injection-like literals stay literal', () => {
  const injection = "' OR 1=1 --";
  const query = createGroup('AND', [
    createTags([injection], 'any'),
    createLabel(injection),
    createLocation(injection, 'contains'),
    createDateInterval('2024-01-01', '2024-12-31'),
  ]);
  const compiled = compileQuery(query);

  assert.deepEqual(compiled.params, [injection, injection, `%${injection}%`, '2024-01-01', '2024-12-31']);
  assert.ok(!compiled.where.includes(injection));
  assert.deepEqual(ids(query), []);
  const nodes = [
    [createTags([injection, 'mountain'], 'any'), [injection, 'mountain']],
    [createTags([injection, 'mountain'], 'all'), [injection, 'mountain']],
    [createTags([injection, 'mountain'], 'none'), [injection, 'mountain']],
    [createLabel(injection), [injection]],
    [createLocation(injection, 'is'), [injection]],
    [createLocation(injection, 'contains'), [`%${injection}%`]],
    [createLocation(injection, 'is_not'), [`%${injection}%`]],
  ];
  for (const [node, params] of nodes) {
    const result = compileQuery(node);
    assert.deepEqual(result.params, params);
    assert.equal((result.where.match(/\?/g) ?? []).length, params.length);
    assert.ok(!result.where.includes(injection));
  }
  for (const node of [createTags([injection]), createTags([injection], 'all'), createLabel(injection), createLocation(injection), createLocation(injection, 'contains')]) {
    assert.deepEqual(ids(node), []);
  }
  assert.equal(ids(createTags([injection], 'none')).length, 24);
  assert.equal(ids(createLocation(injection, 'is_not')).length, 24);
});

test('canonical injection-like and wildcard values match literal stored metadata', () => {
  const literalDb = openCatalog(join(root, 'canonical-literal.sqlite'));
  try {
    literalDb.exec('DELETE FROM photos');
    const insert = literalDb.prepare('INSERT INTO photos (id,title,filename,url,location,date,tags,label,favorite,color,width,height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const injection = "' OR 1=1 --";
    const wildcard = '100%_C:\\photos\\';
    for (const [id, value] of [['injection', injection], ['wildcard', wildcard], ['near-wildcard', '100xyzAC:photos'], ['normal', 'ordinary']]) {
      insert.run(id, value, 'literal.svg', '/photos/literal.svg', value, '2024-02-29', JSON.stringify([value]), value, 0, '#000000', 100, 100);
    }
    const run = (query) => {
      const compiled = compileQuery(query);
      return listPhotos(literalDb, compiled.where, compiled.params, compiled.orderBy).map((photo) => photo.id);
    };
    for (const [id, value] of [['injection', injection], ['wildcard', wildcard]]) {
      for (const query of [createTags([value], 'any'), createTags([value], 'all'), createLabel(value), createLocation(value), createLocation(value, 'contains')]) {
        assert.deepEqual(run(query), [id]);
      }
      const others = ['injection', 'near-wildcard', 'normal', 'wildcard'].filter((candidate) => candidate !== id);
      assert.deepEqual(run(createTags([value], 'none')), others);
      assert.deepEqual(run(createLocation(value, 'is_not')), others);
    }
    for (const value of ['%', '_', '\\']) {
      assert.deepEqual(run(createLocation(value, 'contains')), ['wildcard']);
      assert.deepEqual(run(createLocation(value, 'is_not')), ['injection', 'near-wildcard', 'normal']);
    }
    assert.deepEqual(run(createDateInterval('2024-02-29', '2024-02-29')), ['injection', 'near-wildcard', 'normal', 'wildcard']);
  } finally {
    literalDb.close();
  }
});

test('canonical node validation rejects malformed values and date intervals', () => {
  assert.throws(() => compileQuery(createTags([''], 'any')), QueryValidationError);
  assert.throws(() => compileQuery(createTags(['mountain'], 'some')), QueryValidationError);
  assert.throws(() => compileQuery(createTags([123], 'all')), QueryValidationError);
  assert.throws(() => compileQuery(createLabel('   ')), QueryValidationError);
  assert.throws(() => compileQuery(createLocation('Kyoto', 'near')), QueryValidationError);
  assert.throws(() => compileQuery(createLocation('', 'is')), QueryValidationError);
  assert.throws(() => compileQuery(createDateInterval()), /at least one bound/);
  for (const value of ['', ' ', null, 2024, {}, [], '2024', '2023-02-29', '1900-02-29', '2024-02-30', '2024-13-01', '2024-00-10', '2024-01-00', '2024-04-31', '0000-01-01', '10000-01-01', '2024-1-01', ' 2024-01-01', '2024-01-01 ', "2024-01-01' OR 1=1 --"]) {
    assert.throws(() => compileQuery(createDateInterval(value, undefined)), QueryValidationError, value);
    assert.throws(() => compileQuery(createDateInterval(undefined, value)), QueryValidationError, value);
  }
  assert.throws(() => compileQuery(createDateInterval('2024-03-01', '2024-02-29')), /on or before/);
  assert.doesNotThrow(() => compileQuery(createDateInterval('2024-02-29', '2024-02-29')));
  assert.doesNotThrow(() => compileQuery(createDateInterval('2000-02-29')));
  for (const value of [undefined, null, 123, {}, [], '', '   ', 'x'.repeat(301)]) {
    for (const node of [
      { id: 'tags-invalid', type: 'tags', mode: 'any', values: [value] },
      { id: 'label-invalid', type: 'label', value },
      { id: 'location-invalid', type: 'location', operator: 'is', value },
    ]) assert.throws(() => compileQuery(node), QueryValidationError);
  }
  for (const values of [undefined, null, 'mountain', {}, 123, Array(1), Array(101).fill('mountain')]) {
    assert.throws(() => compileQuery({ id: 'invalid-tags', type: 'tags', mode: 'all', values }), QueryValidationError);
  }
  for (const node of [createTags(['mountain']), createLabel('Nature'), createDateInterval('2024-01-01'), createLocation('Japan')]) {
    for (const id of [undefined, null, 123, '', 'x'.repeat(301)]) {
      assert.throws(() => compileQuery({ ...node, id }), QueryValidationError);
    }
  }
  assert.throws(() => compileQuery({ id: 'unknown', type: 'unknown', value: 'x' }), QueryValidationError);
});

test('canonical factories produce editable nodes that compile and serialize', () => {
  const values = ['mountain', 'snow'];
  const tags = createTags(values, 'all');
  values.push('desert');
  assert.deepEqual(tags, { id: tags.id, type: 'tags', mode: 'all', values: ['mountain', 'snow'] });
  assert.deepEqual(createTags().values, []);
  assert.deepEqual(createTags().mode, 'any');
  const label = createLabel('Landscape');
  const interval = createDateInterval('2024-01-18', '2024-01-30');
  const location = createLocation('Alps', 'contains');
  assert.deepEqual(label, { id: label.id, type: 'label', value: 'Landscape' });
  assert.deepEqual(interval, { id: interval.id, type: 'date-interval', from: '2024-01-18', to: '2024-01-30' });
  assert.deepEqual(location, { id: location.id, type: 'location', operator: 'contains', value: 'Alps' });
  assert.equal(createLocation().operator, 'is');
  assert.ok(!Object.hasOwn(createDateInterval('2024-01-01'), 'to'));
  assert.ok(!Object.hasOwn(createDateInterval(undefined, '2024-12-31'), 'from'));
  const children = [tags, label, interval, location];
  const query = createGroup('AND', children);
  children.pop();
  assert.equal(query.children.length, 4);
  assert.ok(query.children.every((node) => typeof node.id === 'string' && node.id.length > 0));
  assert.deepEqual(ids(query), ['alps-glacier']);
  assert.deepEqual(compileQuery(JSON.parse(JSON.stringify(query))), compileQuery(query));
});
