// Shared synthetic input for the pure pass and actual browser UI; no live data.
export const productCatalog = [{
  id: 'synthetic-reporting', vendor: 'Synthetic Vendor', name: 'Reporting Server',
  aliases: [{ vendor: 'Synthetic Vendor', name: 'Legacy Reports' }],
}];

export const dependencyModules = [{
  id: 'synthetic/inventory', name: 'Synthetic inventory metadata',
  type: 'auxiliary', platform: 'multi',
}];

export const modules = [
  {
    id: 'synthetic/alias-one', name: 'Synthetic first review', type: 'auxiliary',
    platform: 'multi', severity: 'high', owner: 'Synthetic review team',
    description: 'Two advisories for one aliased product.',
    products: [{ vendor: 'Synthetic Vendor', name: 'Legacy Reports', versions: '< 2.0' }],
    advisories: [
      { id: 'SYN-SHARED', source: 'Synthetic feed A' },
      { id: 'SYN-SHARED', source: 'Synthetic feed B' },
      { id: 'SYN-SEPARATE', source: 'Synthetic feed C' },
    ],
    cves: [
      { id: 'SYN-CVE-A', advisoryId: 'SYN-SHARED', source: 'Synthetic vendor', cvss: 9.8 },
      { id: 'SYN-CVE-A', advisoryId: 'SYN-SHARED', source: 'Synthetic mirror', cvss: 8.1 },
      { id: 'SYN-CVE-B', advisoryId: 'SYN-SEPARATE', source: 'Synthetic vendor', cvss: 7.5 },
    ],
    evidence: [
      { advisoryId: 'SYN-SHARED', kind: 'advisory', label: 'Shared advisory evidence', source: 'Synthetic vendor', detail: 'First review only.', confidence: 90, date: '2026-10-14' },
      { advisoryId: 'SYN-SEPARATE', kind: 'advisory', label: 'Separate advisory evidence', source: 'Synthetic branch bulletin', detail: 'Separate issue, not proof for the shared advisory.', confidence: 90, date: '2026-10-14' },
    ],
    prerequisites: ['Network reachable'],
    patchStatus: {
      status: 'unavailable', eta: 'No ETA', note: 'Synthetic vendor confirms no published fix.',
      evidence: [{ source: 'Synthetic vendor', status: 'unavailable', confidence: 90, date: '2026-10-14', detail: 'No fix for this affected branch.' }],
    },
    dependencies: [
      { moduleId: 'synthetic/alias-two', relation: 'related review metadata' },
      { moduleId: 'synthetic/inventory', relation: 'shares inventory' },
      { moduleId: 'synthetic/missing', relation: 'unverified reference' },
    ],
  },
  {
    id: 'synthetic/alias-two', name: 'Synthetic second review', type: 'auxiliary',
    platform: 'multi', severity: 'high', owner: 'Synthetic second team',
    description: 'Same product, independent review and patch certainty.',
    products: [{ vendor: 'Synthetic Vendor', name: 'Reporting Server', versions: '2.x' }],
    advisories: [{ id: 'SYN-SHARED', source: 'Synthetic feed D' }],
    cves: [{ id: 'SYN-CVE-C', advisoryId: 'SYN-SHARED', source: 'Synthetic second bulletin', cvss: 6.5 }],
    evidence: [{ advisoryId: 'SYN-SHARED', kind: 'advisory', label: 'Second review evidence', source: 'Synthetic second bulletin', detail: 'Does not establish patch availability.', confidence: 90, date: '2026-10-14' }],
    prerequisites: ['Network reachable'],
    patchStatus: { status: 'unknown', eta: 'No ETA', note: 'No patch observation supplied for this branch.', evidence: [] },
    dependencies: [{ moduleId: 'synthetic/alias-one', relation: 'related review metadata' }],
  },
];
