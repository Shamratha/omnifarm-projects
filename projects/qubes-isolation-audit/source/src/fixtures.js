(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuditFixtures = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const baseFirewall = {
    default: 'deny',
    rules: [
      { id: 'allow-dns', label: 'DNS resolver', action: 'allow', protocol: 'udp', destination: '10.139.1.1/32', port: 53, family: 4 },
      { id: 'allow-updates', label: 'Package updates', action: 'allow', protocol: 'tcp', destination: '198.51.100.0/24', port: '80-443', family: 4 },
      { id: 'block-metadata', label: 'Metadata endpoint', action: 'deny', protocol: 'tcp', destination: '169.254.169.254/32', port: 80, family: 4 },
    ],
  };

  const fixtures = {
    'baseline-01': {
      id: 'baseline-01', name: 'Baseline / boundary review', version: '2026.10.01', description: 'A compact workstation with a deliberate firewall boundary and one flagged direct path.',
      qubes: [
        { id: 'work', name: 'work', type: 'AppVM', label: { name: 'orange', color: '#f2a164' }, trustDomain: 'work', tags: ['daily', 'sensitive'], templateId: 'work-template', netvmId: 'sys-firewall', config: { kernel: 'default', memory: '4096 MiB', autostart: true }, firewall: { ...baseFirewall, rules: [...baseFirewall.rules, { id: 'allow-git', label: 'Source control', action: 'allow', protocol: 'tcp', destination: '203.0.113.0/24', port: 22, family: 4 }] }, policy: { sensitive: true, requireFirewall: true, sampleRequests: [{ label: 'Git over SSH', scope: 'path', request: { protocol: 'tcp', destinationIp: '203.0.113.20', port: 22 }, expected: 'allow' }] }, position: { x: 118, y: 83 } },
        { id: 'personal', name: 'personal', type: 'AppVM', label: { name: 'yellow', color: '#d9d36e' }, trustDomain: 'personal', tags: ['browsing'], templateId: 'fedora-40', netvmId: 'sys-firewall', config: { memory: '2048 MiB' }, firewall: { default: 'allow', rules: [{ id: 'block-private', label: 'Private ranges', action: 'deny', protocol: 'any', destination: '10.0.0.0/8', family: 4 }] }, policy: { requireFirewall: true }, position: { x: 118, y: 202 } },
        { id: 'vault', name: 'vault', type: 'AppVM', label: { name: 'red', color: '#f27e7e' }, trustDomain: 'vault', tags: ['sensitive', 'direct-net'], templateId: 'fedora-40', netvmId: 'sys-net', config: { memory: '4096 MiB', autostart: false }, firewall: null, policy: { sensitive: true, requireFirewall: true }, position: { x: 118, y: 321 } },
        { id: 'work-template', name: 'work-template', type: 'TemplateVM', label: { name: 'orange', color: '#f2a164' }, trustDomain: 'work', templateId: 'fedora-40', netvmId: null, config: { kernel: '6.8.9-xen', updateChannel: 'internal' }, firewall: { default: 'deny', rules: [{ id: 'template-dns', label: 'Template DNS', action: 'allow', protocol: 'udp', destination: '10.139.1.1/32', port: 53, family: 4 }] }, position: { x: 396, y: 83 } },
        { id: 'fedora-40', name: 'fedora-40', type: 'TemplateVM', label: { name: 'purple', color: '#bb9cf1' }, trustDomain: 'base-os', tags: ['immutable'], config: { kernel: '6.8.7-xen', updateChannel: 'fedora-upstream' }, firewall: { default: 'deny', rules: [{ id: 'base-block', label: 'Deny by default', action: 'deny', protocol: 'any', destination: 'any', family: 'any' }] }, position: { x: 685, y: 83 } },
        { id: 'sys-firewall', name: 'sys-firewall', type: 'NetVM', label: { name: 'green', color: '#69d6ca' }, trustDomain: 'network', netvmId: 'sys-net', providesNetwork: true, config: { backend: 'iptables', dns: '10.139.1.1' }, position: { x: 396, y: 249 } },
        { id: 'sys-net', name: 'sys-net', type: 'NetVM', label: { name: 'blue', color: '#69d6ca' }, trustDomain: 'network-edge', providesNetwork: true, config: { backend: 'ethernet', device: 'enp3s0' }, position: { x: 685, y: 249 } },
      ],
    },
    'deep-inheritance': {
      id: 'deep-inheritance', name: 'Deep inheritance / policy drift', version: '2026.10.02', description: 'Multi-level template and appended firewall policy used to audit transitive inheritance.',
      qubes: [
        { id: 'project', name: 'project', type: 'AppVM', label: { name: 'orange', color: '#f2a164' }, trustDomain: 'project', templateId: 'project-template', netvmId: 'sys-firewall', config: { memory: '6144 MiB', updateChannel: 'project-pinned' }, firewall: { mode: 'append', default: 'deny', rules: [{ id: 'project-api', label: 'Project API', action: 'allow', protocol: 'tcp', destination: '198.51.100.0/24', port: 8443, family: 4 }] }, policy: { requireFirewall: true, sampleRequests: [{ label: 'Project API', request: { protocol: 'tcp', destinationIp: '198.51.100.45', port: 8443 }, expected: 'allow' }, { label: 'Public web', request: { protocol: 'tcp', destinationIp: '192.0.2.20', port: 443 }, expected: 'deny' }] }, position: { x: 107, y: 142 } },
        { id: 'project-template', name: 'project-template', type: 'TemplateVM', label: { name: 'purple', color: '#bb9cf1' }, trustDomain: 'project', templateId: 'fedora-base', config: { updateChannel: 'project-pinned', kernel: '6.8.9-xen' }, firewall: { mode: 'replace', default: 'deny', rules: [{ id: 'template-repo', label: 'Project repository', action: 'allow', protocol: 'tcp', destination: '198.51.100.0/24', port: 443, family: 4 }] }, position: { x: 405, y: 83 } },
        { id: 'fedora-base', name: 'fedora-base', type: 'TemplateVM', label: { name: 'purple', color: '#bb9cf1' }, trustDomain: 'base-os', config: { kernel: '6.8.7-xen', updateChannel: 'fedora-upstream', memory: '2048 MiB' }, firewall: { default: 'deny', rules: [{ id: 'base-dns', label: 'Base DNS', action: 'allow', protocol: 'udp', destination: '10.139.1.1/32', port: 53, family: 4 }] }, position: { x: 700, y: 83 } },
        { id: 'sys-firewall', name: 'sys-firewall', type: 'NetVM', label: { name: 'green', color: '#69d6ca' }, trustDomain: 'network', netvmId: 'sys-net', providesNetwork: true, config: { backend: 'iptables' }, position: { x: 405, y: 268 } },
        { id: 'sys-net', name: 'sys-net', type: 'NetVM', label: { name: 'blue', color: '#69d6ca' }, trustDomain: 'network-edge', providesNetwork: true, config: { backend: 'ethernet' }, position: { x: 700, y: 268 } },
        { id: 'docs', name: 'docs', type: 'AppVM', label: { name: 'yellow', color: '#d9d36e' }, trustDomain: 'documents', templateId: 'project-template', netvmId: 'sys-firewall', config: { memory: '3072 MiB' }, firewall: null, policy: { requireFirewall: true }, position: { x: 107, y: 261 } },
      ],
    },
    'blocked-path': {
      id: 'blocked-path', name: 'Blocked path / inherited allow', version: '2026.10.04',
      description: 'Fixture simulation: a two-level inherited HTTPS allow is blocked for one destination by the intermediate NetVM; the request is unchanged at each hop.',
      qubes: [
        {
          id: 'work', name: 'work', type: 'AppVM', label: { name: 'orange', color: '#f2a164' },
          trustDomain: 'work', tags: ['sensitive', 'inherited-policy'], templateId: 'work-template', netvmId: 'sys-firewall',
          config: { memory: '4096 MiB' },
          firewall: {
            mode: 'append',
            rules: [{ id: 'work-dns', label: 'Work DNS resolver', action: 'allow', protocol: 'udp', destination: '10.139.1.1/32', port: 53, family: 4 }],
          },
          policy: {
            sensitive: true, requireFirewall: true,
            sampleRequests: [
              { id: 'blocked-https', label: 'Blocked HTTPS destination', scope: 'path', request: { protocol: 'tcp', destinationIp: '203.0.113.20', port: 443, family: 4 }, expected: 'allow' },
              { id: 'allowed-https', label: 'Allowed HTTPS destination', scope: 'path', request: { protocol: 'tcp', destinationIp: '203.0.113.21', port: 443, family: 4 }, expected: 'allow' },
            ],
          },
          position: { x: 70, y: 166 },
        },
        {
          id: 'work-template', name: 'work-template', type: 'TemplateVM', label: { name: 'purple', color: '#bb9cf1' },
          trustDomain: 'work', templateId: 'fedora-base', config: { updateChannel: 'work-pinned' },
          firewall: {
            mode: 'append',
            rules: [{ id: 'template-api', label: 'Internal template API', action: 'allow', protocol: 'tcp', destination: '198.51.100.0/24', port: 8443, family: 4 }],
          },
          position: { x: 360, y: 64 },
        },
        {
          id: 'fedora-base', name: 'fedora-base', type: 'TemplateVM', label: { name: 'purple', color: '#bb9cf1' },
          trustDomain: 'base-os', tags: ['immutable'], config: { kernel: '6.8.9-xen', updateChannel: 'fedora-upstream', memory: '2048 MiB' },
          firewall: {
            default: 'allow',
            rules: [{ id: 'root-https', label: 'Inherited public HTTPS', action: 'allow', protocol: 'tcp', destination: '203.0.113.0/24', port: 443, family: 4 }],
          },
          position: { x: 660, y: 64 },
        },
        {
          id: 'sys-firewall', name: 'sys-firewall', type: 'NetVM', label: { name: 'green', color: '#69d6ca' },
          trustDomain: 'network', netvmId: 'sys-net', providesNetwork: true, config: { backend: 'fixture-firewall' },
          firewall: {
            default: 'allow',
            rules: [{ id: 'deny-https-destination', label: 'Blocked public HTTPS endpoint', action: 'deny', protocol: 'tcp', destination: '203.0.113.20/32', port: 443, family: 4 }],
          },
          position: { x: 360, y: 268 },
        },
        {
          id: 'sys-net', name: 'sys-net', type: 'NetVM', label: { name: 'blue', color: '#69d6ca' },
          trustDomain: 'network-edge', providesNetwork: true, config: { backend: 'fixture-uplink' },
          firewall: {
            default: 'deny',
            rules: [{ id: 'uplink-https', label: 'Upstream public HTTPS', action: 'allow', protocol: 'tcp', destination: '203.0.113.0/24', port: 443, family: 4 }],
          },
          position: { x: 660, y: 268 },
        },
      ],
    },
    'edge-cases': {
      id: 'edge-cases', name: 'Edge cases / broken references', version: '2026.10.03', description: 'Deliberately broken relationships, cycles, disabled rules, IPv6, and absent policy.',
      qubes: [
        { id: 'cycle-a', name: 'cycle-a', type: 'AppVM', label: { name: 'red', color: '#f27e7e' }, trustDomain: 'unknown', templateId: 'cycle-b', netvmId: 'missing-net', config: {}, policy: { requireFirewall: true }, position: { x: 120, y: 90 } },
        { id: 'cycle-b', name: 'cycle-b', type: 'TemplateVM', label: { name: 'red', color: '#f27e7e' }, trustDomain: 'unknown', templateId: 'cycle-a', config: { kernel: 'unknown' }, position: { x: 410, y: 90 } },
        { id: 'ipv6', name: 'ipv6-lab', type: 'AppVM', label: { name: 'blue', color: '#69d6ca' }, trustDomain: 'lab', templateId: null, netvmId: null, config: { memory: '1024 MiB' }, firewall: { default: 'deny', rules: [{ id: 'disabled-v6', label: 'Old IPv6 allow', action: 'allow', protocol: 'tcp', destination: '2001:db8:1::/48', port: 443, family: 6, enabled: false }, { id: 'allow-v6', label: 'IPv6 lab service', action: 'allow', protocol: 'tcp', destination: '2001:db8:2::/48', port: '8000-8100', family: 6 }] }, policy: { sampleRequests: [{ label: 'IPv6 lab service', request: { protocol: 'tcp', destinationIp: '2001:db8:2::40', port: 8050, family: 6 }, expected: 'allow' }] }, position: { x: 120, y: 238 } },
        { id: 'open-net', name: 'open-net', type: 'StandaloneVM', label: { name: 'orange', color: '#f2a164' }, trustDomain: 'unclassified', config: { memory: '2048 MiB' }, firewall: { default: 'allow', rules: [{ id: 'block-admin', label: 'Admin endpoint', action: 'deny', protocol: 'tcp', destination: '192.0.2.0/24', port: '22-23', family: 4 }] }, position: { x: 410, y: 238 } },
        { id: 'empty-policy', name: 'empty-policy', type: 'AppVM', label: { name: 'yellow', color: '#d9d36e' }, trustDomain: 'sandbox', templateId: 'missing-template', config: {}, firewall: { default: 'deny', rules: [] }, policy: { requireFirewall: true }, position: { x: 700, y: 238 } },
      ],
    },
  };

  function list() { return Object.values(fixtures).map(({ id, name, description }) => ({ id, name, description })); }
  function get(id) { return fixtures[id] || fixtures['baseline-01']; }
  return { fixtures, list, get };
}));
