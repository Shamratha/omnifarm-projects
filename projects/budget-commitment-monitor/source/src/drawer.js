import { SNAPSHOT_DATE } from './data.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const rowsOrEmpty = (value) => Array.isArray(value) ? value : [];

function dateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

function progress(rows, isComplete) {
  const total = rows.length;
  const completed = rows.filter(isComplete).length;
  return { total, completed, percent: total ? Math.round(completed / total * 100) : 0 };
}

function timing(date, complete, cancelled, snapshotTime) {
  const time = dateTime(date);
  const daysOverdue = !complete && !cancelled && time !== null && snapshotTime !== null
    ? Math.max(0, (snapshotTime - time) / DAY_MS)
    : 0;
  const state = complete ? 'complete' : cancelled ? 'cancelled' : daysOverdue > 0 ? 'overdue'
    : time !== null && time === snapshotTime ? 'due_today' : 'upcoming';
  return { state, overdue: state === 'overdue', daysOverdue };
}

// Accept the globally analyzed record: never analyze a single request here,
// because that would give a linked duplicate ownership of the shared balance.
export function createDrawerModel(analyzedRequest, asOf = SNAPSHOT_DATE) {
  const request = analyzedRequest ?? {};
  const cancelled = request.status === 'cancelled';
  const snapshotTime = dateTime(asOf);
  const vendorState = request.vendor?.verified === true ? 'verified'
    : request.vendor?.verified === false ? 'pending' : 'unknown';
  const vendor = {
    name: request.vendor?.name ?? 'Unknown vendor',
    category: request.vendor?.category ?? 'No category recorded',
    state: vendorState,
    explanation: {
      verified: 'The synthetic snapshot marks this vendor as verified. No verification date or supporting review details are recorded.',
      pending: 'The synthetic snapshot marks this vendor as not verified. Verification completion and review status are not recorded.',
      unknown: 'Vendor verification information is unavailable in the synthetic snapshot.',
    }[vendorState],
    source: `Synthetic snapshot · ${SNAPSHOT_DATE}`,
  };
  const stages = rowsOrEmpty(request.approvals).map((stage) => ({
    ...stage,
    ...timing(stage.dueDate, stage.status === 'approved', cancelled || stage.status === 'cancelled', snapshotTime),
  }));
  const approvalProgress = progress(stages, (stage) => stage.status === 'approved');
  const rows = rowsOrEmpty(request.milestones).map((milestone) => ({
    ...milestone,
    ...timing(milestone.date, milestone.status === 'complete', cancelled || milestone.status === 'cancelled', snapshotTime),
  }));
  const nextPending = rows.filter((row) => row.status === 'pending' && row.state !== 'cancelled' && dateTime(row.date) !== null)
    .sort((a, b) => dateTime(a.date) - dateTime(b.date))[0] ?? null;
  const flags = cancelled ? [] : rowsOrEmpty(request.flags).map((flag) => ({ ...flag }));
  const policyExceptions = flags.filter((flag) => flag.type === 'policy').map((flag) => ({
    code: flag.policyCode,
    name: flag.policyName,
    provenance: flag.provenanceLabel,
    threshold: flag.policyThreshold,
    rule: flag.policyRule,
    reason: flag.reason ?? flag.explanation,
    evidence: flag.evidence ?? null,
  }));
  const contributionCents = request.includedInProjection && !cancelled ? request.amountCents : 0;
  const explanation = cancelled ? 'Cancelled request: excluded from the commitment projection.'
    : request.isDuplicate ? 'Linked duplicate: the shared commitment balance is counted once on its owning request; this record adds no additional commitment.'
      : request.includedInProjection ? 'This request owns its commitment contribution in the analyzed snapshot and is included in the projection.'
        : 'This request is not included in the analyzed commitment projection.';

  return {
    asOf,
    vendor,
    approvals: { ...approvalProgress, allApproved: stages.length > 0 && approvalProgress.completed === stages.length, stages },
    milestones: { ...progress(rows, (row) => row.status === 'complete'), rows, nextPending },
    commitment: { contributionCents, explanation },
    policyExceptions,
    flags,
  };
}
