import type { CustodyEvent, EvidenceRecord, FindingCode } from '../domain/evidence'

export interface TimelineItem {
  id: string
  time: string
  type: 'event' | 'note' | 'transfer' | 'alert' | 'duplicate' | 'contradiction'
  title: string
  detail: string
  source: string
  confidence: 'high' | 'medium' | 'low'
  evidenceId?: string
  findingCode?: FindingCode
}

export interface Entity {
  name: string
  kind: 'person' | 'asset' | 'place' | 'system'
  role: string
  initials: string
  tone: string
  links: number
}

export interface EvidenceCatalogEntry {
  evidenceId: string
  title: string
  filename: string
  path: string
  kind: 'event-log' | 'witness-note' | 'transfer' | 'observation'
}

const baseCustody = [
  { eventId: 'co-01', evidenceId: 'EV-1042', sequence: 1, action: 'collected' as const, fromPartyId: null, toPartyId: 'M. Ortiz', occurredAt: '2026-10-12T08:41:00Z', previousEventId: null },
  { eventId: 'co-02', evidenceId: 'EV-1042', sequence: 2, action: 'transferred' as const, fromPartyId: 'M. Ortiz', toPartyId: 'Evidence locker 03', occurredAt: '2026-10-12T09:05:00Z', previousEventId: 'co-01' },
  { eventId: 'co-03', evidenceId: 'EV-1042', sequence: 3, action: 'received' as const, fromPartyId: 'Evidence locker 03', toPartyId: 'A. Chen', occurredAt: '2026-10-12T11:28:00Z', previousEventId: 'co-02' },
] satisfies readonly CustodyEvent[]

const collected = (evidenceId: string, eventId: string, at: string): CustodyEvent => ({
  eventId, evidenceId, sequence: 1, action: 'collected', fromPartyId: null, toPartyId: 'M. Ortiz', occurredAt: at, previousEventId: null,
})

const hashes = {
  'EV-1042': 'sha256:f1e33fb24ea306c5c0e5512179ce56323a438b5cbfaa62f4ce8cfa3303caffd0',
  'EV-1043': 'sha256:ffda063df095edf23eca9b5ef0e744b50685e4cc35d6d386479d6a68e6f11384',
  'EV-1044': 'sha256:ac76670913176982280b348b05a9936f094b01af01ed42eac441408a623d55b2',
  'EV-1045': 'sha256:fa22fa1185202b7bb3e620eb03ecd8c411ede20da52a7ecd2e873247374b7153',
  'EV-1046': 'sha256:f1e33fb24ea306c5c0e5512179ce56323a438b5cbfaa62f4ce8cfa3303caffd0',
  'EV-1047': 'sha256:3731205b5638641cf0f6f0fff60e634e4bac48b311f5e64c8e43b1084826f5d1',
  'EV-1048': 'sha256:1aaec131a848f0afdc2b747a901a5c85bbfd7804e11920339ee0a3e57a6cdbf7',
  'EV-1049': 'sha256:b64caad585bdedeb16f8b08d30113f17d219de7a2d096777c0899e5e1553233d',
  'EV-1050': 'sha256:bd2496a0859c04279e96d571902854a4bb079de060a5e6bca5449757461eb0ca',
  'EV-1051': 'sha256:769f9711c9b93b537591917cf22fa8440ccaff106f4ce269d11a59f27418ec5e',
  'EV-1052': 'sha256:963a5193f75361fb4d443cff9d4b49506933d6ab4418658193376227b3af80b5',
  'EV-1053': 'sha256:63a95b042f58c5435f12d956d6f74f534226c18f10a19cac82f0cc575143ce14',
} as const

export const custody: CustodyEvent[] = [...baseCustody]

export const evidence: EvidenceRecord[] = [
  { evidenceId: 'EV-1042', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'relay-07', observation: { kind: 'relay.status', value: 'offline' }, observedAt: '2026-10-12T08:39:00Z', receivedAt: '2026-10-12T08:40:00Z', contentHash: hashes['EV-1042'], custody: baseCustody },
  { evidenceId: 'EV-1043', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'witness-alvarez', observation: { kind: 'relay.status', value: 'active' }, observedAt: '2026-10-12T08:41:00Z', receivedAt: '2026-10-12T08:48:00Z', contentHash: hashes['EV-1043'], custody: [collected('EV-1043', 'co-04', '2026-10-12T08:48:00Z')] },
  { evidenceId: 'EV-1044', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'gateway-02', observation: { kind: 'relay.status', value: 'offline' }, observedAt: '2026-10-12T08:45:00Z', receivedAt: '2026-10-12T08:46:00Z', contentHash: hashes['EV-1044'], custody: [collected('EV-1044', 'co-05', '2026-10-12T08:46:00Z')] },
  { evidenceId: 'EV-1045', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'relay-07', observation: { kind: 'relay.last_seen', value: '2026-10-12 08:37 UTC' }, observedAt: '2026-10-12T08:37:00Z', receivedAt: '2026-10-12T08:50:00Z', contentHash: hashes['EV-1045'], custody: [collected('EV-1045', 'co-06', '2026-10-12T08:50:00Z')] },
  { evidenceId: 'EV-1046', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'relay-07-import', observation: { kind: 'relay.status', value: 'offline' }, observedAt: '2026-10-12T08:39:00Z', receivedAt: '2026-10-12T08:52:00Z', contentHash: hashes['EV-1046'], custody: [collected('EV-1046', 'co-07', '2026-10-12T08:52:00Z')] },
  { evidenceId: 'EV-1047', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'relay-07', observation: { kind: 'relay.status', value: 'offline' }, observedAt: '2026-10-12T08:39:00Z', receivedAt: '2026-10-12T08:40:00Z', contentHash: hashes['EV-1047'], custody: [collected('EV-1047', 'co-08', '2026-10-12T08:41:00Z')] },
  { evidenceId: 'EV-1048', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'sensor-03', observation: { kind: 'relay.status', value: 'active' }, observedAt: '2026-10-12T09:20:00Z', receivedAt: '2026-10-12T09:10:00Z', contentHash: hashes['EV-1048'], custody: [collected('EV-1048', 'co-09', '2026-10-12T09:10:00Z')] },
  { evidenceId: 'EV-1049', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'relay-07', observation: { kind: 'relay.status', value: 'offline' }, observedAt: '2026-10-12T08:20:00Z', receivedAt: '2026-10-12T09:15:00Z', contentHash: hashes['EV-1049'], custody: [collected('EV-1049', 'co-10', '2026-10-12T09:15:00Z')] },
  { evidenceId: 'EV-1050', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'custody-register', observation: { kind: 'custody.status', value: 'stored' }, observedAt: '2026-10-12T09:30:00Z', receivedAt: '2026-10-12T09:31:00Z', contentHash: hashes['EV-1050'], custody: [
    collected('EV-1050', 'co-11', '2026-10-12T09:30:00Z'),
    { eventId: 'co-12', evidenceId: 'EV-1050', sequence: 3, action: 'received', fromPartyId: 'M. Ortiz', toPartyId: 'A. Chen', occurredAt: '2026-10-12T09:45:00Z', previousEventId: 'co-11' },
  ] },
  { evidenceId: 'EV-1051', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'storage-register', observation: { kind: 'custody.status', value: 'stored' }, observedAt: '2026-10-12T09:35:00Z', receivedAt: '2026-10-12T09:36:00Z', contentHash: hashes['EV-1051'], custody: [
    collected('EV-1051', 'co-13', '2026-10-12T09:35:00Z'),
    { eventId: 'co-16', evidenceId: 'EV-1051', sequence: 2, action: 'stored', fromPartyId: 'M. Ortiz', toPartyId: 'Evidence locker 03', occurredAt: '2026-10-12T09:36:00Z', previousEventId: 'co-13' },
  ] },
  { evidenceId: 'EV-1052', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'maintenance-bot', observation: { kind: 'relay.status', value: 'offline' }, observedAt: '2026-10-12T09:40:00Z', receivedAt: '2026-10-12T09:41:00Z', contentHash: hashes['EV-1052'], custody: [collected('EV-1052', 'co-14', '2026-10-12T09:41:00Z')] },
  { evidenceId: 'EV-1053', caseId: 'CASE-2417', subjectId: 'Northstar relay', sourceId: 'maintenance-bot', observation: { kind: 'relay.status', value: 'offline' }, observedAt: '2026-10-12T08:47:00Z', receivedAt: '2026-10-12T08:48:00Z', contentHash: hashes['EV-1053'], custody: [collected('EV-1053', 'co-15', '2026-10-12T08:48:00Z')] },
]

export const evidenceCatalog: Record<string, EvidenceCatalogEntry> = {
  'EV-1042': { evidenceId: 'EV-1042', title: 'Relay status event', filename: 'ev-1042-relay-status.json', path: '/case-files/ev-1042-relay-status.json', kind: 'event-log' },
  'EV-1043': { evidenceId: 'EV-1043', title: 'Witness Alvarez note', filename: 'ev-1043-witness-note.txt', path: '/case-files/ev-1043-witness-note.txt', kind: 'witness-note' },
  'EV-1044': { evidenceId: 'EV-1044', title: 'Gateway observation', filename: 'ev-1044-gateway-observation.json', path: '/case-files/ev-1044-gateway-observation.json', kind: 'observation' },
  'EV-1045': { evidenceId: 'EV-1045', title: 'Last-seen event log', filename: 'ev-1045-last-seen.log', path: '/case-files/ev-1045-last-seen.log', kind: 'event-log' },
  'EV-1046': { evidenceId: 'EV-1046', title: 'Relay import event', filename: 'ev-1046-relay-import.json', path: '/case-files/ev-1046-relay-import.json', kind: 'event-log' },
  'EV-1047': { evidenceId: 'EV-1047', title: 'Relay status duplicate import', filename: 'ev-1047-relay-status-copy.json', path: '/case-files/ev-1047-relay-status-copy.json', kind: 'event-log' },
  'EV-1048': { evidenceId: 'EV-1048', title: 'Future-dated sensor note', filename: 'ev-1048-future-observation.txt', path: '/case-files/ev-1048-future-observation.txt', kind: 'observation' },
  'EV-1049': { evidenceId: 'EV-1049', title: 'Clock regression event', filename: 'ev-1049-clock-regression.log', path: '/case-files/ev-1049-clock-regression.log', kind: 'event-log' },
  'EV-1050': { evidenceId: 'EV-1050', title: 'Custody gap register', filename: 'ev-1050-custody-gap.json', path: '/case-files/ev-1050-custody-gap.json', kind: 'transfer' },
  'EV-1051': { evidenceId: 'EV-1051', title: 'Storage receipt', filename: 'ev-1051-storage-receipt.txt', path: '/case-files/ev-1051-storage-receipt.txt', kind: 'transfer' },
  'EV-1052': { evidenceId: 'EV-1052', title: 'Maintenance note', filename: 'ev-1052-maintenance-note.md', path: '/case-files/ev-1052-maintenance-note.md', kind: 'observation' },
  'EV-1053': { evidenceId: 'EV-1053', title: 'Independent observation', filename: 'ev-1053-independent-observation.json', path: '/case-files/ev-1053-independent-observation.json', kind: 'observation' },
}

export const timeline: TimelineItem[] = [
  { id: 't1', time: '08:37:00', type: 'event', title: 'Last heartbeat received', detail: 'Northstar relay / relay-07', source: 'gateway-02', confidence: 'high', evidenceId: 'EV-1045' },
  { id: 't2', time: '08:39:00', type: 'event', title: 'Relay status changed', detail: 'Status: offline · no retry', source: 'relay-07', confidence: 'high', evidenceId: 'EV-1042' },
  { id: 't3', time: '08:41:00', type: 'note', title: 'Witness observation logged', detail: '“Indicator was green when I left.”', source: 'M. Alvarez', confidence: 'medium', evidenceId: 'EV-1043' },
  { id: 't4', time: '08:45:00', type: 'contradiction', title: 'Contradictory observation detected', detail: 'Witness active vs gateway offline within 4 minutes', source: 'validation engine', confidence: 'low', evidenceId: 'EV-1044', findingCode: 'CONFLICTING_OBSERVATIONS' },
  { id: 't7', time: '08:52:00', type: 'duplicate', title: 'Duplicate record imported', detail: 'EV-1046 repeats EV-1042 bytes; not a contradictory observation', source: 'validation engine', confidence: 'low', evidenceId: 'EV-1046', findingCode: 'DUPLICATE_EVIDENCE' },
  { id: 't5', time: '09:05:00', type: 'transfer', title: 'Evidence transferred', detail: 'Field kit → Evidence locker 03', source: 'M. Ortiz', confidence: 'high', evidenceId: 'EV-1042' },
  { id: 't8', time: '09:10:00', type: 'alert', title: 'Future-dated observation received', detail: 'Sensor time is 10 minutes ahead of receipt', source: 'sensor-03', confidence: 'low', evidenceId: 'EV-1048', findingCode: 'CLOCK_SKEW' },
  { id: 't9', time: '09:15:00', type: 'alert', title: 'Source clock regression', detail: 'relay-07 observation clock moved backward by 17 minutes', source: 'relay-07', confidence: 'low', evidenceId: 'EV-1049', findingCode: 'CLOCK_SKEW' },
  { id: 't10', time: '09:45:00', type: 'alert', title: 'Custody sequence gap', detail: 'EV-1050 jumps from collection #1 to receipt #3', source: 'custody register', confidence: 'low', evidenceId: 'EV-1050', findingCode: 'BROKEN_CHAIN_OF_CUSTODY' },
  { id: 't6', time: '11:28:00', type: 'transfer', title: 'Evidence received', detail: 'Evidence locker 03 → A. Chen', source: 'custody register', confidence: 'high', evidenceId: 'EV-1042' },
]

export const entities: Entity[] = [
  { name: 'Northstar relay', kind: 'asset', role: 'Primary subject', initials: 'NR', tone: 'blue', links: 8 },
  { name: 'M. Alvarez', kind: 'person', role: 'Witness · W-02', initials: 'MA', tone: 'amber', links: 3 },
  { name: 'M. Ortiz', kind: 'person', role: 'Collector · CO-17', initials: 'MO', tone: 'violet', links: 5 },
  { name: 'gateway-02', kind: 'system', role: 'Telemetry source', initials: 'G2', tone: 'green', links: 4 },
  { name: 'Evidence locker 03', kind: 'place', role: 'Custody location', initials: 'L3', tone: 'slate', links: 2 },
]

export const caseMeta = {
  id: 'CASE-2417',
  title: 'Northstar relay interruption',
  subtitle: 'Synthetic case · defensive review only',
  opened: '12 Oct 2026 · 08:37 UTC',
  owner: 'A. Chen',
}
