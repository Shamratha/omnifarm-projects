import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyModules, modules, productCatalog } from '../data.js';
import { buildRemediationQueue, enrichModules, exportQueueCsv, exportQueueMarkdown, filterModules, findDuplicateAdvisories } from '../triage.js';
import { modules as aliasModules, productCatalog as aliasCatalog, dependencyModules as aliasDependencies } from './fixtures/alias-review.js';

const ranked = enrichModules(modules, { productCatalog, dependencyModules });
const basicModule = (overrides = {}) => ({
  id: 'test/module',
  name: 'Test module',
  type: 'exploit',
  platform: 'multi',
  severity: 'medium',
  owner: 'Test owner',
  description: 'Test record',
  advisories: [],
  cves: [],
  products: [],
  prerequisites: [],
  patchStatus: { status: 'unknown', evidence: [] },
  evidence: [],
  dependencies: [],
  ...overrides,
});

test('conservative CVSS ranking exposes conflicting evidence without hiding it', () => {
  const atlas = ranked.find((module) => module.id.includes('atlas-console'));
  assert.equal(atlas.priority.cvssMax, 9.8);
  assert.equal(atlas.priority.cvssConflict, true);
  assert.equal(atlas.priority.cvssSpread, 1.7);
  assert.equal(atlas.priority.confidence.level, 'medium');
});

test('catalog exports eight products, resolves canonical and aliases, and preserves versions', () => {
  assert.equal(productCatalog.length, 8);
  assert.ok(productCatalog.every((product) => product.id && product.vendor && product.name && Array.isArray(product.aliases)));
  const verdant = ranked.find((module) => module.id.includes('verdant-reporting'));
  assert.deepEqual(verdant.resolvedProducts[0].original, { vendor: 'Verdant Software', name: 'Verdant Reports', versions: '5.0 - 5.1.6' });
  assert.equal(verdant.resolvedProducts[0].canonicalId, 'verdant-reporting-server');
  assert.equal(verdant.resolvedProducts[0].resolution.status, 'alias');
  assert.equal(verdant.resolvedProducts[0].name, 'Reporting Server');
  const alias = enrichModules([basicModule({ products: [{ vendor: 'Verdant-Software', name: 'Verdant Reports', versions: '5.x' }] })], { productCatalog })[0].resolvedProducts[0];
  assert.equal(alias.resolution.status, 'alias');
  assert.equal(alias.canonicalId, 'verdant-reporting-server');
  assert.equal(alias.versions, '5.x');
});

test('product resolution requires exact normalized vendor and name and leaves ambiguity unresolved', () => {
  const catalog = [
    { id: 'one', vendor: 'Acme Corp', name: 'Widget', aliases: [] },
    { id: 'two', vendor: 'Acme Corp', name: 'Widget', aliases: [] },
  ];
  const result = enrichModules([
    basicModule({ id: 'canonical', products: [{ vendor: ' ACME.Corp ', name: 'Wid-get', versions: '1' }] }),
    basicModule({ id: 'wrong-vendor', products: [{ vendor: 'Other Corp', name: 'Widget Pro', versions: '2' }] }),
    basicModule({ id: 'ambiguous', products: [{ vendor: 'Acme Corp', name: 'Widget', versions: '3' }] }),
  ], { productCatalog: catalog });
  assert.equal(result.find((module) => module.id === 'canonical').resolvedProducts[0].resolution.status, 'ambiguous');
  assert.equal(result.find((module) => module.id === 'wrong-vendor').resolvedProducts[0].resolution.status, 'unresolved');
  const ambiguous = result.find((module) => module.id === 'ambiguous').resolvedProducts[0];
  assert.equal(ambiguous.resolution.status, 'ambiguous');
  assert.equal(ambiguous.canonicalId, null);
  assert.deepEqual(ambiguous.resolution.candidates, ['one', 'two']);
  const uniqueCatalog = [{ id: 'one', vendor: 'Acme Corp', name: 'Widget', aliases: [{ vendor: 'Acme', name: 'Old Widget' }] }];
  const cases = [
    [' ACME.Corp ', 'Wid-get', 'canonical'],
    ['Acme', 'OLD   Widget', 'alias'],
    ['Other Corp', 'Widget', 'unresolved'],
    ['Acme Corp', 'Widget Pro', 'unresolved'],
    ['', '', 'unresolved'],
  ];
  for (const [vendor, name, expected] of cases) {
    const resolved = enrichModules([basicModule({ products: [{ vendor, name, versions: '>= 1, < 3 || 4.x' }] })], { productCatalog: uniqueCatalog })[0].resolvedProducts[0];
    assert.equal(resolved.resolution.status, expected);
    assert.equal(resolved.versions, '>= 1, < 3 || 4.x');
  }
});

test('one resolved product alias can retain multiple advisory records and shared duplicate evidence', () => {
  const records = [
    basicModule({
      id: 'alias/module-one',
      products: [{ vendor: 'Verdant Software', name: 'Verdant Reports', versions: '5.0 - 5.1.6' }],
      advisories: [{ id: 'ADV-ALIAS-A', source: 'feed-one' }, { id: 'ADV-ALIAS-B', source: 'feed-one' }],
      evidence: [
        { advisoryId: 'ADV-ALIAS-A', source: 'evidence-a-one', confidence: 88 },
        { advisoryId: 'ADV-ALIAS-B', source: 'evidence-b-one', confidence: 84 },
      ],
      cves: [
        { id: 'CVE-ALIAS-A', advisoryId: 'ADV-ALIAS-A', source: 'cve-a-one', cvss: 7.1 },
        { id: 'CVE-ALIAS-B', advisoryId: 'ADV-ALIAS-B', source: 'cve-b-one', cvss: 6.8 },
      ],
    }),
    basicModule({
      id: 'alias/module-two',
      products: [{ vendor: 'Verdant Software', name: 'Verdant Reports', versions: '5.1.x' }],
      advisories: [{ id: 'ADV-ALIAS-A', source: 'feed-two' }],
      evidence: [{ advisoryId: 'ADV-ALIAS-A', source: 'evidence-a-two', confidence: 79 }],
      cves: [{ id: 'CVE-ALIAS-A-SECOND', advisoryId: 'ADV-ALIAS-A', source: 'cve-a-two', cvss: 7.4 }],
    }),
  ];
  const enriched = enrichModules(records, { productCatalog });
  assert.equal(enriched.length, 2);
  assert.ok(enriched.every((module) => module.resolvedProducts[0].canonicalId === 'verdant-reporting-server'));
  assert.ok(enriched.every((module) => module.resolvedProducts[0].resolution.status === 'alias'));
  const first = enriched.find((module) => module.id === 'alias/module-one');
  assert.deepEqual(first.advisoryGroups.map((group) => group.id).sort(), ['ADV-ALIAS-A', 'ADV-ALIAS-B']);
  const shared = first.advisoryGroups.find((group) => group.id === 'ADV-ALIAS-A');
  const separate = first.advisoryGroups.find((group) => group.id === 'ADV-ALIAS-B');
  assert.deepEqual(shared.moduleIds.sort(), ['alias/module-one', 'alias/module-two']);
  assert.equal(shared.occurrences.length, 2);
  assert.deepEqual(shared.evidence.map((item) => item.source).sort(), ['evidence-a-one', 'evidence-a-two']);
  assert.deepEqual(shared.cves.map((item) => item.id).sort(), ['CVE-ALIAS-A', 'CVE-ALIAS-A-SECOND']);
  assert.equal(separate.occurrences.length, 1);
  assert.equal(separate.evidence[0].source, 'evidence-b-one');
  assert.equal(separate.cves[0].id, 'CVE-ALIAS-B');
  assert.deepEqual(findDuplicateAdvisories(records).get('ADV-ALIAS-A').sort(), ['alias/module-one', 'alias/module-two']);
});

test('enrichment retains raw fields and does not mutate input modules, product ranges, or catalogs', () => {
  const input = [basicModule({ products: [{ vendor: 'Harbor Tools', name: 'Harbor Agent', versions: { branches: ['8.x', '< 9'] }, custom: 'retain' }] })];
  const before = structuredClone(input);
  const catalogBefore = structuredClone(productCatalog);
  const result = enrichModules(input, { productCatalog, dependencyModules });
  assert.deepEqual(input, before);
  assert.deepEqual(productCatalog, catalogBefore);
  assert.equal(result[0].products, input[0].products);
  assert.equal(result[0].products[0].custom, 'retain');
  assert.deepEqual(result[0].resolvedProducts[0].versions, before[0].products[0].versions);
  assert.equal(result[0].resolvedProducts[0].vendor, 'Harbor Tools');
  assert.equal(result[0].resolvedProducts[0].name, 'Harbor Agent');
});

test('advisory groups retain repeated occurrences, scoped evidence, CVSS records, and unique module IDs', () => {
  const records = [
    basicModule({
      id: 'module-a',
      advisories: [{ id: 'ADV-1', source: 'feed-a' }, { id: 'ADV-1', source: 'feed-b' }],
      evidence: [
        { advisoryId: 'ADV-1', source: 'matched', confidence: 80 },
        { advisoryId: 'OTHER', source: 'excluded', confidence: 90 },
        { source: 'module-context', confidence: 70 },
      ],
      cves: [{ id: 'CVE-1', advisoryId: 'ADV-1', source: 'cve-a', cvss: 7.2 }, { id: 'CVE-2', source: 'cve-context', cvss: 8.1 }],
    }),
    basicModule({ id: 'module-b', advisories: ['ADV-1'], evidence: [{ source: 'second-module', confidence: 75 }], cves: [{ id: 'CVE-3', source: 'cve-b', cvss: 6.5 }] }),
  ];
  const enriched = enrichModules(records);
  const group = enriched.find((module) => module.id === 'module-a').advisoryGroups[0];
  assert.equal(group.occurrences.length, 3);
  assert.deepEqual(group.moduleIds.sort(), ['module-a', 'module-b']);
  assert.equal(group.evidence.length, 3);
  assert.ok(group.evidence.some((item) => item.source === 'module-context' && item.scope === 'module'));
  assert.ok(!group.evidence.some((item) => item.source === 'excluded'));
  assert.equal(group.cves.length, 3);
  assert.ok(group.cves.some((item) => item.source === 'cve-context' && item.scope === 'module'));
  assert.deepEqual(findDuplicateAdvisories(records).get('ADV-1').sort(), ['module-a', 'module-b']);
  assert.deepEqual(enriched.find((module) => module.id === 'module-a').duplicateAdvisories, ['ADV-1']);
  assert.equal(enriched.length, records.length);
  assert.deepEqual(group.occurrences.map((item) => [item.moduleId, item.index, item.record]), [
    ['module-a', 0, records[0].advisories[0]], ['module-a', 1, records[0].advisories[1]], ['module-b', 0, 'ADV-1'],
  ]);
  assert.deepEqual(group.cves.map((cve) => cve.cvss), [7.2, 8.1, 6.5]);
  assert.deepEqual(enriched.find((module) => module.id === 'module-a').cves, records[0].cves);
});

test('duplicates within one module count as duplicates and untagged records remain module scoped', () => {
  const record = basicModule({ advisories: ['ONLY', 'ONLY', 'OTHER'], evidence: [{ scope: 'source', source: 'local', confidence: 77 }] });
  const [enriched] = enrichModules([record]);
  assert.deepEqual([...findDuplicateAdvisories([record])], [['ONLY', ['test/module']]]);
  assert.deepEqual(enriched.duplicateAdvisories, ['ONLY']);
  assert.equal(enriched.advisoryGroups.length, 2);
  assert.equal(enriched.advisoryGroups[0].occurrences.length, 2);
  for (const group of enriched.advisoryGroups) {
    assert.equal(group.evidence.length, 1);
    assert.equal(group.evidence[0].scope, 'module');
    assert.deepEqual(group.evidence[0].originalEvidence, record.evidence[0]);
  }
});

test('directed dependency links resolve direct targets only, including missing, self, and cycles', () => {
  const records = [
    basicModule({ id: 'source', dependencies: [{ moduleId: 'target', relation: 'calls' }, { moduleId: 'missing', relation: 'reads' }, { moduleId: 'source', relation: 'self' }, { moduleId: 'target', relation: 'calls' }] }),
    basicModule({ id: 'target', name: 'Target', type: 'auxiliary', platform: 'linux', dependencies: [{ moduleId: 'cycle-b', relation: 'cycle' }] }),
    basicModule({ id: 'cycle-b', dependencies: [{ moduleId: 'target', relation: 'cycle' }] }),
  ];
  const enriched = enrichModules(records, { dependencyModules: [{ id: 'catalog-target', name: 'Catalog target', type: 'auxiliary', platform: 'multi' }] });
  const source = enriched.find((module) => module.id === 'source');
  assert.equal(source.dependencyLinks.length, 3);
  assert.deepEqual(source.dependencyLinks.find((link) => link.target?.id === 'target').target, { id: 'target', name: 'Target', type: 'auxiliary', platform: 'linux' });
  assert.equal(source.dependencyLinks.find((link) => link.relation === 'reads').status, 'missing');
  assert.equal(source.dependencyLinks.find((link) => link.relation === 'reads').moduleId, 'missing');
  assert.equal(source.dependencyLinks.find((link) => link.relation === 'reads').sourceModuleId, 'source');
  assert.equal(source.dependencyLinks.find((link) => link.relation === 'reads').targetId, 'missing');
  assert.equal(source.dependencyLinks.find((link) => link.relation === 'self').target.id, 'source');
  assert.equal(enriched.find((module) => module.id === 'target').dependencyLinks[0].target.id, 'cycle-b');
  assert.equal(enriched.find((module) => module.id === 'cycle-b').dependencyLinks[0].target.id, 'target');
  assert.equal(source.dependencyLinks.some((link) => link.target?.id === 'cycle-b'), false);
  const [external] = enrichModules([basicModule({ dependencies: [{ moduleId: 'external', relation: 'inventory' }, { moduleId: 'external', relation: 'reports' }] })], { dependencyModules: [{ id: 'external', name: 'External', type: 'auxiliary', platform: 'multi' }] });
  assert.equal(external.dependencyLinks.length, 2);
  assert.ok(external.dependencyLinks.every((link) => link.status === 'resolved'));
  assert.equal(ranked.find((module) => module.id.includes('atlas-console')).dependencyLinks[0].status, 'resolved');
});

test('patch confidence distinguishes unavailable evidence, absent evidence, unknown, conflicts, and partial coverage', () => {
  const enriched = enrichModules([
    basicModule({ id: 'unavailable', patchStatus: { status: 'unavailable', evidence: [{ source: 'vendor', status: 'unavailable', confidence: 95 }] } }),
    basicModule({ id: 'absent', patchStatus: { status: 'available', evidence: [] } }),
    basicModule({ id: 'unknown', patchStatus: { status: 'unknown', evidence: [{ source: 'vendor', status: 'unknown', confidence: 95 }] } }),
    basicModule({ id: 'conflict', patchStatus: { status: 'available', evidence: [{ source: 'vendor', status: 'available', confidence: 90 }, { source: 'feed', status: 'unavailable', confidence: 90 }] } }),
    basicModule({ id: 'partial', patchStatus: { status: 'partial', evidence: [{ source: 'branch', status: 'partial', confidence: 80, detail: '3 of 7 branches' }] } }),
  ]);
  assert.equal(enriched.find((module) => module.id === 'unavailable').patchConfidence.level, 'high');
  assert.equal(enriched.find((module) => module.id === 'absent').patchConfidence.score, 0);
  assert.equal(enriched.find((module) => module.id === 'unknown').patchConfidence.level, 'low');
  assert.ok(enriched.find((module) => module.id === 'conflict').patchConfidence.score < 78);
  assert.match(enriched.find((module) => module.id === 'partial').patchConfidence.reasons.join(' '), /coverage/i);
  assert.ok(modules.every((module) => module.patchStatus.evidence?.length));
  const [inventoryOnly] = enrichModules([basicModule({ patchStatus: { status: 'unavailable' }, evidence: [{ confidence: 100, kind: 'inventory' }] })]);
  assert.equal(inventoryOnly.patchConfidence.score, 0);
  assert.equal(inventoryOnly.priority.confidence.score, 100);
  assert.equal(enriched.find((module) => module.id === 'unavailable').patchConfidence.score, 95);
  assert.equal(enriched.find((module) => module.id === 'unknown').patchConfidence.score, 35);
  assert.equal(enriched.find((module) => module.id === 'conflict').patchConfidence.score, 65);
});

test('unavailable patches and available fixes are both queued with status-specific safe actions', () => {
  const queue = buildRemediationQueue(ranked);
  assert.equal(queue.length, modules.length);
  const meridian = queue.find((item) => item.moduleId.includes('meridian-sync'));
  const atlas = queue.find((item) => item.moduleId.includes('atlas-console'));
  assert.match(meridian.action, /compensating-control/i);
  assert.match(atlas.action, /stage|validate|schedule/i);
  assert.ok(queue.every((item) => item.resolvedProducts && item.advisoryGroups && item.dependencyLinks && item.patchConfidence && item.evidence && item.cves && item.priorityDetails));
  assert.match(queue.find((item) => item.patchStatus === 'partial').action, /coverage/);
  assert.match(queue.find((item) => item.patchStatus === 'unknown').action, /vendor fix.*temporary controls/);
  filterModules(ranked, { search: 'not found' });
  assert.equal(buildRemediationQueue(ranked).length, modules.length);
});

test('queue preserves tie order and skips only explicitly remediated records', () => {
  const input = [basicModule({ id: 'first', name: 'Zebra' }), basicModule({ id: 'second', name: 'Alpha' }), basicModule({ id: 'done', patchStatus: { status: 'available', remediated: true } })];
  const prepared = enrichModules(input);
  const ordered = input.map((item) => prepared.find((module) => module.id === item.id));
  const queue = buildRemediationQueue(ordered);
  assert.deepEqual(queue.map((item) => item.moduleId), ['first', 'second']);
  assert.deepEqual(queue.map((item) => item.order), [1, 2]);
});

test('filters search raw labels, canonical labels, aliases, and advisory IDs', () => {
  assert.equal(filterModules(ranked, { search: 'Verdant Reports' }).length, 1);
  assert.equal(filterModules(ranked, { search: 'verdant-reporting-server' }).length, 1);
  assert.equal(filterModules(ranked, { search: 'SYN-ADV-2026-014' }).length, 2);
  const [aliased] = enrichModules([basicModule({ products: [{ vendor: 'Verdant Software', name: 'Verdant Reports', versions: '5.x' }], advisories: [{ id: 'OBJECT-ADV', source: 'feed' }] })], { productCatalog });
  assert.equal(filterModules([aliased], { search: 'Reporting Server' }).length, 1);
  assert.equal(filterModules([aliased], { search: 'Verdant Reports' }).length, 1);
  assert.equal(filterModules([aliased], { search: 'OBJECT-ADV' }).length, 1);
  assert.equal(filterModules(ranked, { patchStatus: 'unavailable' }).length, 2);
  assert.ok(filterModules(ranked, { confidence: 'high' }).every((module) => module.priority.confidence.level === 'high'));
});

test('final alias pass keeps advisory scope, dependency edges, confidence and remediation exports independent', () => {
  const before = structuredClone(aliasModules);
  const enriched = enrichModules(aliasModules, { productCatalog: aliasCatalog, dependencyModules: aliasDependencies });
  const first = enriched.find((module) => module.id === 'synthetic/alias-one');
  const second = enriched.find((module) => module.id === 'synthetic/alias-two');
  for (const search of ['Legacy Reports', 'Reporting Server', 'synthetic-reporting']) {
    assert.deepEqual(filterModules(enriched, { search }).map((module) => module.id).sort(), ['synthetic/alias-one', 'synthetic/alias-two']);
  }
  assert.equal(first.resolvedProducts[0].resolution.status, 'alias');
  assert.equal(second.resolvedProducts[0].resolution.status, 'canonical');
  assert.equal(first.resolvedProducts[0].versions, '< 2.0');
  assert.equal(second.resolvedProducts[0].versions, '2.x');
  assert.deepEqual(first.advisoryGroups.map((group) => group.id), ['SYN-SHARED', 'SYN-SEPARATE']);
  assert.deepEqual(second.advisoryGroups.map((group) => group.id), ['SYN-SHARED']);
  const shared = first.advisoryGroups[0];
  assert.equal(shared.occurrences.length, 3);
  assert.deepEqual(shared.evidence.map((item) => item.originalEvidence), [aliasModules[0].evidence[0], aliasModules[1].evidence[0]]);
  assert.deepEqual(shared.cves.map((item) => item.cvss), [9.8, 8.1, 6.5]);
  assert.equal(first.advisoryGroups[1].occurrences.length, 1);
  assert.deepEqual([...findDuplicateAdvisories(aliasModules)], [['SYN-SHARED', ['synthetic/alias-one', 'synthetic/alias-two']]]);
  assert.deepEqual(first.dependencyLinks.map((link) => [link.targetId, link.status]), [
    ['synthetic/alias-two', 'resolved'], ['synthetic/inventory', 'resolved'], ['synthetic/missing', 'missing'],
  ]);
  // A cycle is metadata, not a reason to infer the first module's other links.
  assert.deepEqual(second.dependencyLinks.map((link) => link.targetId), ['synthetic/alias-one']);
  assert.equal(first.priority.cvssMax, 9.8);
  assert.equal(first.priority.confidence.score, 74); // 90 - CVSS conflict 12 - duplicates 4
  assert.equal(second.priority.confidence.score, 78); // 90 - duplicates 4 - unknown patch 8
  assert.equal(first.patchConfidence.score, 90);
  assert.equal(second.patchConfidence.score, 0);
  assert.match(first.patchConfidence.reasons.join(' '), /not a patch availability score/);
  assert.match(second.patchConfidence.reasons.join(' '), /No explicit patch-status evidence/);

  const queue = buildRemediationQueue(enriched);
  assert.equal(queue.length, 2);
  assert.match(queue.find((item) => item.moduleId === first.id).action, /compensating-control/);
  assert.match(queue.find((item) => item.moduleId === second.id).action, /Verify vendor fix/);
  const [headers, ...rows] = parseCsv(exportQueueCsv(queue));
  const report = exportQueueMarkdown(queue, '2026-10-14T00:00:00.000Z');
  const contexts = [...report.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.equal(rows.length, queue.length);
  assert.equal(contexts.length, queue.length);
  queue.forEach((item, index) => {
    const cell = (header) => rows[index][headers.indexOf(header)];
    assert.equal(cell('Module ID'), item.moduleId);
    assert.equal(cell('Action'), item.action);
    assert.equal(cell('Patch confidence'), `${item.patchConfidence.score} (${item.patchConfidence.label})`);
    assert.deepEqual(JSON.parse(cell('Patch confidence reasons')), item.patchConfidence.reasons);
    assert.deepEqual(JSON.parse(cell('Patch evidence')), item.patchConfidence.evidence);
    assert.deepEqual(contexts[index].products, JSON.parse(cell('Products (canonical+raw+resolution)')));
    assert.deepEqual(contexts[index].dependencies, JSON.parse(cell('Dependencies (source->target relations/status)')));
    const groups = JSON.parse(cell('Advisory groups (IDs/counts/source provenance)'));
    assert.deepEqual(groups.map(({ count, sources, ...group }) => group), item.advisoryGroups);
    assert.deepEqual(contexts[index].advisoryGroups, item.advisoryGroups);
    assert.deepEqual(contexts[index].patchEvidence, item.patchConfidence.evidence);
    for (const reason of item.patchConfidence.reasons) assert.ok(report.includes(reason));
  });
  assert.deepEqual(aliasModules, before);
});

// Parse RFC-style quoted CSV, including embedded quotes and newlines, to compare actual cells.
function parseCsv(csv) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(cell); cell = '';
      if (character === '\n') { rows.push(row); row = []; }
    } else cell += character;
  }
  row.push(cell); rows.push(row);
  return rows;
}

test('CSV and Markdown exports share queue context, preserve evidence, and neutralize formula cells', () => {
  const queue = buildRemediationQueue(ranked);
  const csv = exportQueueCsv(queue);
  const markdown = exportQueueMarkdown(queue, '2026-10-14T00:00:00.000Z');
  assert.match(csv, /^"Order","Module","Priority","Severity","Patch status","Action","Owner","Due","Module ID"/);
  assert.match(csv, /SYN-CVE-2026-1001/);
  assert.match(csv, /verdant-reporting-server/);
  assert.match(markdown, /## Audit appendix/);
  assert.match(markdown, /SYN-CVE-2026-1001/);
  assert.match(markdown, /Patch confidence reasons/);
  const injectionQueue = [{ ...queue[0], name: '=FORMULA', action: '+unsafe', owner: ' @owner', due: '-1' }];
  const injectionCsv = exportQueueCsv(injectionQueue);
  assert.match(injectionCsv, /'=FORMULA/);
  assert.match(injectionCsv, /'\+unsafe/);
  assert.match(injectionCsv, /' @owner/);
  assert.match(injectionCsv, /'-1/);
  assert.match(exportQueueCsv([{ ...queue[0], name: 'A, "quoted" value' }]), /"A, ""quoted"" value"/);
  const [headers, ...rows] = parseCsv(csv);
  const audits = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.equal(rows.length, queue.length);
  assert.equal(audits.length, queue.length);
  queue.forEach((item, index) => {
    const cell = (header) => rows[index][headers.indexOf(header)];
    assert.equal(cell('Module ID'), item.moduleId);
    assert.equal(cell('Action'), item.action);
    assert.equal(cell('Due'), item.due);
    assert.deepEqual(JSON.parse(cell('Evidence')), item.evidence);
    assert.deepEqual(JSON.parse(cell('CVE records')), item.cves);
    assert.deepEqual(JSON.parse(cell('Patch evidence')), item.patchConfidence.evidence);
    assert.equal(cell('Patch note'), item.patchNote);
    assert.deepEqual(JSON.parse(cell('Priority details')), item.priorityDetails);
    assert.deepEqual(audits[index].evidence, item.evidence);
    assert.deepEqual(audits[index].patchEvidence, item.patchConfidence.evidence);
    assert.deepEqual(audits[index].cves, item.cves);
    assert.deepEqual(audits[index].products, JSON.parse(cell('Products (canonical+raw+resolution)')));
    assert.deepEqual(audits[index].dependencies, JSON.parse(cell('Dependencies (source->target relations/status)')));
    assert.deepEqual(audits[index].advisoryGroups, item.advisoryGroups);
  });
  const dangerous = ['=SUM(1)', '+cmd', '-cmd', '@cmd', '  =cmd', '\t+cmd', '\n@cmd'];
  for (const value of dangerous) {
    const parsed = parseCsv(exportQueueCsv([{ ...queue[0], name: value, moduleId: value, owner: value }]));
    assert.equal(parsed[1][1], `'${value}`);
    assert.equal(parsed[1][6], `'${value}`);
    assert.equal(parsed[1][8], `'${value}`);
  }
  const multiline = 'A, "quoted" value\nSecond line';
  assert.equal(parseCsv(exportQueueCsv([{ ...queue[0], name: multiline }]))[1][1], multiline);
});
