import { compileQuery, emptyQuery, QueryValidationError } from './query.mjs';
import { catalogPhotos } from './catalog.mjs';

export const DEFAULT_REFERENCE_DATE = '2025-11-15';
const CATALOG_LOCATIONS = [...new Set(catalogPhotos.map((photo) => photo[3]))];

export function validateReferenceDate(value = DEFAULT_REFERENCE_DATE) {
  if (typeof value !== 'string') throw new QueryValidationError('Reference date must be a valid YYYY-MM-DD date');
  try {
    compileQuery({ id: 'reference-date', type: 'date-interval', from: value });
  } catch {
    throw new QueryValidationError('Reference date must be a valid YYYY-MM-DD date');
  }
  return value;
}

const TAGS = [
  ['mountains?', 'mountain'],
  ['beach(?:es)?', 'beach'],
  ['coasts?', 'coast'],
  ['forests?', 'forest'],
  ['sunset', 'sunset'],
  ['cit(?:y|ies)', 'city'],
  ['snow', 'snow'],
];
const LOCATIONS = [
  ['dolomites', 'Dolomites'], ['italy', 'Italy'], ['kyoto', 'Kyoto'], ['japan', 'Japan'],
  ['algarve', 'Algarve'], ['portugal', 'Portugal'], ['lofoten', 'Lofoten'], ['norway', 'Norway'],
  ['joshua tree', 'Joshua Tree'], ['usa', 'USA'], ['united states', 'USA'],
  ['swiss alps', 'Swiss Alps'], ['switzerland', 'Switzerland'],
];

function rule(id, field, operator, value) {
  return { id, type: 'rule', field, operator, value };
}

function summerQuery(year, id = 'summer') {
  year = String(year).padStart(4, '0');
  return {
    id: `${id}-group`, type: 'group', operator: 'AND', children: [
      rule(`${id}-after`, 'date', 'after', `${year}-05-31`),
      rule(`${id}-before`, 'date', 'before', `${year}-09-01`),
    ],
  };
}

function shiftDate(referenceDate, days) {
  const time = new Date(`${referenceDate}T00:00:00Z`).getTime() + days * 86400000;
  const bounded = Math.max(new Date('0001-01-01T00:00:00Z').getTime(), Math.min(new Date('9999-12-31T00:00:00Z').getTime(), time));
  return new Date(bounded).toISOString().slice(0, 10);
}

function interval(id, from, to) {
  return { id, type: 'date-interval', from, to };
}

function optionsFor(phrase, referenceDate, locations) {
  const year = Number(referenceDate.slice(0, 4));
  if (phrase === 'last summer') {
    // The most recently completed northern-hemisphere summer, then the one before it.
    const summerYear = Math.max(1, year - (referenceDate.slice(5, 7) < '09' ? 1 : 0));
    return [...new Set([summerYear, Math.max(1, summerYear - 1)])].map((value) => ({
      label: `Summer ${String(value).padStart(4, '0')} (June–August)`, query: summerQuery(value, `summer-${value}`),
    }));
  }
  if (phrase === 'recent') return [
    { label: 'Last 30 days', query: { id: 'recent-30-group', type: 'group', operator: 'AND', children: [rule('recent-30-after', 'date', 'after', shiftDate(referenceDate, -30)), interval('recent-end', '0001-01-01', referenceDate)] } },
    { label: `This year (${referenceDate.slice(0, 4)}) through ${referenceDate}`, query: interval('recent-year', `${referenceDate.slice(0, 4)}-01-01`, referenceDate) },
  ];
  if (phrase === 'yesterday') {
    const yesterday = shiftDate(referenceDate, -1);
    return [{ label: `Yesterday (${yesterday})`, query: interval('yesterday', yesterday, yesterday) }];
  }
  if (phrase === 'last week') {
    const weekday = new Date(`${referenceDate}T00:00:00Z`).getUTCDay();
    const monday = shiftDate(referenceDate, -((weekday + 6) % 7));
    const from = shiftDate(monday, -7);
    const to = shiftDate(monday, -1);
    return [
      { label: `Previous calendar week (Monday–Sunday, ${from}–${to})`, query: interval('last-week-calendar', from, to) },
      { label: 'Previous 7 days', query: interval('last-week-rolling', shiftDate(referenceDate, -7), shiftDate(referenceDate, -1)) },
    ];
  }
  if (phrase === 'this month') {
    const from = `${referenceDate.slice(0, 7)}-01`;
    const monthEnd = new Date(`${from}T00:00:00Z`);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
    const to = monthEnd.toISOString().slice(0, 10);
    return [
      { label: `Month to date (${from}–${referenceDate})`, query: interval('this-month-to-date', from, referenceDate) },
      { label: `Entire month (${from}–${to})`, query: interval('this-month-entire', from, to) },
    ];
  }
  return locations.map((location, index) => ({ label: location, query: rule(`near-${index}`, 'location', 'contains', location) }));
}

export function parseSearchText(input, referenceDate = DEFAULT_REFERENCE_DATE, locations = CATALOG_LOCATIONS) {
  referenceDate = validateReferenceDate(referenceDate);
  const text = typeof input === 'string' ? input.trim() : '';
  // OR separates conjunctions; implicit adjacency and AND bind more tightly.
  if (/\bor\b/i.test(text)) {
    const parts = text.split(/\bor\b/i).map((part) => parseSearchText(part, referenceDate, locations));
    const prefix = (node, index) => ({ ...node, id: `branch-${index}-${node.id}`, ...(node.children ? { children: node.children.map((child) => prefix(child, index)) } : {}) });
    const query = { ...emptyQuery(), operator: 'OR', children: parts.map((part, index) => prefix(part.query, index)) };
    return {
      referenceDate, query, criteria: query.children, interpreted: { query, criteria: query.children },
      recognized: [...new Set(parts.flatMap((part) => part.recognized))],
      unsupported: [...new Set(parts.flatMap((part) => part.unsupported))],
      clarifications: parts.flatMap((part, index) => part.clarifications.map((item) => ({ ...item, id: `branch-${index}-${item.id}`, branch: index, options: item.options.map((option) => ({ ...option, query: prefix(option.query, index) })) }))),
    };
  }
  const source = text.toLowerCase();
  const recognized = [];
  const spans = [];
  const rules = [];
  let sequence = 0;
  const mark = (start, end, phrase) => spans.push([start, end]) && recognized.push(phrase);
  const addRule = (field, operator, value, phrase, start, end) => {
    mark(start, end, phrase);
    rules.push(rule(`rule-${++sequence}`, field, operator, value));
  };

  const clarifications = [];
  for (const phrase of ['last summer', 'near me', 'recent', 'yesterday', 'last week', 'this month']) {
    for (const match of source.matchAll(new RegExp(`\\b${phrase}\\b`, 'g'))) {
      clarifications.push({
        id: `clarification-${clarifications.length + 1}`,
        phrase,
        message: phrase === 'near me' ? 'Which catalog location should “near me” use?' : `Choose what “${phrase}” means.`,
        options: optionsFor(phrase, referenceDate, locations),
      });
      spans.push([match.index, match.index + phrase.length]);
      recognized.push(phrase);
    }
  }

  const insideSpan = (match) => spans.some(([start, end]) => match.index >= start && match.index < end);
  const placeStop = `and|before|after|in\\s+20\\d{2}|favorites?|recent|last summer|yesterday|last week|this month|${TAGS.map(([pattern]) => pattern).join('|')}`;
  const around = new RegExp(`\\baround\\s+(.+?)(?=\\s+(?:${placeStop})\\b|[,;.!?]|$)`, 'g');
  for (const match of source.matchAll(around)) {
    const place = match[1].trim();
    const known = locations.flatMap((location) => [location, ...location.split(',').map((part) => part.trim())])
      .find((location) => location.toLowerCase() === place);
    if (known) addRule('location', 'contains', known, match[0], match.index, match.index + match[0].length);
    else {
      mark(match.index, match.index + match[0].length, match[0]);
      clarifications.push({
        id: `clarification-${clarifications.length + 1}`, phrase: match[0],
        message: `“${place}” is not a known catalog place. Which catalog location should it use?`,
        options: optionsFor('near me', referenceDate, locations),
      });
    }
  }

  for (const [pattern, value] of TAGS) {
    const regex = new RegExp(`\\b${pattern}\\b`, 'g');
    for (const match of source.matchAll(regex)) if (!insideSpan(match)) addRule('tag', 'is', value, match[0], match.index, match.index + match[0].length);
  }
  for (const [pattern, value] of LOCATIONS) {
    const regex = new RegExp(`\\b${pattern}\\b`, 'g');
    for (const match of source.matchAll(regex)) if (!insideSpan(match)) addRule('location', 'contains', value, match[0], match.index, match.index + match[0].length);
  }

  for (const match of source.matchAll(/\b(before|after)\s+(\d{4}-\d{2}-\d{2})\b/g)) {
    if (insideSpan(match)) continue;
    addRule('date', match[1], match[2], match[0], match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(/\bin\s+(20\d{2})\b/g)) {
    if (insideSpan(match)) continue;
    addRule('date', 'is', match[1], match[0], match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(/\b(20\d{2})\b/g)) {
    if (!spans.some(([start, end]) => match.index >= start && match.index < end)) addRule('date', 'is', match[1], match[0], match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(/\bfavorites?\b/g)) {
    if (insideSpan(match)) continue;
    addRule('favorite', 'is', 'true', match[0], match.index, match.index + match[0].length);
  }

  const consumed = [...spans, ...Array.from(source.matchAll(/\b(?:and|or|photos?|images?|pictures?|show|find|of|with|from|the|me|please|in)\b/g), (m) => [m.index, m.index + m[0].length])];
  const unsupported = Array.from(source.matchAll(/[a-z0-9-]+/g))
    .filter((match) => !consumed.some(([a, b]) => match.index >= a && match.index + match[0].length <= b))
    .map((match) => match[0]);

  const uniqueUnsupported = [...new Set(unsupported)];
  const uniqueRules = rules.filter((item, index, all) => all.findIndex((candidate) => candidate.field === item.field && candidate.operator === item.operator && candidate.value === item.value) === index);
  const operator = /\bor\b/i.test(source) ? 'OR' : 'AND';
  const query = { ...emptyQuery(), operator, children: uniqueRules };
  return { referenceDate, query, criteria: query.children, interpreted: { query, criteria: query.children }, clarifications, recognized: [...new Set(recognized)], unsupported: uniqueUnsupported };
}

export { rule as makeRule };
