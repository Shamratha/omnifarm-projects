import './styles.css';

const app = document.querySelector('#app');
const state = {
  catalog: null,
  query: { ...emptyQuery(), children: [{ id: 'initial-tag', type: 'rule', field: 'tag', operator: 'is', value: 'mountain' }, { id: 'initial-year', type: 'rule', field: 'date', operator: 'is', value: '2024' }] },
  results: [],
  resultQuery: null,
  savedSearches: [],
  searchHistory: [],
  sort: 'newest',
  phrase: '',
  referenceDate: '2025-11-15',
  parser: null,
  reviewOpen: false,
  queryEdited: false,
  loading: true,
  message: '',
  catalogMessage: '',
  historyMessage: '',
};

const operators = ['AND', 'OR'];
const ruleOperators = ['is', 'is_not', 'contains', 'before', 'after'];
const labels = { tag: 'Tag', label: 'Label', location: 'Location', date: 'Date', title: 'Title', favorite: 'Favorite' };

function emptyQuery() {
  return { id: 'group-root', type: 'group', operator: 'AND', children: [] };
}

function newId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  });
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

function pathFrom(value) {
  return value ? value.split('.').map(Number) : [];
}

function nodeAt(path) {
  return path.reduce((node, index) => node.children[index], state.query);
}

function updateAt(path, update) {
  const node = nodeAt(path);
  update(node);
}

function removeAt(path) {
  const parent = nodeAt(path.slice(0, -1));
  parent.children.splice(path.at(-1), 1);
}

function querySummary(node) {
  if (!node) return 'All photographs';
  if (node.type === 'group') {
    if (!node.children?.length) return node.operator === 'OR' ? 'No photographs (empty OR)' : 'All photographs';
    return `(${node.children.map(querySummary).join(` ${node.operator || 'AND'} `)})`;
  }
  if (node.type === 'rule') return `${labels[node.field] || node.field} ${node.operator?.replace('_', ' ') || 'is'} ${node.value || 'any value'}`;
  if (node.type === 'tags') return `Tags ${node.mode || 'any'} ${node.values?.join(', ') || 'any value'}`;
  if (node.type === 'label') return `Label is ${node.value || 'any value'}`;
  if (node.type === 'date-interval') return `Date ${node.from || 'any time'} → ${node.to || 'any future date'}`;
  if (node.type === 'location') return `Location ${node.operator?.replace('_', ' ') || 'is'} ${node.value || 'any value'}`;
  return node.type || 'All photographs';
}

function defaultRule() {
  const firstTag = state.catalog?.facets.tags[0] || 'mountain';
  return { id: newId('rule'), type: 'rule', field: 'tag', operator: 'is', value: firstTag };
}

function defaultGroup() {
  return { id: newId('group'), type: 'group', operator: 'AND', children: [] };
}

function valuesForField(field) {
  if (field === 'tag') return state.catalog?.facets.tags || [];
  if (field === 'label') return state.catalog?.facets.labels || [];
  if (field === 'location') return state.catalog?.facets.locations || [];
  return [];
}

function selectControl(className, value, options, extra = {}) {
  const select = el('select', { class: className, ...extra });
  options.forEach(([optionValue, label]) => select.append(el('option', { value: optionValue, text: label })));
  select.value = value;
  return select;
}

function renderRule(node, path) {
  const fieldSelect = selectControl('field-select', node.field, Object.entries(labels).map(([value, label]) => [value, label]), { 'aria-label': 'Criterion field', 'data-action': 'rule-field', 'data-path': path.join('.') });
  const availableOperators = ruleOperators.filter((operator) => {
    if (node.field === 'favorite') return ['is', 'is_not'].includes(operator);
    if (node.field === 'date') return operator !== 'contains';
    return !['before', 'after'].includes(operator);
  });
  const operatorSelect = selectControl('operator-select', availableOperators.includes(node.operator) ? node.operator : availableOperators[0], availableOperators.map((value) => [value, value.replace('_', ' ')]), { 'aria-label': 'Criterion operator', 'data-action': 'rule-operator', 'data-path': path.join('.') });
  let valueControl;
  if (node.field === 'favorite') {
    valueControl = selectControl('value-select', node.value, [['true', 'Is a favorite'], ['false', 'Not a favorite']], { 'aria-label': 'Criterion value', 'data-action': 'rule-value', 'data-path': path.join('.') });
  } else if (valuesForField(node.field).length) {
    valueControl = el('input', { class: 'value-input', value: node.value, list: `values-${node.id}`, placeholder: 'Choose or type…', 'aria-label': 'Criterion value', 'data-action': 'rule-value', 'data-path': path.join('.') });
    const datalist = el('datalist', { id: `values-${node.id}` }, valuesForField(node.field).map((value) => el('option', { value })));
    valueControl = el('div', { class: 'value-with-list' }, [valueControl, datalist]);
  } else {
    valueControl = el('input', { class: 'value-input', value: node.value, placeholder: node.field === 'date' ? 'YYYY-MM-DD or YYYY' : 'Value…', 'aria-label': 'Criterion value', 'data-action': 'rule-value', 'data-path': path.join('.') });
  }
  const card = el('div', { class: 'rule-card' }, [
    el('span', { class: 'rule-icon', text: '↳' }),
    fieldSelect,
    operatorSelect,
    valueControl,
    el('button', { class: 'text-button danger-text clear-filter-button', 'data-action': 'clear-filter', 'data-path': path.join('.'), text: 'Clear filter' }),
  ]);
  return card;
}

function renderFilter(node, path) {
  if (node.type === 'rule') return renderRule(node, path);
  const attrs = { 'data-path': path.join('.') };
  let controls;
  if (node.type === 'date-interval') {
    controls = [el('strong', { text: 'Date range (inclusive)' }), ...['from', 'to'].map((bound) => el('label', { class: 'filter-bound' }, [
      el('span', { text: bound === 'from' ? 'From' : 'Through' }),
      el('input', { type: 'date', value: node[bound] || '', min: '0001-01-01', max: '9999-12-31', 'data-action': 'interval-bound', 'data-bound': bound, ...attrs }),
    ]))];
  } else if (node.type === 'tags') {
    controls = [el('strong', { text: 'Tags' }),
      selectControl('operator-select', node.mode, [['any', 'Any of'], ['all', 'All of'], ['none', 'None of']], { 'aria-label': 'Tag matching mode', 'data-action': 'tags-mode', ...attrs }),
      el('input', { class: 'value-input', value: node.values.join(', '), 'aria-label': 'Tags, separated by commas', placeholder: 'Tags, separated by commas', 'data-action': 'tags-values', ...attrs }),
    ];
  } else {
    controls = [el('strong', { text: labels[node.type] }),
      node.type === 'location' ? selectControl('operator-select', node.operator, [['is', 'is'], ['contains', 'contains'], ['is_not', 'does not contain']], { 'aria-label': 'Location operator', 'data-action': 'rule-operator', ...attrs }) : null,
      el('input', { class: 'value-input', value: node.value, 'aria-label': `${labels[node.type]} value`, 'data-action': 'rule-value', ...attrs }),
    ];
  }
  return el('div', { class: 'filter-card' }, [...controls, el('button', { class: 'text-button danger-text clear-filter-button', 'data-action': 'clear-filter', ...attrs, text: 'Clear filter' })]);
}

function renderGroup(node, path, isRoot = false) {
  const children = el('div', { class: 'group-children' });
  if (!node.children.length) {
    children.append(el('div', { class: 'empty-group', text: 'No criteria yet — add a rule or nested group.' }));
  } else {
    node.children.forEach((child, index) => children.append(child.type === 'group' ? renderGroup(child, [...path, index]) : renderFilter(child, [...path, index])));
  }
  const title = isRoot ? 'All photographs' : 'Nested group';
  const header = el('div', { class: 'group-header' }, [
    el('div', { class: 'group-heading' }, [el('span', { class: 'group-dot' }), el('strong', { text: title }), el('span', { class: 'muted', text: `${node.children.length} ${node.children.length === 1 ? 'criterion' : 'criteria'}` })]),
    selectControl('group-operator', node.operator, operators.map((value) => [value, value]), { 'aria-label': `${title} operator`, 'data-action': 'group-operator', 'data-path': path.join('.') }),
    !isRoot ? el('button', { class: 'text-button danger-text', 'data-action': 'remove', 'data-path': path.join('.'), text: 'Remove group' }) : null,
  ]);
  const footer = el('div', { class: 'group-footer' }, [
    el('button', { class: 'small-button', 'data-action': 'add-rule', 'data-path': path.join('.'), text: '+ Rule' }),
    el('button', { class: 'small-button ghost-button', 'data-action': 'add-group', 'data-path': path.join('.'), text: '+ Nested group' }),
  ]);
  return el('section', { class: `group-card ${isRoot ? 'root-group' : ''}` }, [header, children, footer]);
}

function renderBuilder() {
  const container = document.querySelector('#query-builder');
  if (!container) return;
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const action = active?.dataset.action;
  const path = active?.dataset.path;
  container.replaceChildren(renderGroup(state.query, [], true));
  if (active) {
    const controls = [...container.querySelectorAll('[data-action]')];
    const replacement = controls.find((control) => control.dataset.action === action && control.dataset.path === path)
      || controls.find((control) => control.dataset.action === 'add-rule' && control.dataset.path === path?.split('.').slice(0, -1).join('.'));
    replacement?.focus();
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function formatSavedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function photoCard(photo) {
  const favorite = el('button', { class: `favorite-button ${photo.favorite ? 'is-favorite' : ''}`, title: photo.favorite ? 'Remove from favorites' : 'Add to favorites', 'aria-label': photo.favorite ? `Remove ${photo.title} from favorites` : `Add ${photo.title} to favorites`, 'data-photo-id': photo.id, text: photo.favorite ? '★' : '☆' });
  const reasons = Array.isArray(photo.matchReasons) && photo.matchReasons.length
    ? photo.matchReasons
    : (Array.isArray(photo.matches) ? photo.matches.map((match) => match.label).filter(Boolean) : []);
  const explanation = el('details', { class: 'match-details' }, [
    el('summary', { text: 'Why it matched', 'aria-label': `Why ${photo.title} matched` }),
    reasons.length
      ? el('ul', { class: 'match-reasons' }, reasons.map((reason, index) => {
        const match = photo.matches?.[index];
        const actual = match?.actual === null || match?.actual === undefined ? '' : ` · found: ${Array.isArray(match.actual) ? match.actual.join(', ') : match.actual}`;
        return el('li', { text: `${reason}${actual}` });
      }))
      : el('p', { class: 'muted', text: 'No contributing criteria were returned.' }),
  ]);
  return el('article', { class: 'photo-card', 'aria-label': photo.title, 'data-photo-card-id': photo.id }, [
    el('div', { class: 'photo-image-wrap' }, [el('img', { src: photo.url, alt: photo.title, loading: 'lazy', width: photo.width, height: photo.height }), favorite, el('span', { class: 'photo-label', text: photo.label })]),
    el('div', { class: 'photo-details' }, [
      el('div', { class: 'photo-title-row' }, [el('h3', { text: photo.title }), el('span', { class: 'photo-date', text: formatDate(photo.date) })]),
      el('p', { class: 'photo-location', text: `◎  ${photo.location}` }),
      el('div', { class: 'tag-list' }, photo.tags.slice(0, 3).map((tag) => el('span', { class: 'tag', text: `#${tag}` }))),
      explanation,
    ]),
  ]);
}

function renderResults() {
  const grid = document.querySelector('#results-grid');
  const count = document.querySelector('#result-count');
  if (!grid || !count) return;
  count.textContent = `${state.results.length} ${state.results.length === 1 ? 'photograph' : 'photographs'}`;
  const activeCard = document.activeElement?.closest('[data-photo-card-id]');
  const activeId = activeCard?.dataset.photoCardId;
  const activeIsFavorite = document.activeElement?.matches('.favorite-button');
  const openIds = new Set([...grid.querySelectorAll('details[open]')].map((details) => details.closest('[data-photo-card-id]').dataset.photoCardId));
  grid.replaceChildren(...(state.results.length ? state.results.map(photoCard) : [el('div', { class: 'no-results', text: 'No photographs match these criteria. Try loosening a group or removing a rule.' })]));
  for (const card of grid.querySelectorAll('[data-photo-card-id]')) {
    if (openIds.has(card.dataset.photoCardId)) card.querySelector('details').open = true;
    if (card.dataset.photoCardId === activeId) card.querySelector(activeIsFavorite ? '.favorite-button' : 'summary').focus();
  }
  if (activeId && ![...grid.querySelectorAll('[data-photo-card-id]')].some((card) => card.dataset.photoCardId === activeId)) document.querySelector('#run-button').focus();
}

function renderParser() {
  const output = document.querySelector('#parser-output');
  if (!output) return;
  output.replaceChildren();
  if (!state.parser || !state.reviewOpen) return;
  const { recognized, unsupported, clarifications } = state.parser;
  const staleDate = state.parser.referenceDate !== state.referenceDate;
  const recognizedTerms = recognized.length
    ? el('div', { class: 'term-block' }, [el('strong', { text: 'Recognized' }), el('div', { class: 'term-list' }, recognized.map((term) => el('span', { class: 'term-pill recognized-term', text: term })))])
    : null;
  const unsupportedTerms = unsupported.length
    ? el('div', { class: 'term-block' }, [el('strong', { text: 'Not understood' }), el('div', { class: 'term-list' }, unsupported.map((term) => el('span', { class: 'term-pill unsupported-term', text: term })))])
    : null;
  const describeCriterion = (node, depth = 0) => {
    if (node.type === 'group') {
      const group = el('li', { class: 'interpreted-item', style: `--depth:${depth}` }, [el('span', { class: 'criterion-kind', text: node.operator }), el('span', { text: `${node.children.length} ${node.children.length === 1 ? 'criterion' : 'criteria'}` })]);
      if (node.children.length) {
        group.append(el('ul', { class: 'interpreted-list nested-interpreted-list' }, node.children.map((child) => describeCriterion(child, depth + 1))));
      }
      return group;
    }
    let description = node.type;
    if (node.type === 'rule') description = `${labels[node.field]} ${node.operator.replace('_', ' ')} ${node.value}`;
    if (node.type === 'tags') description = `Tags (${node.mode}) ${node.values.join(', ') || 'empty set'}`;
    if (node.type === 'label') description = `Label is ${node.value}`;
    if (node.type === 'date-interval') description = `Date ${node.from || 'any time'} → ${node.to || 'any future date'}`;
    if (node.type === 'location') description = `Location ${node.operator.replace('_', ' ')} ${node.value}`;
    return el('li', { class: 'interpreted-item', style: `--depth:${depth}` }, [el('span', { class: 'criterion-kind', text: 'criterion' }), el('span', { text: description })]);
  };
  const clarificationContent = clarifications.length
    ? clarifications.map((clarification) => {
      const options = el('div', { class: 'clarification-options' });
      clarification.options.forEach((option) => options.append(el('button', { class: 'option-button', ...(staleDate ? { disabled: '' } : {}), 'data-action': 'clarification', 'data-clarification-id': clarification.id, 'data-option': JSON.stringify(option.query), text: option.label })));
      return el('div', { class: 'clarification' }, [el('strong', { text: `Clarify “${clarification.phrase}”` }), el('span', { text: clarification.message }), options]);
    })
    : el('p', { class: 'parser-line muted', text: 'No ambiguous terms need a choice.' });
  output.append(el('section', { class: 'interpretation-card', 'aria-labelledby': 'interpretation-title' }, [
    el('div', { class: 'interpretation-heading' }, [
      el('div', {}, [el('span', { class: 'interpretation-kicker', text: 'REVIEW BEFORE SEARCH' }), el('h3', { id: 'interpretation-title', tabindex: '-1', text: 'Interpreted criteria' })]),
      el('span', { class: 'review-status', text: state.parser.applied ? 'Applied' : state.queryEdited ? 'Edited criteria' : clarifications.length ? `${clarifications.length} choice${clarifications.length === 1 ? '' : 's'} needed` : 'Ready to edit' }),
    ]),
    el('p', { class: 'interpretation-copy', text: 'Check the terms below, resolve any choices, then edit the criteria in the builder before applying. You can also run or save the edited criteria without resolving unused phrase choices.' }),
    el('label', { class: 'reference-date-control review-reference' }, [el('span', { text: 'Reference date' }), el('input', { type: 'date', value: state.referenceDate, min: '0001-01-01', max: '9999-12-31', required: '', 'data-reference-date': '', 'aria-label': 'Interpretation reference date' })]),
    staleDate ? el('p', { class: 'parser-line warning', text: 'Reference date changed. Interpret the phrase again to refresh relative-date choices.' }) : null,
    el('div', { class: 'term-summary' }, [recognizedTerms, unsupportedTerms]),
     el('div', { class: 'interpreted-criteria' }, [el('strong', { text: state.query.children.length ? 'Current criteria' : 'Criteria to review' }), el('ul', { class: 'interpreted-list' }, state.query.children.map((node) => describeCriterion(node))) ]),
     el('div', { class: 'clarification-list' }, Array.isArray(clarificationContent) ? clarificationContent : [clarificationContent]),
    el('div', { class: 'interpretation-actions' }, [
      el('button', { class: 'dark-button', ...(clarifications.length || staleDate || !state.parser.hasCriteria ? { disabled: '' } : {}), 'data-action': 'apply-interpretation', text: 'Apply interpretation' }),
      el('button', { class: 'text-button', 'data-action': 'keep-editing', text: 'Keep editing' }),
      el('button', { class: 'text-button', 'data-action': 'close-review', text: 'Close review' }),
    ]),
  ]));
}

function renderSavedSearches() {
  const container = document.querySelector('#saved-searches');
  if (!container) return;
  container.replaceChildren();
  if (!state.savedSearches.length) {
    container.append(el('p', { class: 'saved-empty muted', text: 'No saved searches yet. Name the current criteria to keep it close.' }));
    return;
  }
  const list = el('ul', { class: 'saved-search-list' });
  state.savedSearches.forEach((saved) => {
    const loadButton = el('button', { class: 'saved-search-load', 'data-action': 'load-saved', 'data-saved-id': String(saved.id), 'aria-label': `Load saved search ${saved.name}` }, [
      el('strong', { text: saved.name }),
      el('span', { text: `Reference date · ${saved.referenceDate}` }),
    ]);
    list.append(el('li', { class: 'saved-search-item' }, [
      loadButton,
      el('span', { class: 'saved-created', text: `Saved ${formatSavedDate(saved.createdAt)}` }),
      el('button', { class: 'icon-button danger saved-delete', title: `Delete ${saved.name}`, 'aria-label': `Delete saved search ${saved.name}`, 'data-action': 'delete-saved', 'data-saved-id': String(saved.id), text: '×' }),
    ]));
  });
  container.append(list);
}

function renderCatalogTools() {
  const message = document.querySelector('#catalog-message');
  if (!message) return;
  message.textContent = state.catalogMessage;
  message.classList.toggle('visible', Boolean(state.catalogMessage));
  message.classList.toggle('error', state.catalogMessage.startsWith('Import failed'));
}

function renderSearchHistory() {
  const container = document.querySelector('#search-history');
  const message = document.querySelector('#history-message');
  if (!container || !message) return;
  message.textContent = state.historyMessage;
  message.classList.toggle('visible', Boolean(state.historyMessage));
  container.replaceChildren();
  if (!state.searchHistory.length) {
    container.append(el('p', { class: 'history-empty muted', text: 'No searches yet. Searches you run will appear here.' }));
    return;
  }
  const list = el('ul', { class: 'history-list' });
  state.searchHistory.forEach((entry) => {
    const summary = querySummary(entry.query);
    list.append(el('li', { class: 'history-item' }, [
      el('button', { class: 'history-load', 'data-action': 'load-history', 'data-history-id': String(entry.id), 'aria-label': `Load search: ${summary}` }, [
        el('strong', { text: summary }),
        el('span', { text: `Searched ${formatSavedDate(entry.createdAt)}` }),
      ]),
      el('span', { class: 'history-count', text: `${entry.resultCount} ${entry.resultCount === 1 ? 'match' : 'matches'}` }),
    ]));
  });
  container.append(list);
}

function renderStats() {
  if (!state.catalog) return;
  const { stats } = state.catalog;
  document.querySelector('#stat-total').textContent = stats.total;
  document.querySelector('#stat-favorites').textContent = stats.favorites;
  document.querySelector('#stat-locations').textContent = stats.locations;
}

function render() {
  renderStats();
  renderBuilder();
  renderResults();
  renderParser();
  renderSavedSearches();
  renderCatalogTools();
  renderSearchHistory();
  const phraseInput = document.querySelector('#phrase-input');
  const referenceDateInput = document.querySelector('#reference-date');
  if (phraseInput && phraseInput.value !== state.phrase) phraseInput.value = state.phrase;
  if (referenceDateInput && referenceDateInput.value !== state.referenceDate) referenceDateInput.value = state.referenceDate;
  document.querySelector('#sort-select').value = state.sort;
  const message = document.querySelector('#app-message');
  if (message) {
    message.textContent = state.message;
    message.classList.toggle('visible', Boolean(state.message));
  }
}

async function loadCatalog() {
  const response = await fetch('/api/catalog');
  if (!response.ok) throw new Error('Could not load the SQLite catalog. Is the API server running?');
  state.catalog = await response.json();
  state.results = state.catalog.photos;
}

async function loadSearchHistory() {
  const response = await fetch('/api/search-history');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Could not load search history');
  state.searchHistory = Array.isArray(data) ? data : [];
  state.historyMessage = '';
  renderSearchHistory();
}

async function exportCatalog() {
  const response = await fetch('/api/catalog/export');
  if (!response.ok) throw new Error('Could not export the catalog.');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: 'photo-catalog.json' });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  state.catalogMessage = 'Catalog exported.';
  renderCatalogTools();
}

async function importCatalog() {
  const input = document.querySelector('#catalog-file');
  const file = input.files[0];
  if (!file) {
    state.catalogMessage = 'Choose a catalog JSON file to import.';
    renderCatalogTools();
    return;
  }
  const button = document.querySelector('#import-catalog-button');
  button.disabled = true;
  state.catalogMessage = '';
  renderCatalogTools();
  try {
    let body;
    try {
      body = JSON.parse(await file.text());
    } catch {
      throw new Error('The selected file is not valid JSON.');
    }
    const response = await fetch('/api/catalog/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'The catalog could not be imported.');
    await loadCatalog();
    const preview = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state.resultQuery || { query: emptyQuery(), sort: state.sort }) });
    if (preview.ok) state.results = (await preview.json()).photos;
    state.catalogMessage = `Catalog imported (${data.imported} ${data.imported === 1 ? 'photo' : 'photos'}).`;
    input.value = '';
    render();
    await loadSearchHistory().catch(() => {});
  } catch (error) {
    state.catalogMessage = `Import failed: ${error instanceof Error ? error.message : String(error)}`;
    renderCatalogTools();
  } finally {
    button.disabled = false;
  }
}

async function clearSearchHistory() {
  const response = await fetch('/api/search-history', { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Could not clear search history');
  state.searchHistory = [];
  state.historyMessage = `Cleared ${data.deleted} ${data.deleted === 1 ? 'search' : 'searches'}.`;
  renderSearchHistory();
}

async function runSearch() {
  const ranEditedQuery = Boolean(state.parser?.clarifications.length && state.queryEdited);
  if (state.parser?.clarifications.length && !state.queryEdited) throw new Error('Choose an option for each ambiguous term, or edit the criteria before running this search.');
  if (state.parser && state.parser.referenceDate !== state.referenceDate) throw new Error('Interpret the phrase again using the updated reference date.');
  state.message = ranEditedQuery ? 'Ran the edited criteria; unresolved phrase choices were left out.' : '';
  const response = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: state.query, sort: state.sort }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Search failed');
  state.results = data.photos;
  state.resultQuery = { query: structuredClone(state.query), sort: state.sort };
  if (state.parser) state.parser.applied = !state.parser.clarifications.length;
  render();
  try { await loadSearchHistory(); } catch (error) { state.historyMessage = error.message; renderSearchHistory(); }
}

async function parsePhrase() {
  if (!state.phrase.trim()) throw new Error('Enter a phrase to interpret.');
  if (!document.querySelector('#reference-date').reportValidity()) return;
  const button = document.querySelector('#parse-button');
  button.disabled = true;
  button.textContent = 'Interpreting…';
  try {
    const text = state.phrase;
    const referenceDate = state.referenceDate;
    const response = await fetch('/api/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, referenceDate }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Could not parse phrase');
    if (text !== state.phrase || referenceDate !== state.referenceDate) throw new Error('The phrase or reference date changed. Interpret it again to review the latest version.');
    state.parser = { ...data, hasCriteria: Boolean(data.query.children.length || data.clarifications.length), applied: false };
    state.reviewOpen = true;
    state.queryEdited = false;
    state.parser.clarifications = data.clarifications.map((item) => ({ ...item, branchId: item.branch === undefined ? null : data.query.children[item.branch]?.id }));
    state.message = '';
    if (!state.parser.hasCriteria) state.message = 'No supported criteria were found; the current query was kept.';
    else state.query = data.query;
    render();
    document.querySelector('#interpretation-title')?.focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Interpret phrase ↗';
  }
}

async function loadSavedSearches() {
  const response = await fetch('/api/saved-searches');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Could not load saved searches');
  state.savedSearches = data;
  renderSavedSearches();
}

async function saveSearch() {
  const input = document.querySelector('#saved-search-name');
  const name = input.value.trim();
  if (!name) { input.setCustomValidity('Enter a name for this search.'); input.reportValidity(); return; }
  if (state.parser?.clarifications.length && !state.queryEdited) throw new Error('Resolve clarification choices or edit the criteria before saving this search.');
  if (state.parser && state.parser.referenceDate !== state.referenceDate) throw new Error('Interpret the phrase again using the updated reference date before saving.');
  if (!document.querySelector('#reference-date').reportValidity()) return;
  const button = document.querySelector('#save-search-button');
  button.disabled = true;
  try {
    const response = await fetch('/api/saved-searches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, query: state.query, referenceDate: state.referenceDate }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Could not save search');
    state.savedSearches = [data, ...state.savedSearches];
    input.value = '';
    state.message = `Saved “${data.name}”.`;
    render();
  } finally {
    button.disabled = false;
  }
}

async function deleteSavedSearch(id) {
  const response = await fetch(`/api/saved-searches/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error?.message || 'Could not delete saved search');
  }
  state.savedSearches = state.savedSearches.filter((saved) => String(saved.id) !== id);
  state.message = 'Saved search deleted.';
  render();
}

async function toggleFavorite(id) {
  const photo = state.catalog.photos.find((item) => item.id === id) || state.results.find((item) => item.id === id);
  if (!photo) return;
  const response = await fetch(`/api/photos/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: !photo.favorite }) });
  if (!response.ok) throw new Error('Could not update favorite');
  const updated = await response.json();
  state.catalog.photos = state.catalog.photos.map((item) => item.id === id ? updated : item);
  state.catalog.stats.favorites = state.catalog.photos.filter((item) => item.favorite).length;
  state.results = state.results.map((item) => item.id === id ? updated : item);
  await runSearch();
}

function handleBuilderAction(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const path = pathFrom(target.dataset.path);
  if (action === 'add-rule') updateAt(path, (node) => node.children.push(defaultRule()));
  if (action === 'add-group') updateAt(path, (node) => node.children.push(defaultGroup()));
  if ((action === 'remove' && nodeAt(path)?.type === 'group') || (action === 'clear-filter' && nodeAt(path)?.type !== 'group')) {
    if (path.length) removeAt(path);
  }
  if (action === 'group-operator') updateAt(path, (node) => { node.operator = target.value; });
  if (action === 'rule-field') updateAt(path, (node) => { node.field = target.value; node.operator = 'is'; node.value = target.value === 'favorite' ? 'true' : valuesForField(target.value)[0] || ''; });
  if (action === 'rule-operator') updateAt(path, (node) => { node.operator = target.value; });
  if (action === 'rule-value') updateAt(path, (node) => { node.value = target.value; });
  if (action === 'interval-bound') updateAt(path, (node) => { if (target.value) node[target.dataset.bound] = target.value; else delete node[target.dataset.bound]; });
  if (action === 'tags-mode') updateAt(path, (node) => { node.mode = target.value; });
  if (action === 'tags-values') updateAt(path, (node) => { node.values = target.value.split(',').map((value) => value.trim()).filter(Boolean); });
  if (state.parser) state.parser.applied = false;
  state.queryEdited = true;
  if (!['rule-value', 'interval-bound', 'tags-values'].includes(action)) renderBuilder();
  renderParser();
}

function setMessage(error) {
  state.message = error instanceof Error ? error.message : String(error);
  render();
}

app.innerHTML = `
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Fieldnote home"><span class="brand-mark">✦</span><span>fieldnote</span></a>
      <div class="topbar-note"><span class="status-dot"></span> Local catalog <span class="slash">/</span> SQLite</div>
    </header>
    <main id="main-content" tabindex="-1">
      <section class="intro">
        <div class="eyebrow">PHOTO SEARCH WORKBENCH <span>·</span> PRIVATE BY DESIGN</div>
        <h1>Find the feeling<br /><em>in your archive.</em></h1>
        <p class="intro-copy">Shape a search with plain language or build it precisely. Every criterion stays visible, editable, and close to the photographs it finds.</p>
        <div class="stats-row">
          <div><strong id="stat-total">—</strong><span>photographs</span></div>
          <div><strong id="stat-favorites">—</strong><span>favorites</span></div>
          <div><strong id="stat-locations">—</strong><span>locations</span></div>
        </div>
      </section>

      <section class="catalog-tools utility-panel" aria-labelledby="catalog-tools-title">
        <div class="utility-heading"><h2 id="catalog-tools-title">Catalog tools</h2><button id="export-catalog-button" class="small-button">Export catalog</button></div>
        <p class="utility-copy" id="catalog-import-help">Import a catalog JSON export, a photo array, or a { photos } object to replace the catalog.</p>
        <div class="catalog-import-form"><label for="catalog-file">Catalog JSON file</label><input id="catalog-file" type="file" accept=".json,application/json" aria-describedby="catalog-import-help" /><button id="import-catalog-button" class="small-button">Import catalog</button></div>
        <div id="catalog-message" class="utility-message" role="alert" aria-atomic="true"></div>
      </section>

      <section class="search-panel">
       <div class="panel-kicker"><span class="step-number">01</span><span>START WITH A PHRASE</span><span class="line"></span><span class="hint">deterministic phrase parser</span></div>
         <div class="phrase-meta">
           <label class="reference-date-control" for="reference-date"><span>Reference date for relative phrases</span><input id="reference-date" type="date" value="2025-11-15" min="0001-01-01" max="9999-12-31" required /></label>
         </div>
         <div class="phrase-row">
           <span class="search-symbol">⌕</span>
           <label class="sr-only" for="phrase-input">Phrase to interpret</label>
           <input id="phrase-input" placeholder="Try “mountains in 2024” or “coast AND sunset”" autocomplete="off" />
           <button id="parse-button" class="dark-button">Interpret phrase <span>↗</span></button>
         </div>
        <div id="parser-output" class="parser-output"></div>
        <div class="supported"><span>Try:</span> mountains in 2024 <b>·</b> beach OR forest <b>·</b> favorites after 2024-01-01 <b>·</b> near me</div>
      </section>

      <section class="builder-section">
        <div class="section-heading">
          <div><div class="panel-kicker"><span class="step-number">02</span><span>REFINE CRITERIA</span></div><h2>Query builder</h2></div>
          <div class="builder-actions"><button id="reset-button" class="text-button">Reset</button><button id="run-button" class="dark-button">Run search <span>→</span></button></div>
        </div>
         <div id="query-builder"></div>
         <div class="save-search-panel" aria-labelledby="save-search-title">
           <div><div class="panel-kicker"><span class="step-number">↳</span><span id="save-search-title">SAVE THIS SEARCH</span></div><p class="save-search-copy">Keep the current editable criteria and reference date for later.</p></div>
           <div class="save-search-form"><label class="sr-only" for="saved-search-name">Saved search name</label><input id="saved-search-name" maxlength="80" placeholder="Name this search…" /><button id="save-search-button" class="small-button">Save search</button></div>
           <div id="saved-searches" class="saved-searches" aria-live="polite"></div>
         </div>
         <div id="app-message" class="app-message" role="alert"></div>
      </section>

      <section class="history-section utility-panel" aria-labelledby="history-title">
        <div class="utility-heading"><h2 id="history-title">Search history</h2><button id="clear-history-button" class="text-button">Clear history</button></div>
        <p class="utility-copy">Select a recent search to load its criteria and run it again.</p>
        <div id="history-message" class="utility-message" role="status" aria-atomic="true"></div>
        <div id="search-history"></div>
      </section>

      <section class="results-section">
        <div class="results-heading"><div><div class="panel-kicker"><span class="step-number">03</span><span>MATCHING PHOTOGRAPHS</span></div><h2>Preview</h2></div><div class="results-tools"><span id="result-count" class="result-count" aria-live="polite"></span><select id="sort-select" aria-label="Sort photographs"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title A–Z</option></select></div></div>
        <div id="results-grid" class="results-grid"></div>
      </section>

      <section class="notes-section"><div class="notes-icon">✳</div><div><h3>A small, legible language layer</h3><p>This workbench intentionally supports a documented set of phrases. Ambiguous words such as “near me” and “recent” produce choices instead of pretending to know what you meant. The criteria remain the source of truth.</p></div><a href="https://summerofcode.withgoogle.com/programs/2026/projects/qyiUD0bH" target="_blank" rel="noreferrer">Read the source idea ↗</a></section>
    </main>
    <footer><span>FIELDNOTE / LOCAL PHOTO SEARCH</span><span>Generated placeholders · no uploads leave this machine</span></footer>
  </div>
`;

document.querySelector('#query-builder').addEventListener('change', handleBuilderAction);
document.querySelector('#query-builder').addEventListener('click', (event) => {
  if (event.target.closest('button[data-action]')) handleBuilderAction(event);
});
document.querySelector('#query-builder').addEventListener('input', (event) => {
  if (event.target.matches('[data-action="rule-value"]')) updateAt(pathFrom(event.target.dataset.path), (node) => { node.value = event.target.value; });
  if (event.target.matches('[data-action="interval-bound"]')) updateAt(pathFrom(event.target.dataset.path), (node) => { if (event.target.value) node[event.target.dataset.bound] = event.target.value; else delete node[event.target.dataset.bound]; });
  if (event.target.matches('[data-action="tags-values"]')) updateAt(pathFrom(event.target.dataset.path), (node) => { node.values = event.target.value.split(',').map((value) => value.trim()).filter(Boolean); });
  if (state.parser) state.parser.applied = false;
  state.queryEdited = true;
  renderParser();
});
document.querySelector('#phrase-input').addEventListener('input', (event) => { state.phrase = event.target.value; });
document.querySelector('#phrase-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') document.querySelector('#parse-button').click(); });
document.querySelector('#reference-date').addEventListener('change', (event) => {
  state.referenceDate = event.target.value;
  if (state.parser) state.parser.applied = false;
  render();
});
document.querySelector('#parse-button').addEventListener('click', () => parsePhrase().catch(setMessage));
document.querySelector('#run-button').addEventListener('click', () => runSearch().catch(setMessage));
document.querySelector('#reset-button').addEventListener('click', () => { state.query = emptyQuery(); state.parser = null; state.queryEdited = false; state.phrase = ''; state.message = ''; render(); runSearch().catch(setMessage); });
document.querySelector('#saved-search-name')?.addEventListener('input', (event) => { event.target.setCustomValidity(''); });
document.querySelector('#saved-search-name')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') saveSearch().catch(setMessage); });
document.querySelector('#save-search-button')?.addEventListener('click', () => saveSearch().catch(setMessage));
document.querySelector('#sort-select').addEventListener('change', (event) => { state.sort = event.target.value; runSearch().catch(setMessage); });
document.querySelector('#results-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-photo-id]');
  if (button) toggleFavorite(button.dataset.photoId).catch(setMessage);
});
document.querySelector('#parser-output').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="clarification"]');
  if (button) {
    const selected = JSON.parse(button.dataset.option);
    const clarification = state.parser.clarifications.find((item) => item.id === button.dataset.clarificationId);
    const branch = clarification?.branch;
    if (branch !== undefined && Number.isInteger(branch) && state.query.operator === 'OR' && state.query.children[branch]) state.query.children[branch] = selected;
    else state.query = { id: 'group-clarified', type: 'group', operator: 'AND', children: [...state.query.children, selected] };
    state.parser = { ...state.parser, applied: false, clarifications: state.parser.clarifications.filter((item) => item.id !== button.dataset.clarificationId) };
    state.queryEdited = false;
    state.message = '';
    render();
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'apply-interpretation') {
    if (!state.parser?.hasCriteria) return;
    if (state.parser.clarifications.length) {
      setMessage('Choose an option for each ambiguous term before applying the interpretation.');
      return;
    }
    if (state.parser.referenceDate !== state.referenceDate) {
      setMessage('Interpret the phrase again using the updated reference date.');
      return;
    }
    runSearch().catch(setMessage);
  }
  if (action === 'keep-editing') document.querySelector('#query-builder')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (action === 'close-review') {
    state.reviewOpen = false;
    renderParser();
    document.querySelector('#parse-button')?.focus();
  }
});
document.querySelector('#parser-output').addEventListener('change', (event) => {
  if (!event.target.matches('[data-reference-date]')) return;
  state.referenceDate = event.target.value;
  if (state.parser) state.parser.applied = false;
  render();
});

document.querySelector('#saved-searches').addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const saved = state.savedSearches.find((item) => String(item.id) === target.dataset.savedId);
  if (!saved) return;
  if (target.dataset.action === 'delete-saved') {
    deleteSavedSearch(target.dataset.savedId).catch(setMessage);
    return;
  }
  if (target.dataset.action === 'load-saved') {
    state.query = structuredClone(saved.query);
    state.referenceDate = saved.referenceDate;
    state.queryEdited = false;
    state.phrase = '';
    state.parser = null;
    state.reviewOpen = false;
    state.message = `Loaded “${saved.name}”.`;
    render();
    runSearch().catch(setMessage);
  }
});

document.querySelector('#export-catalog-button').addEventListener('click', () => exportCatalog().catch(setMessage));
document.querySelector('#import-catalog-button').addEventListener('click', () => importCatalog());
document.querySelector('#catalog-file').addEventListener('change', () => {
  state.catalogMessage = '';
  renderCatalogTools();
});
document.querySelector('#clear-history-button').addEventListener('click', () => clearSearchHistory().catch((error) => {
  state.historyMessage = error.message;
  renderSearchHistory();
}));
document.querySelector('#search-history').addEventListener('click', (event) => {
  const target = event.target.closest('[data-action="load-history"]');
  if (!target) return;
  const entry = state.searchHistory.find((item) => String(item.id) === target.dataset.historyId);
  if (!entry) return;
  state.query = structuredClone(entry.query);
  state.sort = entry.sort;
  state.phrase = '';
  state.parser = null;
  state.reviewOpen = false;
  state.queryEdited = false;
  state.message = 'Loaded a search from history.';
  render();
  document.querySelector('#run-button').focus();
  runSearch().catch(setMessage);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const details = event.target.closest?.('details[open]') || event.target.closest?.('[data-photo-card-id]')?.querySelector('details[open]');
  if (details) {
    details.open = false;
    details.closest('[data-photo-card-id]')?.setAttribute('aria-expanded', 'false');
    if (details.contains(document.activeElement)) details.querySelector('summary').focus();
    event.preventDefault();
    return;
  }
  if (state.reviewOpen) {
    state.reviewOpen = false;
    renderParser();
    document.querySelector('#parse-button')?.focus();
    event.preventDefault();
  }
});

loadCatalog().then(async () => {
  state.loading = false;
  render();
  await Promise.all([
    loadSavedSearches().catch((error) => { state.message = error.message; }),
    loadSearchHistory().catch((error) => { state.historyMessage = error.message; renderSearchHistory(); }),
  ]);
  await runSearch();
}).catch(setMessage);
