const test = require('node:test');
const assert = require('node:assert/strict');
const { get } = require('../src/fixtures.js');
const {
  resolveEffectiveConfig,
  evaluateFirewall,
  evaluateNetworkPath,
  analyzeFixture,
} = require('../src/audit-model.js');

const request = (overrides = {}) => ({
  family: 4,
  protocol: 'tcp',
  sourceIp: '192.0.2.10',
  destinationIp: '198.51.100.10',
  port: 443,
  ...overrides,
});

const rule = (id, action, overrides = {}) => ({
  id,
  action,
  protocol: 'tcp',
  destination: '198.51.100.0/24',
  port: 443,
  family: 4,
  ...overrides,
});

const firewall = ({ default: defaultPolicy, mode, rules = [] } = {}) => ({
  ...(defaultPolicy === undefined ? {} : { default: defaultPolicy }),
  ...(mode === undefined ? {} : { mode }),
  rules,
});

const qube = (id, options = {}) => ({
  id,
  name: id,
  type: 'AppVM',
  label: { name: 'gray', color: '#81939b' },
  trustDomain: 'test',
  tags: [],
  templateId: null,
  netvmId: null,
  config: {},
  firewall: null,
  policy: {},
  position: { x: 0, y: 0 },
  providesNetwork: false,
  ...options,
});

const fixture = (...qubes) => ({
  id: 'synthetic',
  name: 'Synthetic fixture',
  version: 'test',
  qubes,
});

const provider = (id, options = {}) => qube(id, {
  type: 'NetVM',
  providesNetwork: true,
  ...options,
});

test('resolves four-level config inheritance with relative provenance and rule source', () => {
  const data = fixture(
    qube('leaf', {
      name: 'Leaf application',
      templateId: 'template-1',
      config: { leafOnly: 'leaf', overridden: 'leaf' },
      netvmId: 'edge',
    }),
    qube('template-1', {
      type: 'TemplateVM',
      templateId: 'template-2',
      config: { firstAncestor: true, overridden: 'template-1' },
    }),
    qube('template-2', {
      type: 'TemplateVM',
      templateId: 'root-template',
      config: { secondAncestor: true, overridden: 'template-2' },
    }),
    qube('root-template', {
      name: 'Root base template',
      type: 'TemplateVM',
      config: { rootOnly: true, overridden: 'root' },
      firewall: firewall({
        default: 'deny',
        rules: [rule('root-allow', 'allow')],
      }),
    }),
    provider('edge', { firewall: firewall({ default: 'allow', rules: [] }) }),
  );

  const effective = resolveEffectiveConfig(data, 'leaf');

  assert.equal(effective.resolved, true);
  assert.equal(effective.depth, 3);
  assert.deepEqual(effective.chain.map((item) => item.id), [
    'leaf',
    'template-1',
    'template-2',
    'root-template',
  ]);
  assert.equal(effective.values.overridden, 'leaf');
  assert.deepEqual(effective.provenance.overridden, {
    qubeId: 'leaf',
    qubeName: 'Leaf application',
    inherited: false,
    depth: 0,
  });
  assert.deepEqual(effective.provenance.firstAncestor, {
    qubeId: 'template-1',
    qubeName: 'template-1',
    inherited: true,
    depth: 1,
  });
  assert.deepEqual(effective.provenance.secondAncestor, {
    qubeId: 'template-2',
    qubeName: 'template-2',
    inherited: true,
    depth: 2,
  });
  assert.deepEqual(effective.provenance.rootOnly, {
    qubeId: 'root-template',
    qubeName: 'Root base template',
    inherited: true,
    depth: 3,
  });
  const inheritedRule = effective.firewall.rules[0];
  assert.equal(inheritedRule.id, 'root-allow');
  assert.deepEqual({
    _sourceId: inheritedRule._sourceId,
    _sourceName: inheritedRule._sourceName,
    _inherited: inheritedRule._inherited,
    _depth: inheritedRule._depth,
  }, {
    _sourceId: 'root-template',
    _sourceName: 'Root base template',
    _inherited: true,
    _depth: 3,
  });

  const selectedAncestor = resolveEffectiveConfig(data, 'template-2');
  assert.equal(selectedAncestor.depth, 1);
  assert.equal(selectedAncestor.provenance.secondAncestor.depth, 0);
  assert.equal(selectedAncestor.provenance.secondAncestor.inherited, false);
  assert.equal(selectedAncestor.provenance.rootOnly.depth, 1);
  assert.equal(selectedAncestor.firewall.rules[0]._depth, 1);
});

test('inherits the nearest explicit ancestor default when a child omits default', () => {
  const data = fixture(
    qube('leaf', {
      templateId: 'parent',
      firewall: firewall({ mode: 'replace', rules: [] }),
    }),
    qube('parent', {
      type: 'TemplateVM',
      templateId: 'nearest',
      firewall: firewall({ mode: 'replace', rules: [] }),
    }),
    qube('nearest', {
      type: 'TemplateVM',
      templateId: 'root',
      firewall: firewall({ default: 'allow', rules: [] }),
    }),
    qube('root', {
      type: 'TemplateVM',
      firewall: firewall({ default: 'deny', rules: [] }),
    }),
  );

  const effective = resolveEffectiveConfig(data, 'leaf');

  assert.equal(effective.firewall.default, 'allow');
  assert.equal(evaluateFirewall(effective.firewall, request()).decision, 'allow');
  assert.deepEqual(effective.firewall.defaultSource, {
    qubeId: 'nearest',
    qubeName: 'nearest',
    depth: 2,
    inherited: true,
  });
});

test('preserves ancestor rule provenance for append and discards it for replace', () => {
  const appended = fixture(
    qube('leaf', {
      templateId: 'middle',
      firewall: firewall({ mode: 'append', rules: [rule('leaf-allow', 'allow')] }),
    }),
    qube('middle', {
      type: 'TemplateVM',
      templateId: 'root',
      firewall: firewall({ mode: 'append', rules: [rule('middle-allow', 'allow')] }),
    }),
    qube('root', {
      type: 'TemplateVM',
      firewall: firewall({
        default: 'deny',
        rules: [rule('ancestor-deny', 'deny')],
      }),
    }),
  );
  const appendedEffective = resolveEffectiveConfig(appended, 'leaf');

  assert.deepEqual(appendedEffective.firewall.rules.map((item) => item.id), [
    'ancestor-deny',
    'middle-allow',
    'leaf-allow',
  ]);
  assert.deepEqual(appendedEffective.firewall.rules.map((item) => ({
    id: item.id,
    source: item._sourceId,
    inherited: item._inherited,
    depth: item._depth,
  })), [
    { id: 'ancestor-deny', source: 'root', inherited: true, depth: 2 },
    { id: 'middle-allow', source: 'middle', inherited: true, depth: 1 },
    { id: 'leaf-allow', source: 'leaf', inherited: false, depth: 0 },
  ]);
  const firstMatch = evaluateFirewall(appendedEffective.firewall, request());
  assert.equal(firstMatch.decision, 'deny');
  assert.equal(firstMatch.matchedRule.id, 'ancestor-deny');
  assert.equal(firstMatch.matchedRule._sourceId, 'root');
  assert.deepEqual(firstMatch.trace.map((entry) => entry.ruleId), ['ancestor-deny']);

  const replaced = fixture(
    qube('leaf', {
      templateId: 'middle',
      firewall: firewall({ mode: 'replace', rules: [rule('leaf-only', 'allow')] }),
    }),
    qube('middle', {
      type: 'TemplateVM',
      templateId: 'root',
      firewall: firewall({ mode: 'append', rules: [rule('middle-only', 'deny')] }),
    }),
    qube('root', {
      type: 'TemplateVM',
      firewall: firewall({ default: 'deny', rules: [rule('root-only', 'deny')] }),
    }),
  );

  const replacedEffective = resolveEffectiveConfig(replaced, 'leaf');
  assert.deepEqual(replacedEffective.firewall.rules.map((item) => item.id), ['leaf-only']);
  assert.equal(replacedEffective.firewall.rules[0]._sourceId, 'leaf');
  assert.equal(replacedEffective.firewall.rules[0]._inherited, false);
});

test('returns none for an explicitly unresolved firewall policy', () => {
  const result = evaluateFirewall({
    available: true,
    resolved: false,
    default: 'allow',
    rules: [rule('would-allow', 'allow')],
  }, request());

  assert.equal(result.decision, 'none');
  assert.equal(result.matchedRule, null);
  assert.deepEqual(result.trace, []);
});

test('evaluates every hop so an intermediate deny blocks an allowed source', () => {
  const data = fixture(
    qube('app', {
      netvmId: 'relay',
      firewall: firewall({ default: 'deny', rules: [rule('app-allow', 'allow')] }),
    }),
    provider('relay', {
      netvmId: 'edge',
      firewall: firewall({ default: 'deny', rules: [rule('relay-deny', 'deny')] }),
    }),
    provider('edge', {
      firewall: firewall({ default: 'deny', rules: [rule('edge-allow', 'allow')] }),
    }),
  );

  const result = evaluateNetworkPath(data, 'app', request());

  assert.equal(result.decision, 'deny');
  assert.equal(result.blockingHopId, 'relay');
  assert.deepEqual(result.path, ['app', 'relay', 'edge']);
  assert.deepEqual(result.steps.map((step) => [step.qubeId, step.status, step.decision]), [
    ['app', 'evaluated', 'allow'],
    ['relay', 'evaluated', 'deny'],
    ['edge', 'unreachable', 'none'],
  ]);
  assert.equal(result.steps[1].matchedRule.id, 'relay-deny');
  assert.ok(result.steps[1].trace.length > 0);
  assert.equal(result.steps[2].matchedRule, null);
  assert.deepEqual(result.steps[2].trace, []);
});

test('allows a request only after each reachable hop permits it', () => {
  const data = fixture(
    qube('app', {
      netvmId: 'relay',
      firewall: firewall({ default: 'deny', rules: [rule('app-allow', 'allow')] }),
    }),
    provider('relay', {
      netvmId: 'edge',
      firewall: firewall({ default: 'deny', rules: [rule('relay-allow', 'allow')] }),
    }),
    provider('edge', {
      firewall: firewall({ default: 'deny', rules: [rule('edge-allow', 'allow')] }),
    }),
  );

  const result = evaluateNetworkPath(data, 'app', request());

  assert.equal(result.decision, 'allow');
  assert.equal(result.blockingHopId, null);
  assert.deepEqual(result.path, ['app', 'relay', 'edge']);
  assert.deepEqual(result.steps.map((step) => ({
    id: step.qubeId,
    name: step.qubeName,
    status: step.status,
    decision: step.decision,
    ruleId: step.matchedRule && step.matchedRule.id,
  })), [
    { id: 'app', name: 'app', status: 'evaluated', decision: 'allow', ruleId: 'app-allow' },
    { id: 'relay', name: 'relay', status: 'evaluated', decision: 'allow', ruleId: 'relay-allow' },
    { id: 'edge', name: 'edge', status: 'evaluated', decision: 'allow', ruleId: 'edge-allow' },
  ]);
  assert.ok(result.steps.every((step) => step.reason.length > 0 && step.trace.length > 0));
  assert.deepEqual(result.diagnostics, []);
});

test('allows missing transit policy only for a network provider, never for the source', () => {
  const data = fixture(
    qube('app', {
      netvmId: 'relay',
      firewall: firewall({ default: 'deny', rules: [rule('app-allow', 'allow')] }),
    }),
    provider('relay', { netvmId: 'edge', firewall: null }),
    provider('edge', {
      firewall: firewall({ default: 'deny', rules: [rule('edge-allow', 'allow')] }),
    }),
  );

  const transitResult = evaluateNetworkPath(data, 'app', request());
  assert.equal(transitResult.decision, 'allow');
  assert.deepEqual(transitResult.steps.map((step) => step.status), [
    'evaluated', 'pass-through', 'evaluated',
  ]);
  assert.equal(transitResult.steps[1].matchedRule, null);
  assert.deepEqual(transitResult.steps[1].trace, []);

  const sourceResult = evaluateNetworkPath(data, 'relay', request());
  assert.equal(sourceResult.decision, 'none');
  assert.notEqual(sourceResult.steps[0].status, 'pass-through');
  assert.equal(sourceResult.steps[0].decision, 'none');
});

test('an unresolved transit template chain is not treated as missing-policy pass-through', () => {
  const data = fixture(
    qube('app', {
      netvmId: 'relay',
      firewall: firewall({ default: 'allow', rules: [] }),
    }),
    provider('relay', { templateId: 'missing-template', netvmId: 'edge', firewall: null }),
    provider('edge', { firewall: firewall({ default: 'allow', rules: [] }) }),
  );

  const result = evaluateNetworkPath(data, 'app', request());
  assert.equal(result.decision, 'none');
  assert.equal(result.blockingHopId, 'relay');
  assert.equal(result.steps[0].decision, 'allow');
  assert.equal(result.steps[1].status, 'evaluated');
  assert.equal(result.steps[1].decision, 'none');
  assert.equal(result.steps[2].status, 'unreachable');
  assert.ok(result.diagnostics.some((item) => item.code === 'MISSING_TEMPLATE'));
});

test('denies an offline source despite an allowing local firewall', () => {
  const data = fixture(
    qube('offline-app', {
      netvmId: null,
      firewall: firewall({ default: 'deny', rules: [rule('local-allow', 'allow')] }),
    }),
  );

  const result = evaluateNetworkPath(data, 'offline-app', request());

  assert.equal(result.decision, 'deny');
  assert.equal(result.blockingHopId, 'offline-app');
  assert.deepEqual(result.path, ['offline-app']);
  assert.match(result.reason, /offline|no.*netvm|no.*network/i);
});

test('returns none when an allowed upstream route ends at an unreachable hop', () => {
  const data = fixture(
    qube('app', {
      netvmId: 'relay',
      firewall: firewall({ default: 'deny', rules: [rule('app-allow', 'allow')] }),
    }),
    provider('relay', {
      netvmId: 'missing-edge',
      firewall: firewall({ default: 'deny', rules: [rule('relay-allow', 'allow')] }),
    }),
  );

  const result = evaluateNetworkPath(data, 'app', request());

  assert.equal(result.decision, 'none');
  assert.ok(result.diagnostics.some((item) => item.code === 'MISSING_NETVM'));
  assert.deepEqual(result.path.slice(0, 2), ['app', 'relay']);
});

test('returns none for a nonprovider next hop instead of treating it as connectivity', () => {
  const data = fixture(
    qube('app', {
      netvmId: 'not-a-provider',
      firewall: firewall({ default: 'deny', rules: [rule('app-allow', 'allow')] }),
    }),
    qube('not-a-provider', {
      type: 'AppVM',
      providesNetwork: false,
      firewall: firewall({ default: 'deny', rules: [rule('wrong-hop-allow', 'allow')] }),
    }),
  );

  const result = evaluateNetworkPath(data, 'app', request());

  assert.equal(result.decision, 'none');
  assert.match(result.reason, /provider|network/i);

  const noPolicy = fixture(
    data.qubes[0],
    qube('not-a-provider', { providesNetwork: false, firewall: null }),
  );
  assert.equal(evaluateNetworkPath(noPolicy, 'app', request()).decision, 'none');
});

test('inherits firewall only through templates and follows only the AppVM NetVM route', () => {
  const data = fixture(
    qube('app', {
      templateId: 'app-template',
      firewall: null,
      netvmId: 'real-edge',
    }),
    qube('app-template', {
      type: 'TemplateVM',
      netvmId: 'template-edge',
      firewall: firewall({ default: 'deny', rules: [rule('template-allow', 'allow')] }),
    }),
    provider('template-edge', {
      firewall: firewall({ default: 'deny', rules: [rule('template-edge-allow', 'allow')] }),
    }),
    provider('real-edge', {
      firewall: firewall({ default: 'deny', rules: [rule('real-edge-allow', 'allow')] }),
    }),
  );

  const effective = resolveEffectiveConfig(data, 'app');
  const result = evaluateNetworkPath(data, 'app', request());

  assert.equal(effective.firewall.rules[0].id, 'template-allow');
  assert.deepEqual(result.path, ['app', 'real-edge']);
  assert.ok(!result.path.includes('template-edge'));
  assert.equal(result.decision, 'allow');
  assert.equal(result.steps[0].matchedRule.id, 'template-allow');
});

test('a template NetVM does not give an offline AppVM connectivity', () => {
  const data = fixture(
    qube('app', { templateId: 'app-template', netvmId: null }),
    qube('app-template', {
      type: 'TemplateVM',
      netvmId: 'edge',
      firewall: firewall({ default: 'allow', rules: [] }),
    }),
    provider('edge', { firewall: firewall({ default: 'allow', rules: [] }) }),
  );

  assert.equal(evaluateFirewall(resolveEffectiveConfig(data, 'app').firewall, request()).decision, 'allow');
  const result = evaluateNetworkPath(data, 'app', request());
  assert.equal(result.decision, 'deny');
  assert.deepEqual(result.path, ['app']);
});

test('an upstream allowing firewall does not supply a missing source firewall', () => {
  const data = fixture(
    qube('app', { netvmId: 'edge', firewall: null }),
    provider('edge', { firewall: firewall({ default: 'allow', rules: [] }) }),
  );

  assert.equal(resolveEffectiveConfig(data, 'app').firewall.available, false);
  const result = evaluateNetworkPath(data, 'app', request());
  assert.equal(result.decision, 'none');
  assert.equal(result.steps[0].decision, 'none');
  assert.equal(result.steps[0].matchedRule, null);
});

test('a cyclic route cannot be allowed even when every known hop allows', () => {
  const data = fixture(
    qube('app', {
      netvmId: 'relay',
      firewall: firewall({ default: 'allow', rules: [] }),
    }),
    provider('relay', {
      netvmId: 'edge',
      firewall: firewall({ default: 'allow', rules: [] }),
    }),
    provider('edge', {
      netvmId: 'relay',
      firewall: firewall({ default: 'allow', rules: [] }),
    }),
  );

  const result = evaluateNetworkPath(data, 'app', request());
  assert.equal(result.decision, 'none');
  assert.ok(result.diagnostics.some((item) => item.code === 'NETVM_CYCLE'));
  assert.deepEqual(result.path, ['app', 'relay', 'edge']);
});

test('missing and cyclic template policies cannot produce an allow decision', () => {
  const missing = fixture(
    qube('missing-app', {
      templateId: 'missing-template',
      netvmId: 'edge',
      firewall: firewall({ default: 'allow', rules: [rule('incomplete-allow', 'allow')] }),
    }),
    provider('edge', {
      firewall: firewall({ default: 'deny', rules: [rule('edge-allow', 'allow')] }),
    }),
  );
  const missingEffective = resolveEffectiveConfig(missing, 'missing-app');
  const missingResult = evaluateNetworkPath(missing, 'missing-app', request());

  assert.equal(missingEffective.resolved, false);
  assert.equal(missingResult.decision, 'none');
  assert.ok(missingResult.diagnostics.some((item) => item.code === 'MISSING_TEMPLATE'));

  const cyclic = fixture(
    qube('cyclic-app', {
      templateId: 'cycle-a',
      netvmId: 'edge',
      firewall: null,
    }),
    qube('cycle-a', {
      type: 'TemplateVM',
      templateId: 'cycle-b',
      firewall: firewall({ default: 'deny', rules: [rule('cycle-allow', 'allow')] }),
    }),
    qube('cycle-b', {
      type: 'TemplateVM',
      templateId: 'cycle-a',
    }),
    provider('edge', {
      firewall: firewall({ default: 'deny', rules: [rule('edge-allow', 'allow')] }),
    }),
  );
  const cyclicEffective = resolveEffectiveConfig(cyclic, 'cyclic-app');
  const cyclicResult = evaluateNetworkPath(cyclic, 'cyclic-app', request());

  assert.equal(cyclicEffective.resolved, false);
  assert.equal(cyclicResult.decision, 'none');
  assert.ok(cyclicResult.diagnostics.some((item) => item.code === 'TEMPLATE_CYCLE'));
});

test('matches an IPv6 source selector without confusing it with firewall provenance', () => {
  const data = fixture(
    qube('ipv6-app', {
      templateId: 'ipv6-template',
    }),
    qube('ipv6-template', {
      name: 'IPv6 template',
      type: 'TemplateVM',
      firewall: firewall({
        default: 'deny',
        rules: [{
          id: 'source-v6-allow',
          action: 'allow',
          protocol: 'tcp',
          source: '2001:db8:100::/64',
          destination: '2001:db8:200::/64',
          port: 443,
          family: 6,
        }],
      }),
    }),
  );
  const effective = resolveEffectiveConfig(data, 'ipv6-app');
  const policy = effective.firewall;
  const selected = evaluateFirewall(policy, {
    family: 6,
    protocol: 'tcp',
    sourceIp: '2001:db8:100::42',
    destinationIp: '2001:db8:200::42',
    port: 443,
  });
  const rejected = evaluateFirewall(policy, {
    family: 6,
    protocol: 'tcp',
    sourceIp: '2001:db8:101::42',
    destinationIp: '2001:db8:200::42',
    port: 443,
  });

  assert.equal(policy.rules[0].source, '2001:db8:100::/64');
  assert.equal(policy.rules[0]._sourceId, 'ipv6-template');
  assert.equal(policy.rules[0]._sourceName, 'IPv6 template');
  assert.equal(policy.rules[0]._inherited, true);
  assert.equal(policy.rules[0]._depth, 1);
  assert.equal(selected.decision, 'allow');
  assert.equal(selected.matchedRule.id, 'source-v6-allow');
  assert.equal(rejected.decision, 'deny');
});

function samplePathFixture() {
  return fixture(
    qube('app', {
      templateId: 'app-template',
      netvmId: 'relay',
      config: { memory: '1024 MiB' },
      firewall: firewall({ mode: 'append', rules: [rule('app-allow', 'allow')] }),
      policy: {
        sampleRequests: [
          {
            id: 'blocked-https',
            label: 'Locally allowed but blocked in transit',
            scope: 'path',
            request: request(),
            expected: 'allow',
          },
          {
            id: 'allowed-https',
            label: 'Allowed by every hop',
            scope: 'path',
            request: request({ destinationIp: '198.51.100.20' }),
            expected: 'allow',
          },
          {
            id: 'local-only',
            label: 'Default scope is local firewall',
            request: request(),
            expected: 'allow',
          },
        ],
      },
    }),
    provider('relay', {
      netvmId: 'edge',
      firewall: firewall({
        default: 'deny',
        rules: [
          rule('relay-deny', 'deny', { destination: '198.51.100.10/32' }),
          rule('relay-allow', 'allow'),
        ],
      }),
    }),
    provider('edge', {
      firewall: firewall({ default: 'deny', rules: [rule('edge-allow', 'allow')] }),
    }),
    qube('app-template', {
      type: 'TemplateVM',
      config: { services: { allowed: ['dns', 'https'] } },
      firewall: firewall({
        default: 'deny',
        rules: [rule('template-dns', 'allow', { protocol: 'udp', port: 53 })],
      }),
    }),
  );
}

test('analysis records sample scope, requests, local decisions, and path hop results', () => {
  const data = samplePathFixture();
  const report = analyzeFixture(data).reportById.get('app');

  assert.deepEqual(report.evaluations.map((evaluation) => evaluation.id), [
    'blocked-https', 'allowed-https', 'local-only',
  ]);
  const [blocked, allowed, local] = report.evaluations;
  assert.equal(blocked.label, 'Locally allowed but blocked in transit');
  assert.equal(blocked.scope, 'path');
  assert.deepEqual(blocked.request, data.qubes[0].policy.sampleRequests[0].request);
  assert.equal(blocked.expected, 'allow');
  assert.equal(blocked.localResult.decision, 'allow');
  assert.equal(blocked.result.decision, 'deny');
  assert.equal(blocked.matchesExpectation, false);
  assert.equal(blocked.result.blockingHopId, 'relay');
  assert.deepEqual(blocked.result.path, ['app', 'relay', 'edge']);
  assert.deepEqual(blocked.result.steps.map((step) => step.status), [
    'evaluated', 'evaluated', 'unreachable',
  ]);
  assert.equal(blocked.result.steps[1].matchedRule.id, 'relay-deny');

  assert.equal(allowed.scope, 'path');
  assert.equal(allowed.localResult.decision, 'allow');
  assert.equal(allowed.result.decision, 'allow');
  assert.equal(allowed.matchesExpectation, true);
  assert.equal(allowed.result.steps.length, 3);
  assert.ok(allowed.result.steps.every((step) => step.status === 'evaluated' && step.decision === 'allow'));

  assert.equal(local.scope, 'firewall');
  assert.equal(local.localResult.decision, 'allow');
  assert.equal(local.result.decision, 'allow');
  assert.equal(local.matchesExpectation, true);
});

test('a path mismatch finding links the sample to the blocking hop and rule evidence', () => {
  const report = analyzeFixture(samplePathFixture()).reportById.get('app');
  const finding = report.findings.find((item) => item.evaluationId === 'blocked-https');

  assert.ok(finding, 'the denied path must produce a finding linked to blocked-https');
  assert.ok(finding.evidence, 'the mismatch must include auditable blocking evidence');
  assert.equal(finding.evidence.blockingHopId, 'relay');
  assert.equal(finding.evidence.ruleSourceId, 'relay');
  assert.match(finding.message, /relay-deny/);
  assert.ok(!report.findings.some((item) => item.evaluationId === 'allowed-https'));
  assert.ok(!report.findings.some((item) => item.evaluationId === 'local-only'));
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('repeated analysis and path evaluation are deterministic and do not mutate input', () => {
  const data = samplePathFixture();
  const before = JSON.parse(JSON.stringify(data));
  const sample = request();
  const sampleBefore = { ...sample };
  deepFreeze(data);
  deepFreeze(sample);

  const first = analyzeFixture(data);
  const firstPath = evaluateNetworkPath(data, 'app', sample);
  const second = analyzeFixture(data);
  const secondPath = evaluateNetworkPath(data, 'app', sample);

  assert.deepEqual(second, first);
  assert.deepEqual(secondPath, firstPath);
  assert.deepEqual(data, before);
  assert.deepEqual(sample, sampleBefore);
  assert.equal(Object.hasOwn(data.qubes[0].firewall.rules[0], '_sourceId'), false);
  assert.equal(Object.hasOwn(data.qubes[0].policy.sampleRequests[0], 'result'), false);
});

test('graph edges identify missing references, cycle membership, and direct network violations', () => {
  const data = fixture(
    qube('missing-app', { templateId: 'absent-template', netvmId: 'absent-netvm' }),
    qube('template-a', { type: 'TemplateVM', templateId: 'template-b' }),
    qube('template-b', { type: 'TemplateVM', templateId: 'template-a' }),
    provider('route-a', { netvmId: 'route-b' }),
    provider('route-b', { netvmId: 'route-a' }),
    qube('cycle-feeder', { templateId: 'template-a', netvmId: 'route-a' }),
    qube('sensitive-app', { netvmId: 'sys-net', policy: { sensitive: true } }),
    provider('sys-net'),
    qube('ordinary-app', { netvmId: 'safe-relay' }),
    provider('safe-relay', { netvmId: 'sys-net' }),
  );
  const analysis = analyzeFixture(data);
  const edge = (from, to, type) => {
    const found = analysis.edges.find((item) => item.from === from && item.to === to && item.type === type);
    assert.ok(found, `missing ${type} graph edge ${from} -> ${to}`);
    return found;
  };

  const missingTemplate = edge('missing-app', 'absent-template', 'template');
  const missingNetvm = edge('missing-app', 'absent-netvm', 'netvm');
  assert.equal(missingTemplate.broken, true);
  assert.ok(missingTemplate.violationCodes.includes('MISSING_TEMPLATE'));
  assert.equal(missingNetvm.broken, true);
  assert.ok(missingNetvm.violationCodes.includes('MISSING_NETVM'));

  for (const [from, to] of [['template-a', 'template-b'], ['template-b', 'template-a']]) {
    const cycle = edge(from, to, 'template');
    assert.equal(cycle.cycle, true);
    assert.equal(cycle.broken, false);
    assert.ok(cycle.violationCodes.includes('TEMPLATE_CYCLE'));
  }
  for (const [from, to] of [['route-a', 'route-b'], ['route-b', 'route-a']]) {
    const cycle = edge(from, to, 'netvm');
    assert.equal(cycle.cycle, true);
    assert.equal(cycle.broken, false);
    assert.ok(cycle.violationCodes.includes('NETVM_CYCLE'));
  }
  assert.ok(edge('sensitive-app', 'sys-net', 'netvm').violationCodes.includes('DIRECT_NET'));
  assert.notEqual(edge('cycle-feeder', 'template-a', 'template').cycle, true);
  assert.notEqual(edge('cycle-feeder', 'route-a', 'netvm').cycle, true);
  const valid = edge('ordinary-app', 'safe-relay', 'netvm');
  assert.equal(valid.broken, false);
  assert.notEqual(valid.cycle, true);
  assert.deepEqual(valid.violationCodes, []);
});

test('blocked-path fixture reports a first-AppVM local allow, path deny, and allowed path', () => {
  const data = get('blocked-path');
  assert.equal(data.id, 'blocked-path', 'get must return the new fixture rather than its fallback');
  assert.equal(data.qubes[0].type, 'AppVM');
  const analysis = analyzeFixture(data);
  const report = analysis.reports[0];
  assert.equal(report.qubeId, data.qubes[0].id);
  assert.equal(report, analysis.reportById.get(report.qubeId));
  const blocked = report.evaluations.find((evaluation) => evaluation.id === 'blocked-https');
  const allowed = report.evaluations.find((evaluation) => evaluation.id === 'allowed-https');

  assert.ok(blocked, 'first AppVM must expose the blocked-https sample');
  assert.ok(allowed, 'first AppVM must expose the allowed-https sample');
  assert.equal(blocked.scope, 'path');
  assert.equal(blocked.localResult.decision, 'allow');
  assert.deepEqual(report.effective.chain.map((qube) => qube.id), ['work', 'work-template', 'fedora-base']);
  assert.equal(blocked.localResult.matchedRule.id, 'root-https');
  assert.equal(blocked.localResult.matchedRule._sourceId, 'fedora-base');
  assert.equal(blocked.localResult.matchedRule._depth, 2);
  assert.equal(blocked.result.decision, 'deny');
  assert.equal(blocked.result.blockingHopId, 'sys-firewall');
  assert.equal(blocked.result.steps[1].matchedRule.id, 'deny-https-destination');
  assert.equal(blocked.result.steps[2].status, 'unreachable');
  assert.equal(blocked.matchesExpectation, false);
  assert.ok(blocked.result.steps.some((step) => step.qubeId === blocked.result.blockingHopId && step.decision === 'deny'));
  assert.ok(report.findings.some((finding) => finding.evaluationId === blocked.id));
  assert.equal(allowed.scope, 'path');
  assert.equal(allowed.result.decision, 'allow');
  assert.equal(allowed.matchesExpectation, true);
  assert.ok(allowed.result.steps.length > 1);
  assert.ok(allowed.result.steps.every((step) => step.status !== 'unreachable' && step.decision !== 'deny'));
});
