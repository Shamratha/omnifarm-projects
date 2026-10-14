(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuditView = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Shared, serializable presentation data. UI, filters, CSV and JSON use this
  // projection, rather than reinterpreting a default policy as path permission.
  const defaults = { query: '', type: 'all', firewall: 'all', issue: 'all' };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const displayValue = (value) => typeof value === 'object' ? JSON.stringify(value) : String(value);
  const depthLabel = (depth) => depth === 0 ? 'local' : `inherited ${depth} hop${depth === 1 ? '' : 's'}`;
  const chainRows = (chain) => chain.map((qube, depth) => ({ qubeId: qube.id, name: qube.name, depth, role: depth === 0 ? 'selected' : depth === chain.length - 1 ? 'root template' : 'template' }));

  function firewallSummary(report) {
    const policy = report.effective.firewall;
    const evaluations = report.evaluations || [];
    const groups = [];
    evaluations.forEach((evaluation) => {
      const group = groups.find((item) => item.scope === evaluation.scope && item.decision === evaluation.result.decision);
      if (group) group.count += 1;
      else groups.push({ scope: evaluation.scope, decision: evaluation.result.decision, count: 1 });
    });
    groups.forEach((group) => {
      const word = group.decision === 'none' ? 'inconclusive' : group.decision;
      group.label = `${group.count} ${group.scope === 'path' ? 'path' : 'local'} ${word}`;
    });
    const decisions = [...new Set(evaluations.map((evaluation) => evaluation.result.decision))];
    return {
      default: policy.default,
      defaultSource: policy.defaultSource,
      defaultLabel: policy.available ? `${policy.resolved === false ? 'provisional ' : ''}default ${policy.default}` : 'no policy',
      decision: decisions.length > 1 ? 'mixed' : decisions[0] || 'untested',
      label: groups.map((group) => group.label).join(' · ') || 'not evaluated',
      groups,
    };
  }

  function inventoryRow(qube, report) {
    const chain = chainRows(report.effective.chain);
    const path = report.network.path.map((entry) => ({ qubeId: entry.id, name: entry.name }));
    return {
      qubeId: qube.id, name: qube.name, type: qube.type,
      trustDomain: qube.trustDomain, label: qube.label,
      templateChain: chain, templateDepth: report.effective.depth,
      templateResolved: report.effective.resolved,
      templateText: chain.slice(1).map((entry) => entry.name).join(' → ') || '—',
      networkPath: path, networkResolved: report.network.resolved,
      networkText: path.length > 1 ? path.map((entry) => entry.name).join(' → ') : qube.providesNetwork ? `${qube.name} (uplink)` : 'offline / no NetVM',
      firewall: firewallSummary(report),
      issueCount: report.issueCount,
    };
  }

  function matchesFilters(qube, row, filters) {
    const haystack = [qube.name, qube.id, qube.type, qube.trustDomain, qube.label.name, ...(qube.tags || [])].join(' ').toLowerCase();
    const needle = filters.query.trim().toLowerCase();
    const firewallMatch = filters.firewall === 'all' ||
      (filters.firewall === 'untested' ? row.firewall.groups.length === 0 : row.firewall.groups.some((group) => group.decision === filters.firewall));
    return (!needle || haystack.includes(needle)) && (filters.type === 'all' || filters.type === qube.type) && firewallMatch &&
      (filters.issue === 'all' || (filters.issue === 'issue' ? row.issueCount > 0 : row.issueCount === 0));
  }

  function selectedDetail(qube, report, evaluationId) {
    if (!qube || !report) return null;
    const evaluations = report.evaluations || [];
    const evaluation = evaluations.find((item) => item.id === evaluationId) || evaluations[0] || null;
    return {
      qubeId: qube.id, name: qube.name, type: qube.type,
      trustDomain: qube.trustDomain, label: qube.label,
      resolved: report.effective.resolved, depth: report.effective.depth,
      chain: chainRows(report.effective.chain),
      diagnostics: report.effective.diagnostics,
      fields: Object.entries(report.effective.values).map(([key, value]) => {
        const source = report.effective.provenance[key];
        return { key, value, displayValue: displayValue(value), ...source, sourceLabel: `${source.qubeName} · ${depthLabel(source.depth)}` };
      }),
      network: report.network,
      firewall: report.effective.firewall,
      evaluations, selectedEvaluation: evaluation,
      findings: report.findings, issueCount: report.issueCount,
    };
  }

  function graphView(analysis, detail) {
    const selectedReport = detail && analysis.reportById.get(detail.qubeId);
    const chain = detail?.chain || [];
    const chainDepth = new Map(chain.map((entry) => [entry.qubeId, entry.depth]));
    const evaluation = detail?.selectedEvaluation;
    // A local firewall sample must never color a routing edge as allowed.
    const steps = evaluation?.scope === 'path' ? evaluation.result.steps : [];
    const stepById = new Map(steps.map((step) => [step.qubeId, step]));
    const selectedDiagnostics = [...(selectedReport?.effective.diagnostics || []), ...(selectedReport?.network.diagnostics || []), ...(evaluation?.result.diagnostics || [])];
    const nodes = analysis.fixture.qubes.map((qube) => {
      const step = stepById.get(qube.id);
      return {
        qubeId: qube.id, name: qube.name, type: qube.type, trustDomain: qube.trustDomain,
        position: qube.position, missing: false,
        selected: qube.id === detail?.qubeId,
        templateDepth: chainDepth.has(qube.id) ? chainDepth.get(qube.id) : null,
        routeStatus: !step ? 'structural' : step.status === 'unreachable' ? 'unreachable' : step.decision === 'deny' ? 'blocked' : step.decision === 'none' ? 'inconclusive' : step.status === 'pass-through' ? 'pass-through' : 'allowed',
        issueCount: analysis.reportById.get(qube.id).issueCount,
      };
    });
    const positions = new Map(nodes.map((node) => [node.qubeId, node.position]));
    const missingX = Math.max(700, ...nodes.map((node) => Number(node.position.x))) + 220;
    let missingIndex = 0;
    const edges = analysis.edges.map((edge) => {
      if (!positions.has(edge.to)) {
        const position = { x: missingX, y: 60 + missingIndex++ * 110 };
        positions.set(edge.to, position);
        nodes.push({ qubeId: edge.to, name: edge.to, type: 'Missing', trustDomain: 'unresolved', position, missing: true, selected: false, templateDepth: null, routeStatus: 'inconclusive', issueCount: 1 });
      }
      const fromDepth = chainDepth.get(edge.from);
      const toDepth = chainDepth.get(edge.to);
      const selectedTemplate = edge.type === 'template' && ((fromDepth !== undefined && toDepth === fromDepth + 1) || selectedDiagnostics.some((item) => item.type === 'template' && item.from === edge.from && item.to === edge.to));
      const fromStep = stepById.get(edge.from);
      const toStep = stepById.get(edge.to);
      let routeStatus = 'structural';
      if (edge.type === 'netvm' && fromStep && toStep) {
        routeStatus = fromStep.decision !== 'allow' || toStep.status === 'unreachable' ? 'unreachable' : toStep.decision === 'deny' ? 'blocked' : toStep.decision === 'none' ? 'inconclusive' : toStep.status === 'pass-through' ? 'pass-through' : 'allowed';
      }
      const violationCodes = [...new Set([...edge.violationCodes, ...selectedDiagnostics.filter((item) => item.type === edge.type && item.from === edge.from && item.to === edge.to).map((item) => item.code)])];
      const templateLabel = selectedTemplate && toDepth !== undefined ? `inherits · depth ${toDepth}` : 'inherits';
      const routeLabels = { structural: 'netvm (route only)', allowed: 'request allowed', 'pass-through': 'fixture pass-through', blocked: 'blocked here', unreachable: 'not reached', inconclusive: 'inconclusive' };
      return { ...edge, violationCodes, selectedTemplate, templateDepth: selectedTemplate ? toDepth ?? null : null, routeStatus, label: edge.broken ? 'missing reference' : edge.cycle ? 'cycle' : edge.type === 'template' ? templateLabel : routeLabels[routeStatus] };
    });
    return {
      nodes, edges,
      width: Math.max(870, ...nodes.map((node) => Number(node.position.x) + 172)),
      height: Math.max(380, ...nodes.map((node) => Number(node.position.y) + 80)),
      chainLabel: chain.map((entry) => `${entry.name} [${entry.depth}]`).join(' → '),
      resolved: detail?.resolved ?? false,
      requestLabel: evaluation ? `${evaluation.label} · ${evaluation.scope === 'path' ? 'end-to-end path' : 'local firewall only'} · ${evaluation.result.decision}` : 'No request evaluated; routing edges are dependencies, not permission.',
    };
  }

  function buildView(analysis, context = {}) {
    const filters = { ...defaults, ...context.filters };
    const selectedQube = analysis.fixture.qubes.find((qube) => qube.id === context.selectedId) || analysis.fixture.qubes[0];
    const detail = selectedDetail(selectedQube, selectedQube && analysis.reportById.get(selectedQube.id), context.evaluationId);
    const inventory = analysis.fixture.qubes.map((qube) => inventoryRow(qube, analysis.reportById.get(qube.id))).filter((row) => matchesFilters(analysis.fixture.qubes.find((qube) => qube.id === row.qubeId), row, filters));
    return {
      filters, selectedId: detail?.qubeId || null, evaluationId: detail?.selectedEvaluation?.id || null,
      inventory, visibleIds: inventory.map((row) => row.qubeId),
      detail, graph: graphView(analysis, detail),
    };
  }

  function buildExportPayload(analysis, context = {}) {
    return copy({
      schemaVersion: '2.0', snapshotMode: 'deterministic-local-snapshot',
      scope: 'complete-audit-with-visible-inventory',
      fixture: analysis.fixture,
      analysis: { summary: analysis.summary, reports: analysis.reports, edges: analysis.edges },
      view: buildView(analysis, context),
    });
  }

  return { buildView, buildExportPayload, depthLabel };
}));
