/** @typedef {'AND'|'OR'} QueryOperator */
/** @typedef {'tag'|'label'|'location'|'date'|'title'|'favorite'} QueryField */
/** @typedef {'is'|'is_not'|'contains'|'before'|'after'} QueryRuleOperator */
/** @typedef {{ id: string, type: 'rule', field: QueryField, operator: QueryRuleOperator, value: string }} QueryRule */
/** @typedef {'any'|'all'|'none'} TagMode */
/** @typedef {'is'|'contains'|'is_not'} LocationOperator */
/** @typedef {{ id: string, type: 'tags', mode: TagMode, values: string[] }} QueryTags */
/** @typedef {{ id: string, type: 'label', value: string }} QueryLabel */
/**
 * @typedef {{ id: string, type: 'date-interval', from?: string, to?: string }} QueryDateInterval
 * Inclusive YYYY-MM-DD bounds; at least one is required and from must not exceed to.
 */
/**
 * @typedef {{ id: string, type: 'location', operator: LocationOperator, value: string }} QueryLocation
 * `is` is exact; `contains` and `is_not` test literal substring presence and absence.
 */
/** @typedef {QueryTags|QueryLabel|QueryDateInterval|QueryLocation} QueryFilter */
/** @typedef {{ id: string, type: 'group', operator: QueryOperator, children: QueryNode[] }} QueryGroup */
/**
 * @typedef {QueryFilter|QueryRule|QueryGroup} QueryNode
 * Canonical filters and groups, with legacy rules supported for compatibility.
 */

function id(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {QueryGroup} */
export function emptyQuery() {
  return { id: 'group-root', type: 'group', operator: 'AND', children: [] };
}

/** @param {QueryField} field @param {string} value @returns {QueryRule} */
export function createRule(field = 'tag', value = '') {
  return { id: id('rule'), type: 'rule', field, operator: 'is', value };
}

/** @param {QueryOperator} operator @param {QueryNode[]} children @returns {QueryGroup} */
export function createGroup(operator = 'AND', children = []) {
  return { id: id('group'), type: 'group', operator, children: [...children] };
}

/**
 * Empty values match nothing for any, and everything for all/none.
 * @param {string[]} values
 * @param {TagMode} mode
 * @returns {QueryTags}
 */
export function createTags(values = [], mode = 'any') {
  return { id: id('tags'), type: 'tags', mode, values: [...values] };
}

/** @param {string} value @returns {QueryLabel} */
export function createLabel(value = '') {
  return { id: id('label'), type: 'label', value };
}

/**
 * Draft nodes are validated by the compiler before search.
 * @param {string} [from] Inclusive lower bound in YYYY-MM-DD format.
 * @param {string} [to] Inclusive upper bound in YYYY-MM-DD format.
 * @returns {QueryDateInterval}
 */
export function createDateInterval(from, to) {
  return { id: id('date-interval'), type: 'date-interval', ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** @param {string} value @param {LocationOperator} operator @returns {QueryLocation} */
export function createLocation(value = '', operator = 'is') {
  return { id: id('location'), type: 'location', operator, value };
}
