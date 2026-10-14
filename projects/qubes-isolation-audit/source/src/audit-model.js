(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IsolationAudit = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This model intentionally covers a small, explicit subset of Qubes concepts.
  // It never talks to a hypervisor and should be treated as a fixture analyzer,
  // not as an implementation of Qubes security semantics.

  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const byId = (fixture) => new Map((fixture.qubes || []).map((qube) => [qube.id, qube]));

  function edgeDiagnostic(code, severity, qubeId, message, from, to, type) {
    return { code, severity, qubeId, message, from, to, type };
  }

  function normalizeFixture(source) {
    const fixture = clone(source);
    fixture.version = fixture.version || '1.0';
    fixture.qubes = (fixture.qubes || []).map((qube) => ({
      id: qube.id,
      name: qube.name || qube.id,
      type: qube.type || 'AppVM',
      label: qube.label || { name: 'gray', color: '#81939b' },
      trustDomain: qube.trustDomain || 'unclassified',
      tags: qube.tags || [],
      templateId: qube.templateId || null,
      netvmId: qube.netvmId || null,
      config: qube.config || {},
      firewall: qube.firewall || null,
      policy: qube.policy || {},
      position: qube.position || { x: 100, y: 100 },
      providesNetwork: Boolean(qube.providesNetwork),
    }));
    return fixture;
  }

  function resolveTemplateChain(fixtureSource, qubeId) {
    const fixture = normalizeFixture(fixtureSource);
    const qubes = byId(fixture);
    const chain = [];
    const diagnostics = [];
    const seen = new Set();
    let currentId = qubeId;

    while (currentId) {
      if (seen.has(currentId)) {
        const previous = chain[chain.length - 1];
        diagnostics.push(edgeDiagnostic('TEMPLATE_CYCLE', 'high', qubeId, `Template cycle detected at ${currentId}.`, previous ? previous.id : qubeId, currentId, 'template'));
        break;
      }
      seen.add(currentId);
      const current = qubes.get(currentId);
      if (!current) {
        const previous = chain[chain.length - 1];
        diagnostics.push(edgeDiagnostic('MISSING_TEMPLATE', 'high', qubeId, `Template reference ${currentId} does not exist.`, previous ? previous.id : qubeId, currentId, 'template'));
        break;
      }
      chain.push(current);
      if (!current.templateId) break;
      if (!qubes.has(current.templateId)) {
        diagnostics.push(edgeDiagnostic('MISSING_TEMPLATE', 'high', qubeId, `${current.name} references missing template ${current.templateId}.`, current.id, current.templateId, 'template'));
        break;
      }
      currentId = current.templateId;
    }
    return { chain, diagnostics, resolved: diagnostics.length === 0 };
  }

  function resolveNetworkPath(fixtureSource, qubeId) {
    const fixture = normalizeFixture(fixtureSource);
    const qubes = byId(fixture);
    const path = [];
    const diagnostics = [];
    const seen = new Set();
    let currentId = qubeId;
    while (currentId) {
      if (seen.has(currentId)) {
        const previous = path[path.length - 1];
        diagnostics.push(edgeDiagnostic('NETVM_CYCLE', 'high', qubeId, `NetVM cycle detected at ${currentId}.`, previous ? previous.id : qubeId, currentId, 'netvm'));
        break;
      }
      seen.add(currentId);
      const current = qubes.get(currentId);
      if (!current) {
        const previous = path[path.length - 1];
        diagnostics.push(edgeDiagnostic('MISSING_NETVM', 'high', qubeId, `NetVM reference ${currentId} does not exist.`, previous ? previous.id : qubeId, currentId, 'netvm'));
        break;
      }
      path.push(current);
      if (!current.netvmId) break;
      if (!qubes.has(current.netvmId)) {
        diagnostics.push(edgeDiagnostic('MISSING_NETVM', 'high', qubeId, `${current.name} references missing NetVM ${current.netvmId}.`, current.id, current.netvmId, 'netvm'));
        break;
      }
      currentId = current.netvmId;
    }
    return { path, diagnostics, resolved: diagnostics.length === 0 };
  }

  function resolveEffectiveConfig(fixtureSource, qubeId) {
    const fixture = normalizeFixture(fixtureSource);
    const result = resolveTemplateChain(fixture, qubeId);
    const effective = {};
    const provenance = {};
    // Resolve root first, then each child toward the selected qube. Keep these
    // values as provisional evidence when a missing/cyclic chain is unresolved.
    result.chain.slice().reverse().forEach((qube) => {
      Object.entries(qube.config || {}).forEach(([key, value]) => {
        effective[key] = clone(value);
        provenance[key] = sourceProvenance(qube, qubeId, result.chain.indexOf(qube));
      });
    });
    const firewall = resolveEffectiveFirewall(fixture, result.chain, result.diagnostics);
    return {
      qubeId,
      chain: result.chain,
      diagnostics: result.diagnostics,
      resolved: result.resolved,
      depth: result.chain.length - 1,
      values: effective,
      provenance,
      firewall,
    };
  }

  function normalizePolicy(policy) {
    const value = policy || {};
    return {
      default: value.default === 'allow' ? 'allow' : 'deny',
      hasDefault: value.default === 'allow' || value.default === 'deny',
      rules: Array.isArray(value.rules) ? value.rules : [],
      mode: value.mode === 'append' ? 'append' : 'replace',
    };
  }

  function sourceProvenance(qube, selectedId, depth) {
    return {
      qubeId: qube.id,
      qubeName: qube.name,
      depth,
      inherited: qube.id !== selectedId,
    };
  }

  function resolveEffectiveFirewall(fixtureSource, chainSource, resolutionDiagnostics) {
    const fixture = normalizeFixture(fixtureSource);
    const chain = Array.isArray(chainSource) ? chainSource : (chainSource && chainSource.chain) || [];
    const selectedId = chain[0]?.id || null;
    const diagnostics = resolutionDiagnostics || (chainSource && chainSource.diagnostics) || (selectedId ? resolveTemplateChain(fixture, selectedId).diagnostics : []);
    let effective = null;
    const sources = [];
    // chain is selected -> root; policies are layered root -> selected.
    chain.slice().reverse().forEach((qube) => {
      if (!qube.firewall) return;
      const policy = normalizePolicy(qube.firewall);
      const depth = chain.indexOf(qube);
      if (!effective) {
        effective = {
          default: 'deny',
          rules: [],
          sourceId: qube.id,
          sourceName: qube.name,
          defaultSource: sourceProvenance(qube, selectedId, depth),
        };
      }
      if (policy.hasDefault) {
        effective.default = policy.default;
        effective.defaultSource = sourceProvenance(qube, selectedId, depth);
      }
      const introducedRules = policy.rules.map((rule) => ({
        ...clone(rule),
        _sourceId: qube.id,
        _sourceName: qube.name,
        _inherited: qube.id !== selectedId,
        _depth: depth,
      }));
      if (policy.mode === 'append') {
        effective.rules = effective.rules.concat(introducedRules);
      } else {
        effective.rules = introducedRules;
      }
      effective.sourceId = qube.id;
      effective.sourceName = qube.name;
      sources.push({ qubeId: qube.id, qubeName: qube.name, mode: policy.mode, ruleCount: policy.rules.length });
    });
    if (!effective) {
      return {
        available: false,
        resolved: chain.length > 0 && diagnostics.length === 0,
        default: null,
        defaultSource: null,
        rules: [],
        sources: [],
      };
    }
    effective.rules = effective.rules.map((rule, index) => ({ ...rule, _index: index }));
    effective.sources = sources;
    effective.available = true;
    effective.resolved = chain.length > 0 && diagnostics.length === 0;
    return effective;
  }

  function parseIPv4(value) {
    const parts = String(value || '').split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
    return parts.reduce((result, part) => result * 256 + Number(part), 0);
  }

  function expandIPv6(value) {
    let text = String(value || '').toLowerCase();
    if (text.includes('.')) {
      const lastColon = text.lastIndexOf(':');
      const ipv4 = parseIPv4(text.slice(lastColon + 1));
      if (ipv4 === null) return null;
      text = `${text.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
    }
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
    if (left.concat(right).some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
    return left.concat(Array(Math.max(0, missing)).fill('0'), right).map((part) => parseInt(part || '0', 16));
  }

  function parseCidr(value) {
    const [ip, rawPrefix] = String(value || '').split('/');
    const prefix = Number(rawPrefix);
    const ipv4 = parseIPv4(ip);
    if (ipv4 !== null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) return { family: 4, ip: ipv4, prefix };
    const ipv6 = expandIPv6(ip);
    if (ipv6 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) return { family: 6, ip: ipv6, prefix };
    return null;
  }

  function ipInCidr(ip, cidr) {
    if (!cidr || cidr === 'any' || cidr === '*') return true;
    const network = parseCidr(cidr.includes('/') ? cidr : `${cidr}/${String(ip).includes(':') ? 128 : 32}`);
    if (!network) return false;
    const parsed = String(ip).includes(':') ? expandIPv6(ip) : parseIPv4(ip);
    const family = Array.isArray(parsed) ? 6 : parsed === null ? null : 4;
    if (family !== network.family) return false;
    if (family === 4) {
      const mask = network.prefix === 0 ? 0 : (0xffffffff << (32 - network.prefix)) >>> 0;
      return ((parsed >>> 0) & mask) === ((network.ip >>> 0) & mask);
    }
    let remaining = network.prefix;
    for (let i = 0; i < 8; i += 1) {
      const bits = Math.min(16, Math.max(0, remaining));
      if (bits && (parsed[i] >>> (16 - bits)) !== (network.ip[i] >>> (16 - bits))) return false;
      remaining -= bits;
      if (remaining <= 0) break;
    }
    return true;
  }

  function protocolMatches(rule, protocol) {
    if (!rule.protocol || rule.protocol === 'any' || rule.protocol === '*') return true;
    return String(rule.protocol).toLowerCase() === String(protocol || '').toLowerCase();
  }

  function portMatches(rule, port) {
    if (rule.port === undefined || rule.port === null || rule.port === 'any' || rule.port === '*') return true;
    const candidate = Number(port);
    if (!Number.isInteger(candidate)) return false;
    if (typeof rule.port === 'number') return rule.port === candidate;
    const text = String(rule.port);
    if (text.includes('-')) {
      const [start, end] = text.split('-').map(Number);
      return candidate >= start && candidate <= end;
    }
    return Number(text) === candidate;
  }

  function ruleMatches(rule, request) {
    if (rule.enabled === false) return false;
    const family = request.family || (String(request.destinationIp || '').includes(':') ? 6 : 4);
    if (rule.family && rule.family !== 'any' && Number(rule.family) !== family) return false;
    if (!protocolMatches(rule, request.protocol)) return false;
    if (!ipInCidr(request.destinationIp, rule.destination || 'any')) return false;
    if (!ipInCidr(request.sourceIp || (family === 6 ? '::' : '0.0.0.0'), rule.source || 'any')) return false;
    return portMatches(rule, request.port);
  }

  function evaluateFirewall(policy, requestSource) {
    const request = { protocol: 'tcp', destinationIp: '0.0.0.0', sourceIp: '0.0.0.0', port: 0, ...requestSource };
    if (policy && policy.resolved === false) return { decision: 'none', reason: 'Firewall inheritance is unresolved; available values and rules are provisional.', matchedRule: null, trace: [] };
    if (!policy || !policy.available) return { decision: 'none', reason: 'No firewall policy available.', matchedRule: null, trace: [] };
    const defaultDecision = policy.default === 'allow' ? 'allow' : 'deny';
    const trace = [];
    for (const rule of policy.rules) {
      if (rule.enabled === false) {
        trace.push({ ruleId: rule.id, result: 'skipped', reason: 'disabled' });
        continue;
      }
      const validAction = rule.action === 'allow' || rule.action === 'deny';
      if (!validAction) {
        trace.push({ ruleId: rule.id, result: 'skipped', reason: 'invalid action' });
        continue;
      }
      const matched = ruleMatches(rule, request);
      trace.push({ ruleId: rule.id, result: matched ? 'matched' : 'miss', reason: matched ? 'all fields matched' : 'request did not match' });
      if (matched) return { decision: rule.action, reason: `${rule.action === 'allow' ? 'Allowed' : 'Denied'} by ${rule._sourceName || 'explicit'} rule ${rule.id || (rule._index === undefined ? '(unnamed)' : rule._index + 1)}.`, matchedRule: rule, trace, policySource: rule._sourceName || policy.sourceName };
    }
    return { decision: defaultDecision, reason: `${defaultDecision === 'allow' ? 'Allowed' : 'Denied'} by default policy.`, matchedRule: null, trace, policySource: policy.defaultSource?.qubeName || policy.sourceName };
  }

  // Fixture simulation only: template links inherit config/firewall, never routes.
  // A template's network links contribute neither routes nor firewall policy.
  // Each routing hop uses its own template chain and sees the same request; no
  // NAT, routing-table lookup, or real Qubes transit-firewall semantics are modeled.
  function evaluateNetworkPath(fixtureSource, qubeId, requestSource) {
    const fixture = normalizeFixture(fixtureSource);
    const network = resolveNetworkPath(fixture, qubeId);
    const diagnostics = network.diagnostics.slice();
    const request = clone(requestSource || {});
    const steps = [];
    let decision = 'allow';
    let reason = 'Source firewall and every reachable NetVM policy allow this request (explicit pass-through where no transit policy is supplied).';
    let blockingHopId = null;

    network.path.forEach((qube, index) => {
      if (blockingHopId !== null) {
        steps.push({
          qubeId: qube.id,
          qubeName: qube.name,
          status: 'unreachable',
          decision: 'none',
          reason: `Unreachable after ${blockingHopId}: ${reason}`,
          matchedRule: null,
          trace: [],
        });
        return;
      }

      let status = 'evaluated';
      let result;
      if (index > 0 && !qube.providesNetwork) {
        const previous = network.path[index - 1];
        const message = `${previous.name} selects ${qube.name} as a NetVM, but it does not provide network service.`;
        diagnostics.push(edgeDiagnostic('NON_NETWORK_PROVIDER', 'high', qubeId, message, previous.id, qube.id, 'netvm'));
        result = { decision: 'none', reason: message, matchedRule: null, trace: [] };
      } else {
        const effective = resolveEffectiveConfig(fixture, qube.id);
        diagnostics.push(...effective.diagnostics);
        result = evaluateFirewall(effective.firewall, request);
        if (index > 0 && effective.firewall.resolved && !effective.firewall.available) {
          status = 'pass-through';
          result = { decision: 'allow', reason: 'Explicit fixture pass-through: network provider has no transit firewall policy.', matchedRule: null, trace: [] };
        }
        // Unknown source policy remains inconclusive. Otherwise a disconnected
        // non-provider is offline; a terminal provider represents the uplink.
        if (index === 0 && !qube.netvmId && !qube.providesNetwork && result.decision !== 'none') {
          result = { ...result, decision: 'deny', reason: 'Offline: source qube has no NetVM and does not provide an uplink.' };
        }
      }

      const routeProblem = network.diagnostics.find((diagnostic) => diagnostic.from === qube.id);
      if (routeProblem) {
        status = 'evaluated';
        result = { ...result, decision: 'none', reason: `Routing is unresolved: ${routeProblem.message}` };
      }
      steps.push({
        qubeId: qube.id,
        qubeName: qube.name,
        status,
        decision: result.decision,
        reason: result.reason,
        matchedRule: result.matchedRule,
        trace: result.trace,
      });
      if (result.decision !== 'allow') {
        decision = result.decision;
        reason = `${qube.name} (${qube.id}): ${result.reason}`;
        blockingHopId = qube.id;
      }
    });

    if (!network.path.length) {
      decision = 'none';
      reason = `Source qube ${qubeId} does not exist; routing cannot be evaluated.`;
      blockingHopId = qubeId;
    }
    return {
      decision,
      reason: `Fixture simulation: ${reason}`,
      path: network.path.map((qube) => qube.id),
      steps,
      blockingHopId,
      diagnostics,
    };
  }

  function analyzeQube(fixture, qube) {
    const effective = resolveEffectiveConfig(fixture, qube.id);
    const network = resolveNetworkPath(fixture, qube.id);
    const findings = [];
    effective.diagnostics.concat(network.diagnostics).forEach((diagnostic) => {
      findings.push({ ...diagnostic });
    });
    if (qube.policy.sensitive && network.path.length > 1 && network.path[1].type === 'NetVM' && network.path[1].id === 'sys-net') {
      findings.push({ code: 'DIRECT_NET', severity: 'high', message: 'Sensitive qube bypasses the intended sys-firewall boundary.' });
    }
    if (qube.policy.requireFirewall && !effective.firewall.available) {
      findings.push({ code: 'NO_FIREWALL', severity: 'high', message: 'Policy requires a firewall, but no effective policy is available.' });
    }
    const evaluations = (qube.policy.sampleRequests || []).map((sample, index) => {
      const id = sample.id ?? `sample-${index + 1}`;
      const label = sample.label || `Sample request ${index + 1}`;
      const scope = sample.scope === 'path' ? 'path' : 'firewall';
      const request = clone(sample.request || {});
      const expected = sample.expected ?? null;
      const localResult = evaluateFirewall(effective.firewall, request);
      const result = scope === 'path' ? evaluateNetworkPath(fixture, qube.id, request) : localResult;
      const matchesExpectation = expected === null || result.decision === expected;
      if (matchesExpectation === false) {
        let decisiveResult = result;
        let decisiveFirewall = effective.firewall;
        const blockingHopId = scope === 'path' ? result.blockingHopId : (result.decision === 'allow' ? null : qube.id);
        if (scope === 'path') {
          const hop = result.steps.find((step) => step.qubeId === blockingHopId) || result.steps.slice().reverse().find((step) => step.status === 'evaluated');
          if (hop) {
            decisiveResult = hop;
            decisiveFirewall = resolveEffectiveConfig(fixture, hop.qubeId).firewall;
          }
        }
        const matchedRule = decisiveResult.matchedRule;
        const ruleSourceId = matchedRule ? matchedRule._sourceId || null : (decisiveResult.decision !== 'none' ? decisiveFirewall.defaultSource?.qubeId || null : null);
        const evidence = { evaluationId: id, chainIds: effective.chain.map((entry) => entry.id), ruleSourceId, blockingHopId };
        const chainDescription = effective.chain.map((entry) => `${entry.name} (${entry.id})`).join(' → ') || '(unresolved source)';
        const blockingHop = blockingHopId ? fixture.qubes.find((entry) => entry.id === blockingHopId) : null;
        const hopDescription = blockingHopId ? `Blocking hop: ${blockingHop?.name || blockingHopId} (${blockingHopId}).` : 'No blocking hop; the request is allowed.';
        const ruleDescription = describeFirewallEvidence(decisiveResult, decisiveFirewall);
        const localDescription = scope === 'path' ? ` Source-only firewall: ${localResult.decision}. ${describeFirewallEvidence(localResult, effective.firewall)}` : '';
        findings.push({
          code: 'FIREWALL_MISMATCH',
          severity: 'medium',
          message: `${label} (${scope} scope) resolves to ${result.decision}, expected ${expected}. Selected-to-root template chain: ${chainDescription}. ${hopDescription} ${ruleDescription} ${result.reason}${localDescription}`,
          ...evidence,
          evidence,
        });
      }
      return { id, label, scope, request, expected, result, localResult, matchesExpectation };
    });
    return { qubeId: qube.id, effective, network, evaluations, findings, issueCount: findings.length };
  }

  function describeFirewallEvidence(result, firewall) {
    const rule = result.matchedRule;
    if (rule) return `Matched rule ${rule.id || (rule._index === undefined ? '(unnamed)' : rule._index + 1)}${rule.label ? ` (${rule.label})` : ''}, action ${rule.action}, from ${rule._sourceName || 'explicit policy'} (${rule._sourceId || 'unknown source'}), template depth ${rule._depth ?? 0}.`;
    if (result.decision === 'none') return 'No conclusive rule/default decision is available.';
    const source = firewall.defaultSource;
    if (!source) return 'No firewall rule or default source is available.';
    return `No rule matched; default ${firewall.default} comes from ${source.qubeName} (${source.qubeId}), template depth ${source.depth}.`;
  }

  function isCycleEdge(qubes, from, to, field) {
    const seen = new Set();
    let currentId = to;
    while (currentId && !seen.has(currentId)) {
      if (currentId === from) return true;
      seen.add(currentId);
      const current = qubes.get(currentId);
      if (!current) break;
      currentId = current[field];
    }
    return false;
  }

  function analyzeFixture(source) {
    const fixture = normalizeFixture(source);
    const qubes = byId(fixture);
    const qubeReports = fixture.qubes.map((qube) => analyzeQube(fixture, qube));
    const reports = new Map(qubeReports.map((report) => [report.qubeId, report]));
    const edges = [];
    fixture.qubes.forEach((qube) => {
      [['template', 'templateId'], ['netvm', 'netvmId']].forEach(([type, field]) => {
        const to = qube[field];
        if (!to) return;
        const broken = !qubes.has(to);
        const cycle = !broken && isCycleEdge(qubes, qube.id, to, field);
        const violationCodes = [];
        if (broken) violationCodes.push(type === 'template' ? 'MISSING_TEMPLATE' : 'MISSING_NETVM');
        if (cycle) violationCodes.push(type === 'template' ? 'TEMPLATE_CYCLE' : 'NETVM_CYCLE');
        if (type === 'netvm' && reports.get(qube.id).findings.some((finding) => finding.code === 'DIRECT_NET')) violationCodes.push('DIRECT_NET');
        edges.push({ from: qube.id, to, type, broken, cycle, violationCodes });
      });
    });
    const issueCount = qubeReports.reduce((sum, report) => sum + report.issueCount, 0);
    return {
      fixture,
      reports: qubeReports,
      reportById: reports,
      edges,
      summary: {
        qubes: fixture.qubes.length,
        appvms: fixture.qubes.filter((qube) => qube.type === 'AppVM').length,
        templates: fixture.qubes.filter((qube) => qube.type === 'TemplateVM').length,
        netvms: fixture.qubes.filter((qube) => qube.type === 'NetVM').length,
        violations: issueCount,
        affected: qubeReports.filter((report) => report.issueCount > 0).length,
      },
    };
  }

  return { normalizeFixture, resolveTemplateChain, resolveNetworkPath, resolveEffectiveConfig, resolveEffectiveFirewall, evaluateFirewall, evaluateNetworkPath, ruleMatches, analyzeFixture, ipInCidr };
}));
