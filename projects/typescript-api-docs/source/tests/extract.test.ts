import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { extractApi, extractVersion, getDeclarationDiagnostics } from '../scripts/extract';
import { generateApiJson, sourceVersions, projectRoot } from '../scripts/generate';
import { renderMarkdown } from '../src/markdown';

const api = extractApi(sourceVersions, projectRoot);
const latest = api.versions.find(version => version.version === '5.99.0')!;
const previous = api.versions.find(version => version.version === '5.98.0')!;

function symbol(version: typeof latest, id: string) {
  const found = version.symbols.find(item => item.id === id);
  if (!found) throw new Error(`expected ${id} in ${version.version}`);
  return found;
}

function member(version: typeof latest, id: string) {
  const separator = id.lastIndexOf('.');
  const ownerId = id.slice(0, separator);
  const memberName = id.slice(separator + 1).replace(/^static:/u, '');
  const owner = symbol(version, ownerId);
  const found = owner.members.find(item => item.id === id && item.name === memberName);
  if (!found) throw new Error(`expected member ${id} in ${version.version}`);
  return found;
}

test('extracts every webpack overload with checker signatures and parameters', () => {
  const webpack = symbol(latest, 'webpack');
  assert.equal(webpack.kind, 'function');
  assert.equal(webpack.signatures.length, 2);
  assert.match(webpack.signatures[0], /webpack\(options\?:/u);
  assert.match(webpack.signatures[1], /callback:/u);
  assert.deepEqual(webpack.parameters?.map(parameter => parameter.name), ['options', 'callback']);
  assert.equal(webpack.returns, 'webpack.Compiler');
});

test('retains overload order, parameter types, returns, and declaration-specific documentation', () => {
  for (const version of [latest, previous]) {
    const webpack = symbol(version, 'webpack');
    assert.equal(webpack.overloads?.length, 2);
    const [sync, async] = webpack.overloads!;
    assert.deepEqual(webpack.overloads!.map(overload => overload.signature), webpack.signatures);
    assert.deepEqual(sync.parameters.map(parameter => parameter.name), ['options']);
    assert.equal(sync.parameters[0].type, 'webpack.Configuration | undefined');
    assert.equal(sync.parameters[0].optional, true);
    assert.equal(sync.parameters[0].description, 'Build configuration, when a compiler is returned.');
    assert.equal(sync.returns, 'webpack.Compiler');
    assert.equal(sync.summary, 'Builds a webpack compilation from a configuration.');
    assert.equal(sync.description, 'Builds a webpack compilation from a configuration.\n\nThe callback overload starts the build asynchronously and reports the\nresulting statistics when it completes.');
    assert.doesNotMatch(sync.description, /Starts a build/u);
    assert.match(sync.example!, /compiler\.run/u);
    assert.ok(!sync.tags?.some(tag => tag.name === 'returns'));

    assert.deepEqual(async.parameters.map(parameter => parameter.name), ['options', 'callback']);
    assert.equal(async.parameters[0].type, 'webpack.Configuration');
    assert.equal(async.parameters[0].optional, false);
    assert.equal(async.parameters[0].rest, false);
    assert.equal(async.parameters[0].description, 'Build configuration for the asynchronous build.');
    assert.equal(async.parameters[1].description, 'Function called with the error and resulting statistics.');
    assert.equal(async.returns, 'void');
    assert.equal(async.description, 'Starts a build and invokes the callback when it finishes.');
    assert.match(async.example!, /webpack\(.*\(error, stats\)/u);
    assert.doesNotMatch(async.example!, /compiler\.run/u);
    assert.deepEqual(async.tags?.find(tag => tag.name === 'returns'), {
      name: 'returns',
      text: 'Reports completion through the callback rather than returning a compiler.',
    });
    assert.ok(sync.source.line < async.source.line);
    for (const overload of webpack.overloads!) {
      assert.equal(overload.source.file, version.sourcePath);
      assert.match(version.sourceText.split('\n')[overload.source.line - 1], /declare function webpack/u);
    }
  }
});

test('extracts generic constraints and defaults for interfaces, aliases, functions, and members', () => {
  for (const version of [latest, previous]) {
    const hook = symbol(version, 'Hook');
    assert.deepEqual(hook.typeParameters, [{ name: 'T', constraint: '(...args: any[]) => any' }]);
    assert.match(hook.signatures[0], /Hook<T extends/u);
    const result = symbol(version, 'Result');
    assert.deepEqual(result.typeParameters, [
      { name: 'T' }, { name: 'E', constraint: 'Error', default: 'Error' },
    ]);
    assert.match(result.signatures[0], /^type Result<T, E extends Error = Error> =/u);
    const mapValue = symbol(version, 'util.mapValue');
    assert.deepEqual(mapValue.typeParameters, [{ name: 'T' }, { name: 'U', default: 'T' }]);
    assert.equal(mapValue.returns, 'U');
    assert.deepEqual(member(version, 'util.mapValue').typeParameters, mapValue.typeParameters);
     const tapRows = hook.members.filter(item => item.name === 'tap');
     assert.equal(tapRows.length, 1);
     assert.deepEqual(tapRows[0].typeParameters, undefined);
     const [named, configured] = tapRows[0].overloads!;
    assert.deepEqual(named.parameters.map(parameter => parameter.name), ['name', 'listener']);
    assert.deepEqual(configured.parameters.map(parameter => parameter.name), ['options', 'listener']);
    assert.equal(named.parameters[1].type, 'T');
    assert.equal(configured.parameters[1].type, 'U');
    assert.equal(named.summary, 'Registers a listener and returns an unsubscribe function.');
    assert.equal(named.example, undefined);
    assert.equal(named.typeParameters, undefined);
    assert.equal(configured.summary, 'Registers a listener with execution options.');
    assert.equal(configured.parameters[1].description, "Callback matching the hook's signature.");
    assert.match(configured.example!, /once: true/u);
     assert.deepEqual(configured.typeParameters, [{ name: 'U', constraint: 'T', default: 'T' }]);
    assert.ok(named.source.line < configured.source.line);
    assert.equal(symbol(version, 'Compiler').typeParameters, undefined);
  }
});

test('extracts namespaces and their documented exported members', () => {
  const util = symbol(latest, 'util');
  const sources = symbol(latest, 'sources');
  assert.equal(util.kind, 'namespace');
  assert.equal(sources.kind, 'namespace');
  assert.deepEqual(util.members.map(item => item.name), ['join', 'format', 'hash', 'mapValue']);
  assert.ok(sources.members.some(item => item.name === 'RawSource'));
  assert.ok(sources.members.some(item => item.name === 'ReplaceSource'));
  assert.equal(symbol(latest, 'util.join').namespace, 'webpack.util');
});

test('preserves descriptions, examples, and source locations', () => {
  const compiler = symbol(latest, 'Compiler');
  assert.match(compiler.summary, /Coordinates builds/u);
  assert.match(compiler.description, /lifecycle hooks/u);
  assert.match(symbol(latest, 'webpack').example ?? '', /compiler\.run/u);
  const run = member(latest, 'Compiler.run');
  const compilerFile = path.join(projectRoot, 'samples/v2/webpack.d.ts');
  assert.equal(compiler.source.file, 'samples/v2/webpack.d.ts');
  assert.equal(run.source.file, compilerFile.replace(`${projectRoot}/`, ''));
  assert.ok(compiler.source.line < run.source.line);
  assert.ok(run.source.endLine >= run.source.line);
  assert.match(run.signature, /^run\(callback:/u);
});

test('shows meaningful v2 additions while retaining stable common IDs', () => {
  const previousCompiler = symbol(previous, 'Compiler');
  const latestCompiler = symbol(latest, 'Compiler');
  assert.ok(!previousCompiler.members.some(item => item.name === 'getCompilerName'));
  assert.ok(latestCompiler.members.some(item => item.name === 'getCompilerName'));
  assert.ok(!symbol(previous, 'sources').members.some(item => item.name === 'ReplaceSource'));
  assert.ok(symbol(latest, 'sources').members.some(item => item.name === 'ReplaceSource'));
  assert.ok(!symbol(previous, 'Stats').members.some(item => item.name === 'getDuration'));
  assert.ok(symbol(latest, 'Stats').members.some(item => item.name === 'getDuration'));
  const commonPrevious = new Set(previous.symbols.map(item => item.id));
  for (const item of latest.symbols) {
    if (commonPrevious.has(item.id)) assert.equal(item.id, symbol(previous, item.id).id);
  }
});

test('generation is deterministic', () => {
  const first = generateApiJson();
  const second = generateApiJson();
  assert.equal(first, second);
  const parsed = JSON.parse(first) as typeof api;
  assert.equal(parsed.packageName, 'webpack');
  assert.deepEqual(parsed.versions.map(version => version.label), ['Latest', 'Previous']);
});

test('handles missing type nodes and generic classes using checker-inferred types', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-extract-'));
  try {
    fs.writeFileSync(path.join(directory, 'fixture.ts'), `
      namespace webpack {
        export function inferred(value = 42) { return value; }
        export class Box<T = string> {
          value = 42;
          map<U = T>(mapper: (value: number) => U) { return mapper(this.value); }
        }
      }
    `);
    const version = extractVersion({ version: 'fixture', label: 'Latest', sourcePath: 'fixture.ts' }, directory);
    const inferred = symbol(version, 'inferred');
    assert.deepEqual(inferred.parameters, [{ name: 'value', type: 'number', description: '', optional: true, rest: false }]);
    assert.equal(inferred.returns, 'number');
    assert.equal(inferred.typeParameters, undefined);
    assert.deepEqual(symbol(version, 'Box').typeParameters, [{ name: 'T', default: 'string' }]);
    assert.equal(symbol(version, 'Box').signatures[0], 'class Box<T = string>');
    assert.equal(member(version, 'Box.value').signature, 'value: number');
    assert.deepEqual(member(version, 'Box.map').typeParameters, [{ name: 'U', default: 'T' }]);
    assert.equal(member(version, 'Box.map').returns, 'U');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps generic overloads and constructor documentation local, including undocumented signatures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-overloads-'));
  try {
    fs.writeFileSync(path.join(directory, 'fixture.d.ts'), `
      declare namespace webpack {
        namespace util {
          /**
           * Looks up a string key.
           * @param value String key to look up.
           * @example lookup('entry');
           */
          function lookup<T extends string = string>(value: T): T;
          function lookup<U extends number = number>(value: U): U[];
        }
        class Box<T = string> {
          /** Creates an empty box. */
          constructor();
          /**
           * Creates a populated box.
           * @param value Initial contents.
           */
          constructor(value: T);
          /** Uses an instance value. */
          read(value: string): string;
          read(value: number): number;
          /** Uses a static value. */
          static read(value: boolean): boolean;
        }
      }
    `);
    const version = extractVersion({ version: 'fixture', label: 'Latest', sourcePath: 'fixture.d.ts' }, directory);
    const lookup = symbol(version, 'util.lookup');
    assert.equal(lookup.overloads?.length, 2);
    const [documented, undocumented] = lookup.overloads!;
    assert.deepEqual(documented.typeParameters, [{ name: 'T', constraint: 'string', default: 'string' }]);
    assert.deepEqual(undocumented.typeParameters, [{ name: 'U', constraint: 'number', default: 'number' }]);
    assert.equal(documented.returns, 'T');
    assert.equal(undocumented.returns, 'U[]');
    assert.equal(documented.parameters[0].description, 'String key to look up.');
    assert.equal(undocumented.parameters[0].description, '');
    assert.equal(undocumented.description, '');
    assert.equal(undocumented.summary, '');
    assert.equal(undocumented.tags, undefined);
    assert.equal(undocumented.example, undefined);
    assert.deepEqual(member(version, 'util.lookup').overloads, lookup.overloads);

    const constructors = member(version, 'Box.constructor').overloads!;
    assert.deepEqual(constructors.map(overload => overload.parameters.length), [0, 1]);
    assert.deepEqual(constructors.map(overload => overload.summary), [
      'Creates an empty box.', 'Creates a populated box.',
    ]);
    assert.equal(constructors[1].parameters[0].description, 'Initial contents.');
    assert.equal(constructors[1].returns, 'Box<T>');
    const readRows = symbol(version, 'Box').members.filter(item => item.name === 'read');
    assert.deepEqual(readRows[0].overloads?.map(overload => overload.returns), ['string', 'number']);
    assert.equal(member(version, 'Box.static:read').static, true);
    assert.equal(member(version, 'Box.static:read').overloads, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('represents rest parameters, inherited members, generic member metadata, and qualified IDs', () => {
  for (const version of [latest, previous]) {
    const store = symbol(version, 'stores.Store');
    assert.deepEqual(store.typeParameters, [{ name: 'T', constraint: 'Asset', default: 'Asset' }]);
    const select = member(version, 'stores.Store.select');
    assert.equal(select.overloads?.length, 2);
    assert.deepEqual(select.overloads?.[0].typeParameters, [{ name: 'U', constraint: 'T', default: 'T' }]);
    assert.equal(select.overloads?.[0].parameters[1].optional, true);
    assert.equal(select.overloads?.[1].parameters[0].rest, true);
    assert.equal(select.overloads?.[1].parameters[0].optional, false);
    assert.equal(select.overloads?.[0].parameters[0].rest, false);
    assert.equal(select.overloads?.[0].returns, 'U[]');
    assert.equal(select.overloads?.[1].returns, 'T[]');
    assert.equal(select.overloads?.[0].description, 'Selects assets with a predicate.\n\nThe result preserves the selected asset subtype.');
    assert.equal(select.overloads?.[1].description, 'Selects assets by name.');
    assert.equal(select.overloads?.[0].parameters[0].description, 'Function used to select assets.');
    assert.equal(select.overloads?.[1].parameters[0].description, 'Names of assets to select.');
    assert.equal(select.overloads?.[1].example, "store.select('main.js', 'runtime.js');");
    assert.deepEqual(select.overloads?.[0].tags?.find(tag => tag.name === 'returns'), { name: 'returns', text: 'Selected assets.' });
    assert.ok(select.overloads![0].source.line < select.overloads![1].source.line);
    for (const overload of select.overloads!) {
      assert.equal(overload.source.file, version.sourcePath);
      assert.match(version.sourceText.split('\n')[overload.source.line - 1], /^\s+select/u);
    }
    assert.equal(member(version, 'stores.Store.map').typeParameters?.[0].default, 'T');
    assert.deepEqual(symbol(version, 'stores.Entry').typeParameters, store.typeParameters);
    assert.deepEqual(symbol(version, 'stores.createStore').typeParameters, store.typeParameters);
    assert.deepEqual(symbol(version, 'stores.createStore').parameters?.map(({ optional, rest }) => ({ optional, rest })), [
      { optional: true, rest: false }, { optional: false, rest: true },
    ]);
    assert.deepEqual(member(version, 'stores.createStore').parameters, symbol(version, 'stores.createStore').parameters);
    assert.equal(member(version, 'util.join').parameters[0].rest, true);

    const assetStore = symbol(version, 'stores.AssetStore');
    const inherited = assetStore.members.find(item => item.name === 'read');
    assert.ok(inherited);
    assert.equal(inherited.inheritedFrom, 'stores.Store');
    assert.equal(inherited.id, 'stores.AssetStore.read');
    assert.equal(inherited.returns, 'Asset');
    assert.deepEqual(inherited.source, member(version, 'stores.Store.read').source);
    assert.equal(member(version, 'stores.AssetStore.value').signature, 'value: Asset');
    assert.equal(member(version, 'stores.AssetStore.static:label').inheritedFrom, 'stores.Store');
    assert.ok(!assetStore.members.some(item => item.kind === 'constructor'));
    const inheritedSelect = member(version, 'stores.AssetStore.select');
    assert.deepEqual(inheritedSelect.typeParameters, [{ name: 'U', constraint: 'Asset', default: 'Asset' }]);
    assert.deepEqual(inheritedSelect.overloads?.[0].typeParameters, inheritedSelect.typeParameters);
    assert.equal(inheritedSelect.overloads?.[1].returns, 'Asset[]');
    assert.deepEqual(inheritedSelect.overloads?.[1].source, select.overloads?.[1].source);
    assert.ok(assetStore.members.some(item => item.name === 'value' && item.inheritedFrom === 'stores.Store'));
    assert.ok(symbol(version, 'stores.NamedEntry').members.some(item => item.inheritedFrom === 'Logger'));

    const storeIds = version.symbols.filter(item => item.id.endsWith('.Store')).map(item => item.id);
    assert.deepEqual(storeIds.sort(), ['cache.Store', 'stores.Store']);
    assert.notEqual(symbol(version, 'cache.Store').id, symbol(version, 'stores.Store').id);
    assert.equal(symbol(version, 'cache.Entry').id, 'cache.Entry');
    assert.equal(member(version, 'cache.Store.read').inheritedFrom, undefined);
    assert.equal(member(version, 'Configuration.mode').inheritedFrom, 'CompilerOptions');
    assert.equal(member(version, 'sources.BannerSource.size').inheritedFrom, 'sources.RawSource');
    assert.equal(member(version, 'sources.BannerSource.source').inheritedFrom, undefined);

    assert.equal(new Set(version.symbols.map(item => item.id)).size, version.symbols.length);
    for (const owner of version.symbols) {
      assert.equal(new Set(owner.members.map(item => item.id)).size, owner.members.length, owner.id);
      for (const callable of [owner, ...owner.members]) {
        for (const parameter of callable.parameters ?? []) {
          assert.equal(typeof parameter.optional, 'boolean');
          assert.equal(typeof parameter.rest, 'boolean');
        }
      }
    }
  }
  for (const owner of previous.symbols) {
    const current = symbol(latest, owner.id);
    for (const oldMember of owner.members) {
      const currentMember = current.members.find(item => item.id === oldMember.id);
      assert.ok(currentMember, oldMember.id);
      assert.equal(currentMember.inheritedFrom, oldMember.inheritedFrom);
    }
  }
});

test('keeps extraction deterministic across repeated compiler-backed runs', () => {
  const first = JSON.stringify(extractApi(sourceVersions, projectRoot));
  const second = JSON.stringify(extractApi(sourceVersions, projectRoot));
  assert.equal(first, second);
});

test('handles dotted and merged namespaces, implementation signatures, transitive and diamond inheritance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-inheritance-'));
  try {
    fs.writeFileSync(path.join(directory, 'fixture.ts'), `
      namespace webpack.left.deep {
        export interface Entry<T extends string = string> {
          value: T;
          read(value?: T, ...fallbacks: T[]): T;
        }
        export interface Left extends Entry<'left'> {}
        export interface Right extends Entry<'left'> {}
        export interface Diamond extends Left, Right {}
        export interface Override extends Diamond { value: 'left'; }
        export class Base {
          read(value: string): string;
          read(value: number): number;
          read(value: string | number) { return value; }
          static read(value: boolean) { return value; }
        }
        export class Middle extends Base {}
        export class Leaf extends Middle {}
        /** Looks up a text key. @param value Text key. */
        export function lookup<T extends string = string>(value?: T): T | undefined;
        export function lookup<U extends number = number>(...value: U[]): U[];
        export function lookup(...values: any[]): any { return values[0]; }
      }
      namespace webpack.left.deep { export interface Entry<T extends string = string> { label?: string; } }
      namespace webpack.right.deep { export interface Entry { value: number; } }
    `);
    const input = { version: 'fixture', label: 'Latest' as const, sourcePath: 'fixture.ts' };
    const version = extractVersion(input, directory);
    assert.equal(JSON.stringify(version), JSON.stringify(extractVersion(input, directory)));
    assert.equal(symbol(version, 'left.deep.Entry').namespace, 'webpack.left.deep');
    assert.equal(symbol(version, 'right.deep.Entry').namespace, 'webpack.right.deep');
    assert.equal(member(version, 'left.deep.Entry.label').optional, true);
    const diamond = symbol(version, 'left.deep.Diamond');
    assert.deepEqual(diamond.members.map(item => item.name), ['value', 'read', 'label']);
    assert.ok(diamond.members.every(item => item.inheritedFrom === 'left.deep.Entry'));
    assert.equal(member(version, 'left.deep.Diamond.read').returns, '"left"');
    assert.equal(member(version, 'left.deep.Diamond.read').parameters[1].type, '"left"[]');
    assert.equal(member(version, 'left.deep.Override.value').inheritedFrom, undefined);
    const read = member(version, 'left.deep.Leaf.read');
    assert.equal(read.inheritedFrom, 'left.deep.Base');
    assert.deepEqual(read.overloads?.map(overload => overload.returns), ['string', 'number']);
    assert.equal(member(version, 'left.deep.Leaf.static:read').inheritedFrom, 'left.deep.Base');
    const lookup = symbol(version, 'left.deep.lookup');
    assert.equal(lookup.signatures.length, 2);
    assert.equal(lookup.overloads?.length, 2);
    assert.equal(lookup.overloads?.[1].description, '');
    assert.equal(lookup.overloads?.[1].parameters[0].rest, true);
    assert.equal(new Set(version.symbols.map(item => item.id)).size, version.symbols.length);
    for (const owner of version.symbols) {
      assert.equal(new Set(owner.members.map(item => item.id)).size, owner.members.length);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fixture preserves Markdown comments safely while modeling duplicate namespaces and API edges', () => {
  const version = extractVersion({
    version: 'fixture',
    label: 'Latest',
    sourcePath: 'samples/fixtures/edge-cases.d.ts',
  }, projectRoot);
  const alphaItem = symbol(version, 'alpha.Item');
  const betaItem = symbol(version, 'beta.Item');
  assert.notEqual(alphaItem.id, betaItem.id);
  assert.deepEqual(alphaItem.typeParameters, [{ name: 'T', constraint: 'string', default: 'string' }]);
  assert.equal(member(version, 'alpha.Item.value').optional, true);

  const derived = symbol(version, 'alpha.Derived');
  assert.equal(member(version, 'alpha.Derived.read').inheritedFrom, 'alpha.Base');
  assert.equal(member(version, 'alpha.Derived.metadata').optional, true);

  const parse = symbol(version, 'alpha.parse');
  assert.equal(parse.overloads?.length, 2);
  assert.equal(parse.overloads?.[0].parameters[0].optional, true);
  assert.equal(parse.overloads?.[1].parameters[0].rest, false);
  assert.equal(parse.overloads?.[1].parameters[1].rest, true);
  assert.equal(member(version, 'alpha.parse').overloads?.[1].example, 'parse(1, 2, 3);');
  assert.equal(member(version, 'alpha.Store.map').description, 'Maps the stored item to another item type.');

  const safeHtml = renderMarkdown(alphaItem.description, 'https://docs.example.test/');
  assert.match(safeHtml, /&lt;script&gt;alert\(&#39;this stays text&#39;\)&lt;\/script&gt;/u);
  assert.match(safeHtml, /<a href="https:\/\/example\.com\/reference">safe docs<\/a>/u);
  assert.doesNotMatch(safeHtml, /<script|href="javascript:/iu);
});

test('comparison data preserves class heritage, readonly properties, call signatures, and index signatures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-signature-shape-'));
  try {
    fs.writeFileSync(path.join(directory, 'fixture.d.ts'), `
      declare namespace webpack {
        interface Callable { value: string; }
        interface CallShape { (value: string): string; readonly [key: string]: string; }
        class Base {}
        class Child extends Base implements Callable {
          readonly value: string;
        }
      }
    `);
    const version = extractVersion({ version: 'fixture', label: 'Latest', sourcePath: 'fixture.d.ts' }, directory);
    assert.match(symbol(version, 'Child').signatures[0], /class Child extends Base implements Callable/u);
    assert.equal(member(version, 'CallShape.(call)').signature, '(call)(value: string): string');
    assert.match(member(version, 'CallShape.(index)').signature, /\(index\)/u);
    assert.match(member(version, 'Child.value').signature, /^readonly value: string/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('collects actionable diagnostics without throwing for malformed or unresolved input', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-diagnostics-'));
  try {
    const file = path.join(directory, 'broken.d.ts');
    const unresolved = path.join(directory, 'unresolved.ts');
    fs.writeFileSync(file, 'declare const broken: string; function nope( ;\n');
    fs.writeFileSync(unresolved, "import Missing from './missing-module'; export declare const broken: Missing;\n");
    const diagnostics = getDeclarationDiagnostics(file, directory);
    const unresolvedDiagnostics = getDeclarationDiagnostics(unresolved, directory);
    assert.ok(diagnostics.some(diagnostic => diagnostic.category === 'error'));
    assert.ok(unresolvedDiagnostics.some(diagnostic => diagnostic.code === 2307));
    assert.ok([...diagnostics, ...unresolvedDiagnostics].every(diagnostic => typeof diagnostic.message === 'string' && diagnostic.message.length > 0));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
