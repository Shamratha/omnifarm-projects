import {
  budgetCents,
  spentCents,
  SNAPSHOT_DATE,
  vendors,
  policiesById,
} from './data.js';

const ACTIVE_STATUSES = new Set(['approved', 'pending', 'in_progress']);

export function formatMoney(cents, { compact = false } = {}) {
  const value = Number(cents);
  if (!Number.isFinite(value)) throw new TypeError('cents must be a finite number');

  if (compact) {
    const sign = value < 0 ? '-' : '';
    const absolute = Math.abs(value) / 100;
    const units = [
      [1_000_000, 'M'],
      [1_000, 'K'],
    ];
    const unit = units.find(([threshold]) => absolute >= threshold);
    if (unit) {
      const [threshold, suffix] = unit;
      const amount = (absolute / threshold).toFixed(1).replace(/\.0$/, '');
      return `${sign}$${amount}${suffix}`;
    }
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

function decimalToCents(value) {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i);
  if (!match) throw new TypeError('value must be a decimal number or decimal string');

  const [, signText, whole = '0', trailingFraction, leadingFraction, exponentText = '0'] = match;
  const fraction = trailingFraction ?? leadingFraction ?? '';
  const digitsText = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const digits = BigInt(digitsText || '0');
  if (digits === 0n) return 0;
  const centsShift = 2n - BigInt(fraction.length) + BigInt(exponentText);
  let cents;

  if (centsShift >= 0n) {
    if (BigInt(digitsText.length) + centsShift > 16n) {
      throw new RangeError('converted cents exceed safe integer range');
    }
    cents = digits * 10n ** centsShift;
  } else {
    if (-centsShift > BigInt(digitsText.length)) return 0;
    const divisor = 10n ** -centsShift;
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    cents = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  if (signText === '-') cents = -cents;
  const number = Number(cents);
  if (!Number.isSafeInteger(number)) throw new RangeError('converted cents exceed safe integer range');
  return number;
}

export function toCents(decimal) {
  if (typeof decimal !== 'number' && typeof decimal !== 'string') {
    throw new TypeError('decimal must be a number or decimal string');
  }
  if (typeof decimal === 'number' && !Number.isFinite(decimal)) {
    throw new TypeError('decimal must be finite');
  }
  return decimalToCents(decimal);
}

export function isFullyApproved(request) {
  return Array.isArray(request.approvals)
    && request.approvals.length > 0
    && request.approvals.every((approval) => approval.status === 'approved');
}

function isBefore(date, asOf) {
  return typeof date === 'string' && date < asOf;
}

function requestKey(request) {
  return request.commitmentId == null
    ? `request:${request.id}`
    : `commitment:${request.commitmentId}`;
}

const UNKNOWN_POLICY = {
  id: 'unknown-policy',
  name: 'Unknown policy',
  code: 'POLICY-UNKNOWN',
  thresholdLabel: 'Scope unavailable',
  rule: 'Policy rule metadata is unavailable for this exception.',
  provenanceLabel: 'Unresolved policy metadata',
};

function normalizePolicyException(exception) {
  if (typeof exception === 'string') {
    return { policyId: 'unknown-policy', reason: exception };
  }
  if (!exception || typeof exception !== 'object') {
    return { policyId: 'unknown-policy', reason: 'Policy exception details are unavailable.' };
  }
  return {
    policyId: typeof exception.policyId === 'string' && exception.policyId.length > 0
      ? exception.policyId
      : 'unknown-policy',
    reason: typeof exception.reason === 'string' && exception.reason.length > 0
      ? exception.reason
      : 'Policy exception details are unavailable.',
    ...(typeof exception.evidence === 'string' && exception.evidence.length > 0
      ? { evidence: exception.evidence }
      : {}),
  };
}

function resolvePolicy(policyId) {
  return Object.hasOwn(policiesById, policyId) ? policiesById[policyId] : UNKNOWN_POLICY;
}

function policyFlag(exception, label) {
  const policy = resolvePolicy(exception.policyId);
  return {
    type: 'policy',
    label,
    explanation: exception.reason,
    reason: exception.reason,
    ...(exception.evidence ? { evidence: exception.evidence } : {}),
    policyId: exception.policyId,
    policyCode: policy.code,
    policyName: policy.name,
    policyRule: policy.rule,
    policyThreshold: policy.thresholdLabel,
    provenanceLabel: policy.provenanceLabel,
  };
}

// The first non-cancelled occurrence owns a commitment's projection amount.
// Flags and counts describe individual requests, including duplicate records.
export function analyzeRequests(requests, asOf = SNAPSHOT_DATE) {
  const seenCommitments = new Set();

  return requests.map((request) => {
    const cancelled = request.status === 'cancelled';
    const eligible = ACTIVE_STATUSES.has(request.status);
    const key = requestKey(request);
    const isDuplicate = eligible && seenCommitments.has(key);
    if (eligible) seenCommitments.add(key);

    const overdueApprovals = cancelled
      ? []
      : (request.approvals ?? [])
        .filter((approval) => approval.status === 'pending' && isBefore(approval.dueDate, asOf))
        .map((approval) => ({ ...approval }));

    const flags = [];
    if (!cancelled && request.commitmentId == null) {
      flags.push({
        type: 'untracked',
        label: 'Untracked commitment',
        explanation: 'This active request has no commitment ID and cannot be reconciled to a purchase record.',
      });
    }
    if (overdueApprovals.length > 0) {
      flags.push({
        type: 'overdue',
        label: 'Overdue approval',
        explanation: `${overdueApprovals.length} pending approval${overdueApprovals.length === 1 ? '' : 's'} was due before ${asOf}.`,
      });
    }

    const rawPolicyExceptions = Array.isArray(request.policyExceptions)
      ? request.policyExceptions
      : request.policyExceptions == null
        ? []
        : [request.policyExceptions];
    const policyExceptions = cancelled
      ? []
      : rawPolicyExceptions.map(normalizePolicyException);
    const splitApprovalIncomplete = request.status === 'approved' && !isFullyApproved(request);
    if (splitApprovalIncomplete && policyExceptions.length === 0) {
      const approvalPolicy = policiesById['approval-chain'];
      const aboveFinanceThreshold = request.amountCents > approvalPolicy.thresholdCents;
      const pendingRoles = (request.approvals ?? [])
        .filter((approval) => approval.status !== 'approved')
        .map((approval) => approval.role)
        .join(', ');
      policyExceptions.push({
        policyId: approvalPolicy.id,
        reason: 'The request is marked approved while a required approval stage is still pending.',
        evidence: `${aboveFinanceThreshold ? `${formatMoney(request.amountCents)} exceeds the ${formatMoney(approvalPolicy.thresholdCents)} finance-review threshold. ` : ''}${pendingRoles || 'Required'} approval is incomplete${request.commitmentId == null ? '; no commitment ID is assigned' : ''}.`,
      });
    }
    if (policyExceptions.length > 0) {
      policyExceptions.forEach((exception, index) => {
        flags.push(policyFlag(exception, splitApprovalIncomplete && index === 0
          ? 'Split approval incomplete'
          : 'Policy exception'));
      });
    }

    return {
      ...request,
      vendor: vendors.find((vendor) => vendor.id === request.vendorId) ?? null,
      policyExceptions,
      flags,
      overdueApprovals,
      isDuplicate,
      includedInProjection: eligible && !isDuplicate,
    };
  });
}

export function summarize(requests, asOf = SNAPSHOT_DATE) {
  return summarizeAnalyzed(analyzeRequests(requests, asOf));
}

// Preserve projection ownership from the full snapshot when summarizing a view.
export function summarizeAnalyzed(analyzed) {
  const included = analyzed.filter((request) => request.includedInProjection);
  const committedCents = included.reduce((sum, request) => sum + request.amountCents, 0);
  const untracked = included.filter((request) => request.commitmentId == null);

  return {
    budgetCents,
    spentCents,
    committedCents,
    projectedCents: spentCents + committedCents,
    remainingCents: budgetCents - spentCents - committedCents,
    untrackedCents: untracked.reduce((sum, request) => sum + request.amountCents, 0),
    untrackedCount: untracked.length,
    overdueCount: analyzed.filter((request) => request.overdueApprovals.length > 0).length,
    policyCount: analyzed.filter((request) => request.flags.some((flag) => flag.type === 'policy')).length,
    activeCount: analyzed.filter((request) => request.status !== 'cancelled').length,
    duplicateCount: analyzed.filter((request) => request.isDuplicate).length,
  };
}
