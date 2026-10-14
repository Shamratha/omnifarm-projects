const test = require('node:test');
const assert = require('node:assert/strict');
const { get } = require('../src/fixtures.js');
const {
  resolveTemplateChain,
  resolveEffectiveConfig,
  evaluateFirewall,
  analyzeFixture,
} = require('../src/audit-model.js');

test('resolves transitive template inheritance from app to root template', () => {
  const fixture = get('deep-inheritance');
  const chain = resolveTemplateChain(fixture, 'project');

  assert.deepEqual(chain.chain.map((qube) => qube.id), ['project', 'project-template', 'fedora-base']);
  assert.equal(chain.diagnostics.length, 0);

  const effective = resolveEffectiveConfig(fixture, 'project');
  assert.equal(effective.values.kernel, '6.8.9-xen');
  assert.equal(effective.provenance.kernel.qubeName, 'project-template');
  assert.equal(effective.values.updateChannel, 'project-pinned');
  assert.equal(effective.provenance.updateChannel.qubeName, 'project');
  assert.equal(effective.values.memory, '6144 MiB');
  assert.equal(effective.provenance.memory.qubeName, 'project');
  assert.deepEqual(effective.firewall.rules.map((rule) => rule.id), ['template-repo', 'project-api']);
  assert.deepEqual(effective.firewall.sources.map((source) => source.qubeName), ['fedora-base', 'project-template', 'project']);
});

test('reports a template cycle and missing references without hanging', () => {
  const fixture = get('edge-cases');
  const cycle = resolveTemplateChain(fixture, 'cycle-a');
  const missing = resolveTemplateChain(fixture, 'empty-policy');

  assert.deepEqual(cycle.chain.map((qube) => qube.id), ['cycle-a', 'cycle-b']);
  assert.equal(cycle.diagnostics[0].code, 'TEMPLATE_CYCLE');
  assert.equal(missing.diagnostics[0].code, 'MISSING_TEMPLATE');
});

test('uses first matching firewall rule and preserves evaluation trace', () => {
  const policy = {
    available: true,
    default: 'deny',
    sourceName: 'test-policy',
    rules: [
      { id: 'broad-deny', action: 'deny', protocol: 'tcp', destination: '203.0.113.0/24', port: '1-65535', family: 4 },
      { id: 'specific-allow', action: 'allow', protocol: 'tcp', destination: '203.0.113.20/32', port: 443, family: 4 },
    ],
  };

  const denied = evaluateFirewall(policy, { protocol: 'tcp', destinationIp: '203.0.113.20', port: 443 });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.matchedRule.id, 'broad-deny');
  assert.equal(denied.trace.length, 1);

  const fallback = evaluateFirewall({ ...policy, rules: policy.rules.slice(1) }, { protocol: 'tcp', destinationIp: '203.0.113.20', port: 443 });
  assert.equal(fallback.decision, 'allow');
  assert.equal(fallback.matchedRule.id, 'specific-allow');
});

test('handles disabled rules, port ranges, IPv6, and default policy', () => {
  const fixture = get('edge-cases');
  const policy = analyzeFixture(fixture).reportById.get('ipv6').effective.firewall;
  const ipv6 = evaluateFirewall(policy, { family: 6, protocol: 'tcp', destinationIp: '2001:db8:2::40', port: 8050 });
  const disabled = evaluateFirewall(policy, { family: 6, protocol: 'tcp', destinationIp: '2001:db8:1::40', port: 443 });
  const defaultDeny = evaluateFirewall(policy, { family: 4, protocol: 'tcp', destinationIp: '192.0.2.5', port: 443 });

  assert.equal(ipv6.decision, 'allow');
  assert.equal(ipv6.matchedRule.id, 'allow-v6');
  assert.equal(disabled.decision, 'deny');
  assert.equal(disabled.trace[0].reason, 'disabled');
  assert.equal(defaultDeny.decision, 'deny');
  assert.equal(defaultDeny.matchedRule, null);
});

test('fixture analysis exposes graph relationships and affected qubes', () => {
  const analysis = analyzeFixture(get('baseline-01'));
  assert.equal(analysis.summary.qubes, 7);
  assert.ok(analysis.edges.some((edge) => edge.from === 'work' && edge.to === 'work-template' && edge.type === 'template'));
  assert.ok(analysis.edges.some((edge) => edge.from === 'sys-firewall' && edge.to === 'sys-net' && edge.type === 'netvm'));
  assert.ok(analysis.reportById.get('vault').findings.some((finding) => finding.code === 'DIRECT_NET'));
});
