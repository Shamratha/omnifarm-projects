import { compileQuery } from './query.mjs';

// SQLite's built-in lower()/LIKE fold ASCII characters, not Unicode case pairs.
const fold = (value) => String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const equal = (a, b) => fold(a) === fold(b);
const contains = (a, b) => fold(a).includes(fold(b));
const fieldLabels = { tag: 'Tag', label: 'Label', location: 'Location', date: 'Date', title: 'Title', favorite: 'Favorite' };
const operatorLabels = { is: 'is', is_not: 'is not', contains: 'contains', before: 'before', after: 'after' };

function explainNode(photo, node, path) {
  const nextPath = [...path, node.id];
  const result = (matched, label, actual) => ({
    matched,
    matches: matched ? [{ nodeId: node.id, type: node.type, path: nextPath, state: 'matched', label, actual }] : [],
  });

  if (node.type === 'group') {
    const children = node.children.map((child) => explainNode(photo, child, nextPath));
    const matched = node.operator === 'AND' ? children.every((child) => child.matched) : children.some((child) => child.matched);
    if (node.children.length === 0) return result(matched, 'No filters (all photos)', null);
    // A true leaf in a failing AND branch does not contribute to an OR match.
    return { matched, matches: matched ? children.filter((child) => child.matched).flatMap((child) => child.matches) : [] };
  }
  if (node.type === 'tags') {
    const values = node.values.map((value) => value.trim());
    const present = values.map((value) => photo.tags.some((tag) => equal(tag, value)));
    const matched = node.mode === 'any' ? present.some(Boolean) : node.mode === 'all' ? present.every(Boolean) : present.every((value) => !value);
    const actual = photo.tags.filter((tag) => values.some((value) => equal(tag, value)));
    const label = values.length ? `Tags ${node.mode}: ${values.join(', ')}` : `Tags ${node.mode}: empty set (all photos)`;
    return result(matched, label, actual);
  }
  if (node.type === 'label') return result(equal(photo.label, node.value.trim()), `Label is ${node.value.trim()}`, photo.label);
  if (node.type === 'date-interval') {
    const matched = (node.from === undefined || photo.date >= node.from) && (node.to === undefined || photo.date <= node.to);
    const label = node.from && node.to ? `Date ${node.from}–${node.to} (inclusive)` : node.from ? `Date on or after ${node.from}` : `Date on or before ${node.to}`;
    return result(matched, label, photo.date);
  }
  if (node.type === 'location') {
    const value = node.value.trim();
    const matched = node.operator === 'is' ? equal(photo.location, value) : node.operator === 'contains' ? contains(photo.location, value) : !contains(photo.location, value);
    return result(matched, `Location ${node.operator === 'is_not' ? 'does not contain' : operatorLabels[node.operator]} ${value}`, photo.location);
  }

  const { field, operator } = node;
  const value = node.value.trim();
  const actual = photo[field === 'tag' ? 'tags' : field];
  let matched;
  if (field === 'tag') {
    const present = photo.tags.some((tag) => operator === 'contains' ? contains(tag, value) : equal(tag, value));
    matched = operator === 'is_not' ? !present : present;
  } else if (field === 'favorite') {
    const same = Boolean(photo.favorite) === (fold(value) === 'true');
    matched = operator === 'is_not' ? !same : same;
  } else if (field === 'date' && /^\d{4}$/.test(value)) {
    const same = photo.date.slice(0, 4) === value;
    matched = operator === 'is_not' ? !same : same;
  } else {
    matched = operator === 'contains' ? contains(actual, value)
      : operator === 'is' ? equal(actual, value)
        : operator === 'is_not' ? !equal(actual, value)
          : operator === 'before' ? actual < value : actual > value;
  }
  const label = field === 'favorite'
    ? (Boolean(photo.favorite) ? 'Favorite' : 'Not favorite')
    : `${fieldLabels[field]} ${operatorLabels[operator]} ${value}`;
  return result(matched, label, actual);
}

/** Pure explanation with the same literal comparisons and boolean semantics as compileQuery. */
export function explainPhotoMatch(photo, query) {
  compileQuery(query);
  const { matched, matches } = explainNode(photo, query, []);
  return { matched, matches, matchReasons: matches.map((match) => match.label) };
}
