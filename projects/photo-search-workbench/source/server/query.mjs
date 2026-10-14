const FIELDS = new Set(['tag', 'label', 'location', 'date', 'title', 'favorite']);
const OPERATORS = new Set(['is', 'is_not', 'contains', 'before', 'after']);
const FIELD_OPERATORS = {
  tag: new Set(['is', 'is_not', 'contains']),
  label: new Set(['is', 'is_not', 'contains']),
  location: new Set(['is', 'is_not', 'contains']),
  date: new Set(['is', 'is_not', 'before', 'after']),
  title: new Set(['is', 'is_not', 'contains']),
  favorite: new Set(['is', 'is_not']),
};
const SORT_ORDER = Object.freeze({
  newest: 'p.date DESC, p.id ASC',
  oldest: 'p.date ASC, p.id ASC',
  title: 'lower(p.title) ASC, p.id ASC',
});
const MAX_NODES = 500;
const MAX_DEPTH = 8;
const MAX_CHILDREN = 100;
const MAX_TAG_VALUES = 100;

/**
 * @typedef {'any'|'all'|'none'} TagMode
 * @typedef {'is'|'contains'|'is_not'} LocationOperator
 * @typedef {{ id: string, type: 'tags', mode: TagMode, values: string[] }} QueryTags
 * @typedef {{ id: string, type: 'label', value: string }} QueryLabel
 * @typedef {{ id: string, type: 'date-interval', from?: string, to?: string }} QueryDateInterval
 * @typedef {{ id: string, type: 'location', operator: LocationOperator, value: string }} QueryLocation
 * @typedef {QueryTags|QueryLabel|QueryDateInterval|QueryLocation} QueryFilter
 * @typedef {'AND'|'OR'} QueryOperator
 * @typedef {'tag'|'label'|'location'|'date'|'title'|'favorite'} QueryField
 * @typedef {'is'|'is_not'|'contains'|'before'|'after'} QueryRuleOperator
 * @typedef {{ id: string, type: 'rule', field: QueryField, operator: QueryRuleOperator, value: string }} QueryRule
 * @typedef {{ id: string, type: 'group', operator: QueryOperator, children: QueryNode[] }} QueryGroup
 * @typedef {QueryFilter|QueryRule|QueryGroup} QueryNode
 * @typedef {{ sql: string, params: (string|number)[] }} CompiledNode
 */

export class QueryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryValidationError';
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) {
    throw new QueryValidationError(`${label} must be a non-empty string of 300 characters or fewer`);
  }
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function isValidYear(value) {
  return /^\d{4}$/.test(value) && Number(value) >= 1 && Number(value) <= 9999;
}

function assertDateValue(value, operator) {
  if (operator === 'before' || operator === 'after') {
    if (!isValidDate(value)) throw new QueryValidationError('Date before/after values must be a valid YYYY-MM-DD date');
    return;
  }
  if (!isValidYear(value) && !isValidDate(value)) {
    throw new QueryValidationError('Date values must be a valid YYYY year or YYYY-MM-DD date');
  }
}

function compileRule(rule, depth) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new QueryValidationError(`Invalid rule at depth ${depth}`);
  }
  if (rule.type !== 'rule') throw new QueryValidationError('Rule type must be "rule"');
  assertString(rule.id, 'Rule id');
  if (!FIELDS.has(rule.field)) throw new QueryValidationError(`Unsupported rule field: ${rule.field}`);
  if (!OPERATORS.has(rule.operator) || !FIELD_OPERATORS[rule.field].has(rule.operator)) {
    throw new QueryValidationError(`Operator ${rule.operator} is not valid for ${rule.field}`);
  }
  assertString(rule.value, 'Rule value');

  const { field, operator, value } = rule;
  const normalized = value.trim();
  if (normalized.length === 0) throw new QueryValidationError('Rule value cannot be blank');

  if (field === 'favorite' && !['true', 'false'].includes(normalized.toLowerCase())) {
    throw new QueryValidationError('Favorite rules must use the value "true" or "false"');
  }
  if (field === 'date') assertDateValue(normalized, operator);

  if (field === 'tag') {
    if (operator === 'is') return { sql: 'EXISTS (SELECT 1 FROM json_each(p.tags) WHERE lower(value) = lower(?))', params: [normalized] };
    if (operator === 'is_not') return { sql: 'NOT EXISTS (SELECT 1 FROM json_each(p.tags) WHERE lower(value) = lower(?))', params: [normalized] };
    return { sql: "EXISTS (SELECT 1 FROM json_each(p.tags) WHERE lower(value) LIKE lower(?) ESCAPE '\\')", params: [`%${escapeLike(normalized)}%`] };
  }

  if (field === 'favorite') {
    const bool = normalized.toLowerCase() === 'true' ? 1 : 0;
    return { sql: `p.favorite ${operator === 'is' ? '=' : '!='} ?`, params: [bool] };
  }

  const column = `p.${field}`;
  if (field === 'date' && (operator === 'is' || operator === 'is_not') && isValidYear(normalized)) {
    const nextYear = String(Number(normalized) + 1).padStart(4, '0');
    if (operator === 'is') return { sql: `${column} >= ? AND ${column} < ?`, params: [`${normalized}-01-01`, `${nextYear}-01-01`] };
    return { sql: `${column} < ? OR ${column} >= ?`, params: [`${normalized}-01-01`, `${nextYear}-01-01`] };
  }
  if (operator === 'contains') return { sql: `lower(${column}) LIKE lower(?) ESCAPE '\\'`, params: [`%${escapeLike(normalized)}%`] };
  if (operator === 'is') return { sql: `lower(${column}) = lower(?)`, params: [normalized] };
  if (operator === 'is_not') return { sql: `lower(${column}) != lower(?)`, params: [normalized] };
  return { sql: `${column} ${operator === 'before' ? '<' : '>'} ?`, params: [normalized] };
}

function filterValue(value, label) {
  assertString(value, label);
  const normalized = value.trim();
  if (!normalized) throw new QueryValidationError(`${label} cannot be blank`);
  return normalized;
}

function compileTags(node) {
  assertString(node.id, 'Tags id');
  if (!['any', 'all', 'none'].includes(node.mode)) throw new QueryValidationError('Tags mode must be any, all, or none');
  if (!Array.isArray(node.values) || node.values.length > MAX_TAG_VALUES) {
    throw new QueryValidationError(`Tags values must be an array of ${MAX_TAG_VALUES} strings or fewer`);
  }
  const params = Array.from(node.values, (value) => filterValue(value, 'Tag value'));
  if (params.length === 0) return { sql: node.mode === 'any' ? '1 = 0' : '1 = 1', params };
  const predicate = `${node.mode === 'none' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM json_each(p.tags) WHERE lower(value) = lower(?))`;
  return {
    sql: `(${params.map(() => predicate).join(node.mode === 'any' ? ' OR ' : ' AND ')})`,
    params,
  };
}

function compileDateInterval(node) {
  assertString(node.id, 'Date interval id');
  const { from, to } = node;
  if (from === undefined && to === undefined) throw new QueryValidationError('Date interval requires at least one bound');
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value !== undefined && (typeof value !== 'string' || !isValidDate(value))) {
      throw new QueryValidationError(`Date interval ${name} must be a valid YYYY-MM-DD date`);
    }
  }
  if (from !== undefined && to !== undefined && from > to) throw new QueryValidationError('Date interval from must be on or before to');
  const parts = [];
  const params = [];
  if (from !== undefined) {
    parts.push('p.date >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    parts.push('p.date <= ?');
    params.push(to);
  }
  return { sql: `(${parts.join(' AND ')})`, params };
}

function compileLocation(node) {
  assertString(node.id, 'Location id');
  if (!['is', 'contains', 'is_not'].includes(node.operator)) throw new QueryValidationError('Location operator must be is, contains, or is_not');
  const value = filterValue(node.value, 'Location value');
  if (node.operator === 'is') return { sql: 'lower(p.location) = lower(?)', params: [value] };
  return {
    sql: `lower(p.location) ${node.operator === 'is_not' ? 'NOT LIKE' : 'LIKE'} lower(?) ESCAPE '\\'`,
    params: [`%${escapeLike(value)}%`],
  };
}

/** @param {QueryNode} node @param {number} depth @param {{ nodes: number }} state @returns {CompiledNode} */
function compileNode(node, depth, state) {
  if (depth > MAX_DEPTH) throw new QueryValidationError(`Query nesting cannot exceed ${MAX_DEPTH} levels`);
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new QueryValidationError(`Query cannot contain more than ${MAX_NODES} nodes`);
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new QueryValidationError('Query nodes must be objects');
  if (node.type === 'rule') return compileRule(node, depth);
  if (node.type === 'tags') return compileTags(node);
  if (node.type === 'date-interval') return compileDateInterval(node);
  if (node.type === 'location') return compileLocation(node);
  if (node.type === 'label') {
    assertString(node.id, 'Label id');
    return { sql: 'lower(p.label) = lower(?)', params: [filterValue(node.value, 'Label value')] };
  }
  if (node.type !== 'group') throw new QueryValidationError('Query node type must be group, tags, label, date-interval, location, or rule');
  assertString(node.id, 'Group id');
  if (!['AND', 'OR'].includes(node.operator)) throw new QueryValidationError('Group operator must be AND or OR');
  if (!Array.isArray(node.children) || node.children.length > MAX_CHILDREN) throw new QueryValidationError(`Group children must be an array of ${MAX_CHILDREN} items or fewer`);
  if (node.children.length === 0) return { sql: node.operator === 'AND' ? '1 = 1' : '1 = 0', params: [] };
  const parts = node.children.map((child) => compileNode(child, depth + 1, state));
  return {
    // Each child is one boolean operand, including compound legacy year rules.
    sql: `(${parts.map((part) => `(${part.sql})`).join(` ${node.operator} `)})`,
    params: parts.flatMap((part) => part.params),
  };
}

/** @param {QueryNode} query @param {'newest'|'oldest'|'title'} sort */
export function compileQuery(query, sort = 'newest') {
  if (typeof sort !== 'string' || !Object.hasOwn(SORT_ORDER, sort)) throw new QueryValidationError('Sort must be newest, oldest, or title');
  const result = compileNode(query, 0, { nodes: 0 });
  const orderBy = SORT_ORDER[sort];
  return { where: result.sql, params: result.params, orderBy };
}

export function emptyQuery() {
  return { id: 'group-root', type: 'group', operator: 'AND', children: [] };
}
