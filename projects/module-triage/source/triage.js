export const PATCH_LABELS = {
  available: 'Patch available',
  partial: 'Partial coverage',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
};

export const CONFIDENCE_LABELS = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const PATCH_WEIGHTS = { unavailable: 18, unknown: 11, partial: 8, available: 2 };
const SEVERITY_WEIGHTS = { critical: 12, high: 9, medium: 6, low: 3 };

const asArray = (value) => Array.isArray(value) ? value : [];
const advisoryId = (advisory) => typeof advisory === 'string' ? advisory : advisory?.id;
const cloneRecord = (record) => record && typeof record === 'object' ? { ...record } : record;

export function normalizeCvss(records = []) {
  const values = asArray(records).map((record) => Number(record.cvss)).filter(Number.isFinite);
  if (!values.length) return { max: 0, min: 0, conflicting: false, spread: 0 };
  const max = Math.max(...values);
  const min = Math.min(...values);
  return { max, min, conflicting: max - min >= 0.6, spread: Number((max - min).toFixed(1)) };
}

export function getEvidenceConfidence(module) {
  const evidence = asArray(module.evidence);
  const sourceScore = evidence.length
    ? evidence.reduce((sum, item) => sum + Number(item.confidence ?? 0), 0) / evidence.length
    : 0;
  const cvss = normalizeCvss(module.cves);
  let score = sourceScore;
  if (cvss.conflicting) score -= 12;
  if ((module.duplicateAdvisories ?? []).length) score -= 4;
  if (module.patchStatus?.status === 'unknown') score -= 8;
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  const level = bounded >= 78 ? 'high' : bounded >= 52 ? 'medium' : 'low';
  return { score: bounded, level, label: CONFIDENCE_LABELS[level] };
}

export function getExploitability(module) {
  const prerequisites = asArray(module.prerequisites);
  let score = 0;
  if (prerequisites.some((item) => /unauthenticated|no auth|public/i.test(item))) score += 18;
  if (prerequisites.some((item) => /network|remote|internet/i.test(item))) score += 12;
  if (prerequisites.some((item) => /user|credential|access/i.test(item))) score += 4;
  if (prerequisites.some((item) => /configuration|feature|specific/i.test(item))) score -= 5;
  return Math.max(0, Math.min(30, score));
}

export function calculatePriority(module) {
  const cvss = normalizeCvss(module.cves);
  const severity = String(module.severity ?? 'medium').toLowerCase();
  const patch = PATCH_WEIGHTS[module.patchStatus?.status] ?? PATCH_WEIGHTS.unknown;
  const exploitability = getExploitability(module);
  const confidence = getEvidenceConfidence(module);
  const score = Math.round(cvss.max * 6 + (SEVERITY_WEIGHTS[severity] ?? 6) + exploitability + patch + confidence.score / 10);
  return {
    score: Math.min(100, score),
    cvssMax: cvss.max,
    cvssMin: cvss.min,
    cvssConflict: cvss.conflicting,
    cvssSpread: cvss.spread,
    exploitability,
    patchWeight: patch,
    confidence,
  };
}

function advisoryGroupsFor(modules) {
  const groups = new Map();
  for (const module of modules) {
    for (const [index, advisory] of asArray(module.advisories).entries()) {
      const id = advisoryId(advisory);
      if (!id) continue;
      const group = groups.get(id) ?? { id, occurrences: [], moduleIds: [], evidence: [], cves: [] };
      group.occurrences.push({ moduleId: module.id, index, record: advisory });
      if (!group.moduleIds.includes(module.id)) group.moduleIds.push(module.id);
      groups.set(id, group);
    }
  }
  for (const group of groups.values()) {
    for (const module of modules) {
      const hasMatchingOccurrence = group.occurrences.some((occurrence) => occurrence.moduleId === module.id);
      if (!hasMatchingOccurrence) continue;
      for (const evidence of asArray(module.evidence)) {
        if (evidence.advisoryId && evidence.advisoryId !== group.id) continue;
        group.evidence.push({ ...evidence, moduleId: module.id, ...(evidence.advisoryId ? {} : { scope: 'module' }), originalEvidence: evidence });
      }
      for (const cve of asArray(module.cves)) {
        if (cve.advisoryId && cve.advisoryId !== group.id) continue;
        group.cves.push({ ...cve, moduleId: module.id, ...(cve.advisoryId ? {} : { scope: 'module' }), originalCve: cve });
      }
    }
  }
  return groups;
}

export function findDuplicateAdvisories(modules) {
  const groups = advisoryGroupsFor(modules);
  return new Map([...groups.values()]
    .filter((group) => group.occurrences.length > 1)
    .map((group) => [group.id, [...new Set(group.moduleIds)]]));
}

function normalizedLabel(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function resolveProduct(product, productCatalog) {
  const original = { vendor: product?.vendor, name: product?.name, versions: product?.versions };
  const vendor = normalizedLabel(product?.vendor);
  const name = normalizedLabel(product?.name);
  const candidates = [];
  for (const catalogProduct of asArray(productCatalog)) {
    const canonicalMatch = normalizedLabel(catalogProduct.vendor) === vendor && normalizedLabel(catalogProduct.name) === name;
    const aliasMatch = asArray(catalogProduct.aliases).some((alias) => normalizedLabel(alias.vendor) === vendor && normalizedLabel(alias.name) === name);
    if (vendor && name && (canonicalMatch || aliasMatch)) candidates.push({ catalogProduct, aliasMatch: !canonicalMatch && aliasMatch });
  }
  const ids = candidates.map(({ catalogProduct }) => catalogProduct.id);
  const status = candidates.length === 1 ? (candidates[0].aliasMatch ? 'alias' : 'canonical') : candidates.length > 1 ? 'ambiguous' : 'unresolved';
  const reason = status === 'canonical'
    ? 'Exact normalized vendor and product name matched the catalog.'
    : status === 'alias'
      ? 'Exact normalized vendor and product name matched a configured catalog alias.'
      : status === 'ambiguous'
        ? 'More than one catalog product matched; no product was selected.'
        : 'No exact normalized vendor and product name matched the catalog.';
  const result = {
    vendor: candidates.length === 1 ? candidates[0].catalogProduct.vendor : product?.vendor,
    name: candidates.length === 1 ? candidates[0].catalogProduct.name : product?.name,
    versions: product?.versions,
    canonicalId: status === 'canonical' || status === 'alias' ? ids[0] : null,
    original,
    resolution: { status, reason, candidates: ids },
  };
  const matched = candidates.length === 1 ? candidates[0].catalogProduct : null;
  if (matched?.aliases?.length) result.aliases = matched.aliases.map(cloneRecord);
  if (product?.aliases?.length) result.aliases = [...(result.aliases ?? []), ...product.aliases.map(cloneRecord)];
  if (result.aliases?.length) {
    const seen = new Set();
    result.aliases = result.aliases.filter((alias) => {
      const key = `${normalizedLabel(alias.vendor)}\u0000${normalizedLabel(alias.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return result;
}

function resolveDependencies(modules, dependencyModules) {
  // Workspace records take precedence over lightweight metadata for the same ID.
  const targets = new Map([...asArray(dependencyModules), ...modules].map((item) => [item.id, item]));
  return modules.map((module) => {
    const seen = new Set();
    const dependencyLinks = [];
    for (const dependency of asArray(module.dependencies)) {
      const targetId = dependency?.moduleId ?? dependency?.id;
      if (!targetId) continue;
      const target = targets.get(targetId);
      const edgeKey = `${targetId}\u0000${dependency.relation ?? ''}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      dependencyLinks.push({
        moduleId: targetId,
        sourceModuleId: module.id,
        targetId,
        relation: dependency.relation ?? 'depends on',
        status: target ? 'resolved' : 'missing',
        target: target ? { id: target.id, name: target.name, type: target.type, platform: target.platform } : null,
      });
    }
    return { ...module, dependencyLinks };
  });
}

function getPatchConfidence(module) {
  const evidence = asArray(module.patchStatus?.evidence).map(cloneRecord);
  const statuses = [...new Set(evidence.map((item) => item.status).filter(Boolean))];
  const status = module.patchStatus?.status ?? 'unknown';
  const reasons = [];
  if (!evidence.length) {
    reasons.push('No explicit patch-status evidence was supplied; confidence is low.');
    return { score: 0, level: 'low', label: CONFIDENCE_LABELS.low, reasons, evidence };
  }
  const average = evidence.reduce((sum, item) => sum + (Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0), 0) / evidence.length;
  reasons.push(`Source-confidence mean: ${Math.round(average)}/100 before penalties and caps. This is a synthetic heuristic, not a probability.`);
  const supporting = evidence.filter((item) => item.status === status);
  if (supporting.length) reasons.push(`${supporting.length} explicit observation${supporting.length === 1 ? '' : 's'} support status "${status}": ${supporting.map((item) => item.source ?? 'Unspecified source').join(', ')}.`);
  if (statuses.length > 1 || (statuses.length === 1 && statuses[0] !== status)) {
    reasons.push(`Patch observations conflict with the module status (${statuses.join(', ')} vs ${status}); subtract 25 confidence points.`);
  }
  if (!statuses.length) reasons.push('Explicit observations do not specify a patch status; source support is unconfirmed.');
  if (status === 'partial') reasons.push(`Evidence indicates incomplete branch or asset coverage: ${supporting.map((item) => item.detail).filter(Boolean).join('; ') || 'Coverage details were not supplied.'}`);
  if (status === 'available') reasons.push('Availability does not establish deployment or complete affected-branch coverage; stage and validate the fix.');
  if (status === 'unknown') reasons.push('Unknown status remains uncertain and is capped at low confidence.');
  if (status === 'unavailable') reasons.push('Unavailable is evidence confidence only; it is not a patch availability score.');
  let score = Math.round(average);
  if (statuses.length > 1 || (statuses.length === 1 && statuses[0] !== status)) score -= 25;
  if (!statuses.length) score = Math.min(score, 35);
  if (status === 'unknown') score = Math.min(score, 35);
  score = Math.max(0, Math.min(100, score));
  const level = score >= 78 ? 'high' : score >= 52 ? 'medium' : 'low';
  return { score, level, label: CONFIDENCE_LABELS[level], reasons, evidence };
}

export function enrichModules(modules, { productCatalog = [], dependencyModules = [] } = {}) {
  const groups = advisoryGroupsFor(modules);
  const duplicateMap = new Map([...groups.values()]
    .filter((group) => group.occurrences.length > 1)
    .map((group) => [group.id, group]));
  const linked = resolveDependencies(modules, dependencyModules);
  return linked.map((module) => {
    const advisoryGroups = asArray(module.advisories)
      .map(advisoryId)
      .filter((id, index, ids) => id && ids.indexOf(id) === index)
      .map((id) => groups.get(id));
    const duplicateAdvisories = advisoryGroups.filter((group) => duplicateMap.has(group.id)).map((group) => group.id);
    const enriched = {
      ...module,
      resolvedProducts: asArray(module.products).map((product) => resolveProduct(product, productCatalog)),
      advisoryGroups,
      duplicateAdvisories,
      patchConfidence: getPatchConfidence(module),
    };
    enriched.priority = calculatePriority(enriched);
    return enriched;
  }).sort((a, b) => b.priority.score - a.priority.score || a.name.localeCompare(b.name));
}

function productSearchLabels(module) {
  const labels = [];
  for (const product of asArray(module.products)) {
    labels.push(product.vendor, product.name, `${product.vendor} ${product.name}`);
    for (const alias of asArray(product.aliases)) labels.push(alias.vendor, alias.name, `${alias.vendor} ${alias.name}`);
  }
  for (const product of asArray(module.resolvedProducts)) {
    labels.push(product.canonicalId, product.vendor, product.name, `${product.vendor} ${product.name}`);
    for (const alias of asArray(product.aliases)) labels.push(alias.vendor, alias.name, `${alias.vendor} ${alias.name}`);
  }
  return labels;
}

export function filterModules(modules, filters = {}) {
  const search = String(filters.search ?? '').trim().toLowerCase();
  return modules.filter((module) => {
    const haystack = [module.name, module.id, module.description, module.platform, ...asArray(module.advisories).map(advisoryId), ...asArray(module.cves).map((cve) => cve.id), ...productSearchLabels(module)].join(' ').toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (filters.severity && filters.severity !== 'all' && module.severity !== filters.severity) return false;
    if (filters.patchStatus && filters.patchStatus !== 'all' && module.patchStatus?.status !== filters.patchStatus) return false;
    if (filters.confidence && filters.confidence !== 'all' && module.priority?.confidence?.level !== filters.confidence) return false;
    if (filters.flagged && !(module.priority?.cvssConflict || module.patchStatus?.status === 'unavailable' || module.duplicateAdvisories?.length)) return false;
    return true;
  });
}

function queueAction(status) {
  return {
    available: 'Stage, validate, and schedule remediation',
    partial: 'Review branch coverage and schedule remaining remediation',
    unknown: 'Verify vendor fix and apply temporary controls',
    unavailable: 'Open compensating-control review',
  }[status] ?? 'Review remediation status';
}

export function buildRemediationQueue(modules) {
  return [...modules]
    .filter((module) => module.patchStatus?.status !== 'remediated' && !module.patchStatus?.remediated && !module.remediated)
    .map((module, index) => ({ module, index }))
    .sort((a, b) => b.module.priority.score - a.module.priority.score || a.index - b.index)
    .map(({ module }, index) => ({
      order: index + 1,
      moduleId: module.id,
      name: module.name,
      priority: module.priority.score,
      severity: module.severity,
      patchStatus: module.patchStatus?.status ?? 'unknown',
      action: queueAction(module.patchStatus?.status ?? 'unknown'),
      owner: module.owner,
      due: module.patchStatus?.status === 'unavailable' ? 'Track vendor status' : module.patchStatus?.eta ?? 'Set date',
      resolvedProducts: module.resolvedProducts ?? [],
      advisoryGroups: module.advisoryGroups ?? [],
      dependencyLinks: module.dependencyLinks ?? [],
      patchConfidence: module.patchConfidence ?? getPatchConfidence(module),
      evidence: asArray(module.evidence),
      cves: asArray(module.cves),
      priorityDetails: module.priority,
      patchNote: module.patchStatus?.note ?? '',
    }));
}

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^\s*[+\-=@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const json = (value) => JSON.stringify(value ?? []);
const productExport = (products) => asArray(products).map((product) => ({
  canonical: { id: product.canonicalId, vendor: product.vendor, name: product.name },
  versions: product.versions,
  raw: product.original,
  resolution: product.resolution,
  aliases: product.aliases ?? [],
}));
const dependencyExport = (links) => asArray(links).map((link) => ({ source: link.sourceModuleId, targetId: link.targetId ?? link.moduleId, relation: link.relation, status: link.status, target: link.target }));
const advisoryExport = (groups) => asArray(groups).map((group) => ({ id: group.id, count: group.occurrences.length, sources: [...new Set([...group.occurrences, ...group.evidence, ...group.cves].map((item) => item.record?.source ?? item.source).filter(Boolean))] }));

export function exportQueueCsv(queue) {
  const headers = ['Order', 'Module', 'Priority', 'Severity', 'Patch status', 'Action', 'Owner', 'Due', 'Module ID', 'Products (canonical+raw+resolution)', 'Patch confidence', 'Patch confidence reasons', 'Dependencies (source->target relations/status)', 'Advisory groups (IDs/counts/source provenance)', 'Evidence', 'CVE records', 'Patch evidence', 'Patch note', 'Priority details'];
  const rows = queue.map((item) => [
    item.order, item.name, item.priority, item.severity, PATCH_LABELS[item.patchStatus] ?? item.patchStatus, item.action, item.owner, item.due,
    item.moduleId, json(productExport(item.resolvedProducts)), `${item.patchConfidence?.score ?? 0} (${item.patchConfidence?.label ?? 'Low'})`, json(item.patchConfidence?.reasons), json(dependencyExport(item.dependencyLinks)), json(asArray(item.advisoryGroups).map((group) => ({ ...group, ...advisoryExport([group])[0] }))), json(item.evidence), json(item.cves), json(item.patchConfidence?.evidence), item.patchNote, json(item.priorityDetails),
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function markdownValue(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

export function exportQueueMarkdown(queue, generatedAt = new Date().toISOString()) {
  const lines = [
    '# Safe remediation queue',
    '',
    `Generated ${generatedAt}. Synthetic local dataset only; no exploit execution or target contact is performed.`,
    '',
    '| # | Module | Priority | Severity | Patch status | Action | Owner | Due |',
    '|---:|---|---:|---|---|---|---|---|',
  ];
  for (const item of queue) lines.push(`| ${item.order} | ${markdownValue(item.name)} | ${item.priority} | ${item.severity} | ${markdownValue(PATCH_LABELS[item.patchStatus] ?? item.patchStatus)} | ${markdownValue(item.action)} | ${markdownValue(item.owner)} | ${markdownValue(item.due)} |`);
  lines.push('', '## Audit appendix', '', 'All queue records include the source context used for resolution, prioritization, and safe remediation planning.');
  for (const item of queue) {
    lines.push('', `### ${item.order}. ${markdownValue(item.name)}`, '', `- Module ID: ${markdownValue(item.moduleId)}`, `- Patch confidence: ${item.patchConfidence?.score ?? 0} (${item.patchConfidence?.label ?? 'Low'})`, `- Patch confidence reasons: ${markdownValue(item.patchConfidence?.reasons?.join(' | ') ?? '')}`, `- Patch note: ${markdownValue(item.patchNote ?? '')}`);
    const context = {
      products: productExport(item.resolvedProducts),
      dependencies: dependencyExport(item.dependencyLinks),
      advisoryGroups: item.advisoryGroups ?? [],
      evidence: item.evidence ?? [],
      cves: item.cves ?? [],
      patchEvidence: item.patchConfidence?.evidence ?? [],
      priorityDetails: item.priorityDetails,
    };
    // JSON escapes control characters; choose a fence longer than any data backticks.
    const auditJson = JSON.stringify(context, null, 2);
    const fenceLength = Math.max(3, ...[...auditJson.matchAll(/`+/g)].map((match) => match[0].length + 1));
    const fence = '`'.repeat(fenceLength);
    lines.push('', `${fence}json`, auditJson, fence);
  }
  return lines.join('\n');
}

export function exportAuditMarkdown(modules, queue, generatedAt) {
  return exportQueueMarkdown(queue ?? buildRemediationQueue(modules), generatedAt);
}
