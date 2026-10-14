import { escapeHtml, renderMarkdown } from './markdown';

type SymbolKind = 'class' | 'interface' | 'function' | 'namespace' | 'type' | 'variable';
type MemberKind = 'method' | 'property' | 'constructor';

interface SourceLocation {
  file: string;
  line: number;
  endLine: number;
}

interface Parameter {
  name: string;
  type: string;
  description: string;
  optional: boolean;
  rest: boolean;
}

interface TypeParameter {
  name: string;
  constraint?: string;
  default?: string;
}

interface Overload {
  signature: string;
  summary: string;
  description: string;
  parameters: Parameter[];
  returns?: string;
  typeParameters?: TypeParameter[];
  tags?: Array<{ name: string; text: string }>;
  example?: string;
  source: SourceLocation;
}

interface Member {
  id: string;
  name: string;
  kind: MemberKind;
  summary: string;
  description?: string;
  tags?: Array<{ name: string; text: string }>;
  example?: string;
  signature: string;
  parameters: Parameter[];
  returns?: string;
  source: SourceLocation;
  static?: boolean;
  optional?: boolean;
  deprecated?: boolean;
  typeParameters?: TypeParameter[];
  overloads?: Overload[];
  inheritedFrom?: string;
}

interface SymbolEntry {
  id: string;
  name: string;
  kind: SymbolKind;
  summary: string;
  description: string;
  namespace?: string;
  signatures: string[];
  parameters?: Parameter[];
  returns?: string;
  tags?: Array<{ name: string; text: string }>;
  example?: string;
  typeParameters?: TypeParameter[];
  overloads?: Overload[];
  source: SourceLocation;
  members: Member[];
}

interface ApiVersion {
  version: string;
  label: 'Latest' | 'Previous';
  sourcePath: string;
  sourceText: string;
  symbols: SymbolEntry[];
}

interface ApiDocument {
  packageName: string;
  versions: ApiVersion[];
}

interface ApiDiagnostic {
  file: string;
  line?: number;
  column?: number;
  code: number;
  category: 'warning' | 'error' | 'suggestion' | 'message';
  message: string;
}

interface DiagnosticsDocument {
  schemaVersion: number;
  packageName: string;
  hasErrors: boolean;
  versions: Array<{ version: string; label: string; sourcePath: string; diagnostics: ApiDiagnostic[] }>;
}

interface Route {
  version: string;
  symbolId: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  compare: boolean;
  diagnostics: boolean;
  anchor: string | null;
}

interface SearchResult {
  version: ApiVersion;
  symbol: SymbolEntry;
}

interface AppState {
  api: ApiDocument | null;
  diagnostics: DiagnosticsDocument | null;
  route: Route;
  query: string;
  sidebarOpen: boolean;
  lastFocused: HTMLElement | null;
}

const appMount = document.querySelector<HTMLDivElement>('#app');
if (!appMount) throw new Error('Application mount point is missing.');
const app: HTMLDivElement = appMount;

const state: AppState = {
  api: null,
  diagnostics: null,
  route: readRoute(),
  query: '',
  sidebarOpen: false,
  lastFocused: null,
};

void loadApi();

async function loadApi(): Promise<void> {
  try {
    const [apiResponse, diagnosticsResponse] = await Promise.all([
      fetch('/generated/api.json'), fetch('/generated/diagnostics.json'),
    ]);
    if (!apiResponse.ok) throw new Error(`API request failed with status ${apiResponse.status}`);
    state.api = await apiResponse.json() as ApiDocument;
    state.diagnostics = diagnosticsResponse.ok ? await diagnosticsResponse.json() as DiagnosticsDocument : null;
    if (!state.api.versions.some(version => version.version === state.route.version)) {
      state.route.version = state.api.versions[0]?.version ?? '';
    }
    render();
  } catch (error) {
    app.innerHTML = `
      <main class="load-error page-wrap">
        <div class="error-mark" aria-hidden="true">!</div>
        <p class="eyebrow">Workbench unavailable</p>
        <h1>Could not load the generated API.</h1>
        <p>Make sure <code>/generated/api.json</code> is available and try again.</p>
        <button class="button button-primary" data-action="retry" type="button">Retry</button>
        <p class="error-detail">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
      </main>`;
    app.querySelector('[data-action="retry"]')?.addEventListener('click', () => void loadApi());
  }
}

function readRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash.replace(/^#/, '');
  const parts = hash.split('/');
  const isSource = params.has('source');
  const anchorParts = decodeAnchor(hash);
  const anchorKind = anchorParts?.kind;
  const anchorSymbol = anchorParts && ['symbol', 'member', 'overload'].includes(anchorParts.kind) ? anchorParts.parts[1] : null;
  const symbolId = params.get('symbol') ?? anchorSymbol ?? (parts[0] === 'reference'
    ? decodeRoutePart(parts.slice(1).join('/'))
    : hash.startsWith('symbol-') ? decodeRoutePart(hash.slice('symbol-'.length)) : null);
  const lineMatch = hash.match(/^L(\d+)$/i);
  return {
    version: params.get('version') ?? anchorParts?.parts[0] ?? '5.99.0',
    symbolId,
    sourceFile: isSource ? params.get('source') : null,
    sourceLine: lineMatch ? Number(lineMatch[1]) : (params.has('line') ? Number(params.get('line')) : null),
    compare: params.get('compare') === 'true' || hash === 'compare' || anchorKind === 'diff',
    diagnostics: params.get('diagnostics') === 'true' || hash === 'diagnostics',
    anchor: isSource ? params.get('anchor') : hash && !lineMatch && hash !== 'compare' ? decodeRoutePart(hash) : null,
  };
}

function decodeAnchor(anchor: string): { kind: string; parts: string[] } | null {
  const separator = anchor.indexOf('-');
  if (separator < 1) return null;
  try {
    const value = JSON.parse(decodeURIComponent(anchor.slice(separator + 1).replace(/_/g, '%'))) as unknown;
    return Array.isArray(value) && value.every(part => typeof part === 'string')
      ? { kind: anchor.slice(0, separator), parts: value } : null;
  } catch {
    return null;
  }
}

function decodeRoutePart(value: string): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function render(): void {
  if (!state.api) return;
  const version = getVersion(state.route.version) ?? state.api.versions[0];
  if (!version) {
    app.innerHTML = renderEmptyDetail('No documentation versions found.', 'Generate the API document and reload the workbench.');
    return;
  }
  const previousVersion = state.api.versions.find(item => item.version !== version.version);
  const filtered = getFilteredSymbols(version, state.query);
  const searchResults = getSearchResults(state.query, version);
  const sourceView = state.route.sourceFile ? getSourceView(version) : null;

  app.innerHTML = `
    <div class="app-shell ${state.sidebarOpen ? 'sidebar-is-open' : ''}">
      ${renderTopbar(version)}
      <div class="shell-body">
        ${renderSidebar(version, searchResults)}
        <main class="main-content" id="main-content" tabindex="-1">
          ${state.route.diagnostics ? renderDiagnostics(state.diagnostics) : state.route.sourceFile ? sourceView ? renderSourceView(sourceView, version) : renderEmptyDetail('Source not found', 'This file is not bundled with the selected release.') : state.route.compare ? renderCompare(state.api.versions.find(item => item.label === 'Latest') ?? version, state.api.versions.find(item => item.label === 'Previous') ?? previousVersion) : renderContent(version, filtered)}
        </main>
      </div>
    </div>`;
  attachEvents();
  const target = sourceView ? `L${sourceView.line}` : state.route.anchor;
  if (target) requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }));
}

function renderTopbar(version: ApiVersion | undefined): string {
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="mobile-menu button-icon" type="button" data-action="toggle-sidebar" aria-label="${state.sidebarOpen ? 'Close' : 'Open'} navigation" aria-controls="api-sidebar" aria-expanded="${state.sidebarOpen}">
          <span></span><span></span><span></span>
        </button>
        <a class="brand" href="${routeHref(version?.version ?? state.route.version, null)}" data-nav="home" aria-label="webpack API workbench home">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>webpack</strong><small>API workbench</small></span>
        </a>
      </div>
      <div class="topbar-meta">
        <span class="status-dot" aria-hidden="true"></span>
        <span>Generated reference</span>
        <a href="https://summerofcode.withgoogle.com/programs/2026/projects/ikzNNgeA" target="_blank" rel="noreferrer">Project</a>
        <a href="${diagnosticsHref()}" data-nav="diagnostics" class="diagnostics-toplink">Diagnostics</a>
      </div>
    </header>`;
}

function renderSidebar(version: ApiVersion | undefined, results: SearchResult[]): string {
  const selectedVersion = version?.version ?? state.route.version;
  const symbolMarkup = results.length > 0
    ? results.map(result => renderSidebarSymbol(result)).join('')
    : `<div class="sidebar-empty"><span class="empty-icon" aria-hidden="true">⌕</span><p>No symbols found</p><small>Try a different search term.</small></div>`;

  return `
    <button class="drawer-backdrop" type="button" data-action="close-sidebar" aria-label="Close navigation" tabindex="-1"></button>
    <aside class="sidebar" id="api-sidebar" aria-label="API navigation">
      <div class="sidebar-scroll">
        <section class="product-card">
          <div class="product-icon" aria-hidden="true">w</div>
          <div><label class="product-kicker" for="product-select">Package</label><select id="product-select" aria-label="API product"><option>webpack</option></select><span class="product-version">TypeScript API</span></div>
        </section>
        <label class="version-label" for="version-select">Documentation version</label>
        <div class="version-select-wrap">
          <select id="version-select" aria-label="Documentation version" data-action="version">
            ${state.api?.versions.map(item => `<option value="${escapeAttribute(item.version)}" ${item.version === selectedVersion ? 'selected' : ''}>${item.label} · ${item.version}</option>`).join('') ?? ''}
          </select>
          <span aria-hidden="true">⌄</span>
        </div>
        <a class="compare-link ${state.route.compare ? 'is-active' : ''}" href="${compareHref(selectedVersion)}" data-nav="compare">
          <span class="compare-icon" aria-hidden="true">◫</span><span>Compare versions</span><span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="compare-link ${state.route.diagnostics ? 'is-active' : ''}" href="${diagnosticsHref()}" data-nav="diagnostics">
          <span class="compare-icon" aria-hidden="true">!</span><span>Build diagnostics</span><span class="arrow" aria-hidden="true">→</span>
        </a>
        <div class="sidebar-divider"></div>
        <label class="search-box" for="symbol-search">
          <span aria-hidden="true">⌕</span>
          <input id="symbol-search" type="search" aria-label="Search symbols and member names" placeholder="Search symbols & members..." value="${escapeAttribute(state.query)}" autocomplete="off" />
          <kbd>/</kbd>
        </label>
        ${state.query.trim() ? '<p class="search-scope">Searching all documentation versions</p>' : ''}
        <div class="reference-heading"><span>${state.query.trim() ? 'All-version results' : 'Reference'}</span><span class="count-pill" role="status" aria-label="${results.length} matching symbols">${results.length}</span></div>
        <nav class="symbol-list" aria-label="Symbols">${symbolMarkup}</nav>
      </div>
      <footer class="sidebar-footer"><span class="footer-spark" aria-hidden="true">✦</span><span>Generated from TypeScript declarations</span></footer>
    </aside>`;
}

function renderSidebarSymbol(result: SearchResult): string {
  const { symbol, version } = result;
  const selected = !state.route.compare && state.route.symbolId === symbol.id && state.route.version === version.version;
  const memberMatches = state.query.trim() ? symbol.members.filter(member => searchableMemberText(member).includes(state.query.trim().toLowerCase())) : [];
  return `
    <div class="symbol-result"><a class="symbol-item ${selected ? 'is-selected' : ''}" ${selected ? 'aria-current="page"' : ''} href="${routeHref(version.version, symbol.id)}" data-nav="symbol" data-symbol-id="${escapeAttribute(symbol.id)}">
      <span class="kind-badge kind-${symbol.kind}" title="${symbol.kind}">${kindLabel(symbol.kind)}</span>
      <span class="symbol-name">${escapeHtml(symbol.id)}</span>
      <span class="result-version">${escapeHtml(version.label)} · v${escapeHtml(version.version)}</span>
      ${memberMatches.length ? `<span class="match-count">${memberMatches.length}</span>` : ''}
    </a>${memberMatches.length ? `<div class="search-member-results">${memberMatches.slice(0, 4).map(member => `<a href="${routeHref(version.version, symbol.id, memberAnchor(version.version, symbol.id, member.id))}" data-nav="member">↳ ${escapeHtml(member.name)}</a>`).join('')}</div>` : ''}</div>`;
}

function renderContent(version: ApiVersion | undefined, filteredSymbols: SymbolEntry[]): string {
  if (!version) return renderEmptyDetail('No documentation version is available.', 'Select a version from the sidebar to begin.');
  const selected = findSymbol(version, state.route.symbolId);
  if (state.query.trim() && getSearchResults(state.query, version).length === 0 && !selected) {
    return renderEmptyDetail(`No results for “${state.query}”`, 'Try searching for a symbol, member, kind, or namespace.', 'Clear search');
  }
  if (!selected) {
    if (state.route.symbolId) return renderEmptyDetail(`“${state.route.symbolId}” is not available`, `This symbol is not in webpack ${version.version}. Choose another release or select an entry in the reference list.`);
    return renderOverview(version, filteredSymbols);
  }
  return renderDetail(selected, version);
}

function renderDiagnostics(document: DiagnosticsDocument | null): string {
  const versions = document?.versions ?? [];
  const diagnostics = versions.flatMap(version => version.diagnostics.map(item => ({ ...item, version })));
  return `<div class="content-wrap diagnostics-wrap">
    <div class="breadcrumbs"><span>webpack</span><span aria-hidden="true">/</span><strong>Build diagnostics</strong></div>
    <header class="diagnostics-header"><p class="eyebrow">Compiler feedback</p><h1>Build diagnostics</h1><p>Problems found while parsing the bundled declaration samples. Regenerate after editing a sample to refresh this page.</p></header>
    <div class="diagnostic-summary"><strong>${diagnostics.length}</strong><span>${diagnostics.length === 1 ? 'diagnostic' : 'diagnostics'} · ${document?.hasErrors ? 'errors present' : 'generation is clean'}</span></div>
    ${diagnostics.length ? `<div class="diagnostic-list">${diagnostics.map(item => `<article class="diagnostic-card diagnostic-${escapeAttribute(item.category)}"><div><span class="diagnostic-category">${escapeHtml(item.category)}</span><strong>${escapeHtml(item.version.label)} · v${escapeHtml(item.version.version)}</strong></div><h2>${escapeHtml(item.message)}</h2><a href="${sourceHref(item.version, { file: item.file, line: item.line ?? 1, endLine: item.line ?? 1 })}" data-nav="diagnostic-source"><code>${escapeHtml(item.file)}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''}</code></a><span class="diagnostic-code">TS${item.code}</span></article>`).join('')}</div>` : `<div class="diagnostics-clean"><span class="status-dot" aria-hidden="true"></span><h2>No compiler diagnostics</h2><p>Both bundled declaration versions parsed successfully. Unresolved references and malformed syntax will appear here after regeneration.</p></div>`}
  </div>`;
}

function renderOverview(version: ApiVersion, symbols: SymbolEntry[]): string {
  const kinds = countKinds(version.symbols);
  return `
    <div class="content-wrap overview-wrap">
      <div class="breadcrumbs"><span>webpack</span><span aria-hidden="true">/</span><strong>Reference</strong></div>
      <section class="overview-hero">
        <div class="hero-orb" aria-hidden="true"><span>⌘</span></div>
        <div><p class="eyebrow">${version.label} release · v${escapeHtml(version.version)}</p><h1>Webpack API reference</h1><p class="hero-summary">Explore the public TypeScript surface of webpack. Search symbols, inspect members, and compare releases from one focused workbench.</p></div>
      </section>
      <div class="overview-grid">
        <article class="stat-card stat-card-accent"><span class="stat-label">Public symbols</span><strong>${version.symbols.length}</strong><span class="stat-note">across the ${version.label.toLowerCase()} API</span></article>
        <article class="stat-card"><span class="stat-label">Members</span><strong>${version.symbols.reduce((total, symbol) => total + symbol.members.length, 0)}</strong><span class="stat-note">documented class and interface members</span></article>
        <article class="stat-card"><span class="stat-label">Source files</span><strong>1</strong><span class="stat-note">bundled declaration source</span></article>
      </div>
      <section class="overview-section"><div class="section-heading"><div><p class="eyebrow">Start exploring</p><h2>Browse the reference</h2></div><span class="muted">${symbols.length} visible entries</span></div><div class="quick-links">${symbols.slice(0, 6).map(symbol => `<a href="${routeHref(version.version, symbol.id)}" data-nav="symbol" class="quick-link"><span class="kind-badge kind-${symbol.kind}">${kindLabel(symbol.kind)}</span><span><strong>${escapeHtml(symbol.name)}</strong><small>${escapeHtml(symbol.summary || 'View API details')}</small></span><span aria-hidden="true">→</span></a>`).join('')}</div></section>
      <section class="overview-section overview-footer-section"><div><p class="eyebrow">Surface map</p><h2>What’s in this release?</h2></div><div class="kind-breakdown">${Object.entries(kinds).map(([kind, count]) => `<span><i class="kind-dot kind-${kind}"></i>${kindLabel(kind as SymbolKind)} <strong>${count}</strong></span>`).join('')}</div></section>
    </div>`;
}

function renderDetail(symbol: SymbolEntry, version: ApiVersion): string {
  const namespaceCrumbs = symbol.namespace ? symbol.namespace.split('.').filter(Boolean) : [];
  const breadcrumbs = [...(namespaceCrumbs.length ? namespaceCrumbs : symbol.id === 'webpack' ? [] : ['webpack']), symbol.name].map((crumb, index, items) => `<span class="${index === items.length - 1 ? 'current' : ''}">${escapeHtml(crumb)}</span>${index < items.length - 1 ? '<span aria-hidden="true">/</span>' : ''}`).join('');
  const memberSection = symbol.members.length > 0 ? `<section class="detail-section members-section"><div class="section-heading"><div><p class="eyebrow">${symbol.kind === 'namespace' ? 'Nested entries' : 'Public surface'}</p><h2>${symbol.kind === 'namespace' ? 'Namespace entries' : 'Members'}</h2></div><span class="muted">${symbol.members.length} ${symbol.members.length === 1 ? 'item' : 'items'}</span></div><div class="member-grid">${symbol.members.map(member => renderMember(member, version, symbol.id)).join('')}</div></section>` : '';
  const parameterSection = symbol.parameters?.length ? renderParameters(symbol.parameters) : '';
  const typeParameterSection = renderTypeParameters(symbol.typeParameters);
  return `
    <div class="content-wrap detail-wrap" id="${symbolAnchor(version.version, symbol.id)}">
      <div class="breadcrumbs">${breadcrumbs}</div>
      <article class="detail-article">
        <header class="detail-header">
          <div class="title-row"><span class="kind-badge kind-${symbol.kind}">${kindLabel(symbol.kind)}</span><span class="title-path">${symbol.namespace ? escapeHtml(symbol.namespace) + '.' : ''}</span></div>
          <h1>${escapeHtml(symbol.name)} <a class="permalink" href="${routeHref(version.version, symbol.id)}" data-nav="symbol" aria-label="Permanent link to ${escapeAttribute(symbol.id)}">#</a></h1>
          <div class="summary markdown">${renderMarkdown(symbol.summary || 'No summary available for this symbol.')}</div>
          <div class="detail-meta"><a class="source-link" href="${sourceHref(version, symbol.source, symbol.id)}" target="_blank" rel="noreferrer"><span aria-hidden="true">↗</span> View source <code>${escapeHtml(symbol.source.file)}:${symbol.source.line}</code></a><span class="meta-divider"></span><span>v${escapeHtml(version.version)}</span></div>
        </header>
         ${symbol.description ? `<section class="description detail-section"><p class="eyebrow">Overview</p><div class="markdown">${renderMarkdown(symbol.description)}</div></section>` : ''}
          ${symbol.signatures.length ? `<section class="detail-section"><div class="section-heading"><div><p class="eyebrow">${symbol.signatures.length > 1 ? 'Overloads' : 'Signature'}</p><h2>${symbol.signatures.length > 1 ? `${symbol.signatures.length} call signatures` : 'Type signature'}</h2></div></div><div class="signature-stack">${symbol.signatures.map((signature, index) => `<div class="signature-block" id="${anchorId('signature', version.version, symbol.id, String(index + 1))}"><span class="signature-number">${symbol.signatures.length > 1 ? `0${index + 1}` : 'TS'}</span><code>${escapeHtml(signature)}</code></div>`).join('')}</div></section>` : ''}
         ${typeParameterSection}
         ${parameterSection}
         ${symbol.returns ? `<section class="returns detail-section"><p class="eyebrow">Returns</p><div class="return-value"><code>${escapeHtml(symbol.returns)}</code><span>Return type</span></div></section>` : ''}
         ${renderOverloads(symbol.overloads, version, false, symbol.id)}
         ${symbol.example ? `<section class="detail-section"><div class="section-heading"><div><p class="eyebrow">Example</p><h2>Usage</h2></div></div><pre class="code-example"><code>${escapeHtml(symbol.example)}</code></pre></section>` : ''}
        ${renderTags(symbol.tags, symbol.example)}
        ${memberSection}
      </article>
    </div>`;
}

function renderMember(member: Member, version: ApiVersion, ownerId: string): string {
  const nested = findSymbol(version, member.id);
  const inheritedOwner = findSymbol(version, member.inheritedFrom ?? null);
  const memberId = memberAnchor(version.version, ownerId, member.id);
  const source = sourceHref(version, member.source, ownerId, memberId);
  const matches = state.query.trim() && searchableMemberText(member).includes(state.query.trim().toLowerCase());
  return `<article class="member-card ${matches ? 'member-match' : ''}" id="${memberId}">
    <div class="member-card-top"><span class="member-kind">${nested?.kind ?? member.kind}</span>
      ${member.static ? '<span class="static-label">static</span>' : ''}
      ${member.optional ? '<span class="optional-label">optional</span>' : ''}
      ${member.deprecated ? '<span class="optional-label">deprecated</span>' : ''}
      ${renderInheritedFrom(member.inheritedFrom, inheritedOwner, version)}
      <a class="member-source" href="${source}" target="_blank" rel="noreferrer" aria-label="View source for ${escapeAttribute(member.name)}">↗</a>
    </div>
    <h3>${nested ? `<a href="${routeHref(version.version, nested.id)}" data-nav="symbol">${escapeHtml(member.name)} →</a>` : escapeHtml(member.name)} <a class="permalink" href="${anchoredHref(version.version, ownerId, memberId)}" data-nav="symbol" aria-label="Permanent link to ${escapeAttribute(member.id)}">#</a></h3>
    ${member.description || member.summary ? `<div class="markdown member-description">${renderMarkdown(member.description || member.summary)}</div>` : ''}
    <div class="member-signature"><code>${escapeHtml(member.signature)}</code></div>
    ${renderTypeParameters(member.typeParameters)}
    ${member.parameters.length ? renderParameters(member.parameters) : ''}
    ${member.returns ? `<p class="member-return">Returns <code>${escapeHtml(member.returns)}</code></p>` : ''}
    ${renderOverloads(member.overloads, version, true, ownerId, member.id)}
    ${member.example ? `<pre class="code-example"><code>${escapeHtml(member.example)}</code></pre>` : ''}
    ${renderTags(member.tags, member.example)}
  </article>`;
}

function renderTypeParameters(typeParameters: TypeParameter[] | undefined): string {
  if (!typeParameters?.length) return '';
  return `<section class="type-parameters detail-section"><div class="section-heading"><div><p class="eyebrow">Generics</p><h2>Type parameters</h2></div><span class="muted">${typeParameters.length} ${typeParameters.length === 1 ? 'parameter' : 'parameters'}</span></div><div class="type-parameter-list">${typeParameters.map(parameter => `<div class="type-parameter"><code>${escapeHtml(parameter.name)}</code>${parameter.constraint ? `<span><b>extends</b> <code>${escapeHtml(parameter.constraint)}</code></span>` : ''}${parameter.default ? `<span><b>default</b> <code>${escapeHtml(parameter.default)}</code></span>` : ''}</div>`).join('')}</div></section>`;
}

function renderOverloads(overloads: Overload[] | undefined, version: ApiVersion, compact = false, symbolId = '', memberId?: string): string {
  if (!overloads?.length) return '';
  return `<section class="overloads detail-section ${compact ? 'overloads-compact' : ''}"><div class="section-heading"><div><p class="eyebrow">Overload details</p><h2>${overloads.length} ${overloads.length === 1 ? 'overload' : 'overloads'}</h2></div></div><div class="overload-list">${overloads.map((overload, index) => `<article class="overload-card" id="${overloadAnchor(version.version, symbolId, index, memberId)}">
    <div class="overload-heading"><a class="signature-number" href="${anchoredHref(version.version, symbolId, overloadAnchor(version.version, symbolId, index, memberId))}" data-nav="symbol" aria-label="Permanent link to overload ${index + 1}">${String(index + 1).padStart(2, '0')}</a><code>${escapeHtml(overload.signature)}</code></div>
    ${overload.description || overload.summary ? `<div class="markdown overload-description">${renderMarkdown(overload.description || overload.summary)}</div>` : ''}
    ${renderTypeParameters(overload.typeParameters)}
    ${overload.parameters.length ? renderParameters(overload.parameters) : ''}
    ${overload.returns ? `<p class="overload-return">Returns <code>${escapeHtml(overload.returns)}</code></p>` : ''}
    ${overload.example ? `<pre class="code-example"><code>${escapeHtml(overload.example)}</code></pre>` : ''}
    ${renderTags(overload.tags, overload.example)}
    <a class="overload-source" href="${sourceHref(version, overload.source, symbolId, overloadAnchor(version.version, symbolId, index, memberId))}" target="_blank" rel="noreferrer"><span aria-hidden="true">↗</span> View overload source <code>${escapeHtml(overload.source.file)}:${overload.source.line}</code></a>
  </article>`).join('')}</div></section>`;
}

function renderInheritedFrom(ownerId: string | undefined, owner: SymbolEntry | undefined, version: ApiVersion): string {
  if (!ownerId) return '';
  const label = owner ? `<a href="${routeHref(version.version, owner.id)}" data-nav="symbol">${escapeHtml(owner.id)}</a>` : `<span>${escapeHtml(ownerId)}</span>`;
  return `<span class="inherited-label">Inherited from ${label}</span>`;
}

function renderTags(tags: SymbolEntry['tags'], example?: string): string {
  const visible = tags?.filter(tag => tag.name !== 'param' && !(tag.name === 'example' && tag.text === example)) ?? [];
  return visible.length ? `<div class="tag-list">${visible.map(tag => `<div class="tag"><b>@${escapeHtml(tag.name)}</b>${tag.name === 'example' ? `<pre class="code-example"><code>${escapeHtml(tag.text)}</code></pre>` : `<div class="markdown">${renderMarkdown(tag.text)}</div>`}</div>`).join('')}</div>` : '';
}

function renderParameters(parameters: Parameter[]): string {
  return `<section class="detail-section parameters-section"><div class="section-heading"><div><p class="eyebrow">Inputs</p><h2>Parameters</h2></div><span class="muted">${parameters.length} ${parameters.length === 1 ? 'parameter' : 'parameters'}</span></div><div class="table-wrap"><table><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead><tbody>${parameters.map(parameter => `<tr><th scope="row"><code>${parameter.rest ? '...' : ''}${escapeHtml(parameter.name)}${parameter.optional ? '?' : ''}</code>${parameter.rest || parameter.optional ? `<span class="parameter-flags">${parameter.rest ? 'rest' : ''}${parameter.rest && parameter.optional ? ', ' : ''}${parameter.optional ? 'optional' : ''}</span>` : ''}</th><td><code>${escapeHtml(parameter.type)}</code></td><td><div class="markdown">${renderMarkdown(parameter.description || '—')}</div></td></tr>`).join('')}</tbody></table></div></section>`;
}

function renderEmptyDetail(title: string, description: string, action?: string): string {
  return `<div class="content-wrap empty-wrap"><div class="empty-state"><div class="empty-orb" aria-hidden="true">⌁</div><p class="eyebrow">Reference navigator</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>${action ? '<button class="button button-primary" data-action="clear-search" type="button">Clear search</button>' : '<span class="empty-hint">Select a symbol from the reference list to see its API details.</span>'}</div></div>`;
}

function renderCompare(latest: ApiVersion | undefined, previous: ApiVersion | undefined): string {
  if (!latest || !previous) return renderEmptyDetail('Comparison unavailable', 'Two generated versions are required to compare the API.');
  const comparison = compareVersions(latest, previous);
  return `<div class="content-wrap compare-wrap">
    <div class="breadcrumbs"><span>webpack</span><span aria-hidden="true">/</span><strong>Compare versions</strong></div>
    <header class="compare-header"><div><p class="eyebrow">Surface diff</p><h1>Compare API versions</h1><p>See what changed between <strong>${escapeHtml(previous.version)}</strong> and <strong>${escapeHtml(latest.version)}</strong>.</p></div></header>
    <div class="release-columns">${[previous, latest].map(version => `<article class="release-card">
      <p class="eyebrow">${version.label}</p><h2>v${escapeHtml(version.version)}</h2>
      <dl><div><dt>Symbols</dt><dd>${version.symbols.length}</dd></div>
        <div><dt>Members</dt><dd>${version.symbols.reduce((count, symbol) => count + symbol.members.length, 0)}</dd></div>
        <div><dt>Classes</dt><dd>${version.symbols.filter(symbol => symbol.kind === 'class').length}</dd></div>
        <div><dt>Interfaces</dt><dd>${version.symbols.filter(symbol => symbol.kind === 'interface').length}</dd></div></dl>
    </article>`).join('')}</div>
    <div class="compare-stats">${(['added', 'removed', 'changed', 'common'] as const).map(key => `<article><span class="diff-icon diff-${key === 'common' ? 'same' : key}">${key === 'added' ? '+' : key === 'removed' ? '−' : key === 'changed' ? '✦' : '='}</span><div><strong>${comparison[key].length}</strong><span>${key === 'common' ? 'Unchanged' : key[0]?.toUpperCase() + key.slice(1)}</span></div></article>`).join('')}</div>
    <section class="compare-section"><div class="section-heading"><div><p class="eyebrow">Symbol changes</p><h2>Release diff</h2></div><span class="muted">${comparison.added.length + comparison.removed.length + comparison.changed.length} changes</span></div>
      <p class="comparison-note">API shape and documentation changes; source-line movement is ignored.</p>
      <div class="diff-list">
        ${renderDiffGroup(`Added in ${latest.version}`, 'added', comparison.added, latest, previous)}
        ${renderDiffGroup(`Removed from ${latest.version}`, 'removed', comparison.removed, latest, previous)}
        ${renderDiffGroup('Changed between versions', 'changed', comparison.changed, latest, previous)}
      </div>
    </section>
  </div>`;
}

function renderDiffGroup(title: string, kind: 'added' | 'removed' | 'changed', ids: string[], latest: ApiVersion, previous: ApiVersion): string {
  const rows = ids.map(id => {
    const current = findSymbol(latest, id);
    const old = findSymbol(previous, id);
    const item = current ?? old;
    if (!item) return '';
    const memberChanges = current && old ? describeMemberChanges(current, old) : '';
    const diffVersion = current ? latest.version : previous.version;
    return `<div class="diff-entry" id="${diffRowAnchor(diffVersion, id)}"><a class="diff-permalink permalink" href="${compareHref(latest.version).replace('#compare', `#${diffRowAnchor(diffVersion, id)}`)}" data-nav="compare" aria-label="Permanent link to comparison for ${escapeAttribute(id)}">#</a><a class="diff-row" href="${routeHref(diffVersion, id)}" data-nav="symbol">
      <span class="kind-badge kind-${item.kind}">${kindLabel(item.kind)}</span><strong>${escapeHtml(id)}</strong>
      <span class="diff-detail">${kind === 'changed' ? 'API or documentation updated' : escapeHtml(item.summary || 'Public API symbol')}</span><span aria-hidden="true">→</span>
    </a>${kind === 'changed' ? renderSignatureComparison(current, old, previous.version, latest.version) : ''}${memberChanges ? `<p class="member-diff">${memberChanges}</p>` : ''}</div>`;
  }).join('');
  return `<section class="diff-group"><div class="diff-group-title"><span class="diff-icon diff-${kind}">${kind === 'added' ? '+' : kind === 'removed' ? '−' : '✦'}</span><h3>${escapeHtml(title)}</h3><span>${ids.length}</span></div>${rows || `<div class="no-diff">No ${kind} symbols.</div>`}</section>`;
}

function renderSignatureComparison(current: SymbolEntry | undefined, old: SymbolEntry | undefined, oldVersion: string, newVersion: string): string {
  const id = current?.id ?? old!.id;
  const before = getSignatures(old);
  const after = getSignatures(current);
  const pairs = Array.from({ length: Math.max(before.length, after.length) }, (_, index) => ({
    before: before[index] as string | undefined,
    after: after[index] as string | undefined,
    anchor: diffRowAnchor(newVersion, id, index),
  }));
  const memberIds = new Set([...(old?.members ?? []).map(member => member.id), ...(current?.members ?? []).map(member => member.id)]);
  for (const memberId of memberIds) {
    const previous = old?.members.find(member => member.id === memberId);
    const latest = current?.members.find(member => member.id === memberId);
    if (previous && latest && JSON.stringify(comparableMember(previous)) === JSON.stringify(comparableMember(latest))) continue;
    const a = previous?.overloads?.length ? previous.overloads.map(overload => overload.signature) : previous ? [previous.signature] : [];
    const b = latest?.overloads?.length ? latest.overloads.map(overload => overload.signature) : latest ? [latest.signature] : [];
    for (let index = 0; index < Math.max(a.length, b.length); index++) pairs.push({
      before: a[index], after: b[index], anchor: anchorId('diff', newVersion, id, memberId, String(index + 1)),
    });
  }
  const rows = pairs.map(({ before: a, after: b, anchor }, index) => `
    <div class="signature-diff-row" id="${anchor}">
      <span class="signature-diff-index">${String(index + 1).padStart(2, '0')}</span>
      <code>${escapeHtml(a ?? 'Not present')}</code>
      <code>${escapeHtml(b ?? 'Not present')}</code>
    </div>`).join('');
  return `<div class="signature-diff" aria-label="Signatures for ${escapeAttribute(id)}"><div class="signature-diff-head"><span></span><strong>v${escapeHtml(oldVersion)}</strong><strong>v${escapeHtml(newVersion)}</strong></div>${rows}</div>`;
}

function describeMemberChanges(current: SymbolEntry, old: SymbolEntry): string {
  const additions = current.members.filter(member => !old.members.some(item => item.id === member.id));
  const removals = old.members.filter(member => !current.members.some(item => item.id === member.id));
  const changes = current.members.filter(member => old.members.some(item => item.id === member.id && JSON.stringify(comparableMember(item)) !== JSON.stringify(comparableMember(member))));
  return [
    additions.length ? `Added: ${additions.map(member => member.name).join(', ')}` : '',
    removals.length ? `Removed: ${removals.map(member => member.name).join(', ')}` : '',
    changes.length ? `Changed: ${changes.map(member => member.name).join(', ')}` : '',
  ].filter(Boolean).map(escapeHtml).join('<br />');
}

function renderSourceView(source: { file: string; text: string; line: number }, version: ApiVersion): string {
  const lines = source.text.split('\n');
  return `<div class="content-wrap source-wrap"><div class="breadcrumbs"><a href="${routeHref(version.version, state.route.symbolId)}" data-nav="symbol">Reference</a><span aria-hidden="true">/</span><strong>Source</strong></div><header class="source-header"><div><p class="eyebrow">Bundled declaration source</p><h1>${escapeHtml(source.file)}</h1><p>v${escapeHtml(version.version)} · ${lines.length} lines</p></div><a class="button button-quiet" href="${routeHref(version.version, state.route.symbolId)}" data-nav="symbol">← Back to reference</a></header><div class="source-code" aria-label="Source code">${lines.map((line, index) => `<div class="source-line ${index + 1 === source.line ? 'is-target' : ''}" id="L${index + 1}"><a href="#L${index + 1}" aria-label="Line ${index + 1}">${index + 1}</a><code>${escapeHtml(line) || ' '}</code></div>`).join('')}</div></div>`;
}

function getSourceView(version: ApiVersion | undefined): { file: string; text: string; line: number } | null {
  if (!version || !state.route.sourceFile) return null;
  if (version.sourcePath !== state.route.sourceFile) return null;
  return { file: version.sourcePath, text: version.sourceText, line: state.route.sourceLine ?? 1 };
}

function attachEvents(): void {
  app.querySelector<HTMLSelectElement>('[data-action="version"]')?.addEventListener('change', event => {
    const nextVersion = (event.target as HTMLSelectElement).value;
    const current = findSymbol(getVersion(nextVersion), state.route.symbolId);
    navigate(state.route.compare ? compareHref(nextVersion).replace('#compare', `#${state.route.anchor ?? 'compare'}`) : routeHref(nextVersion, current ? current.id : null, current ? rebaseAnchor(state.route.anchor, state.route.version, nextVersion) : undefined), false);
  });
  app.querySelector<HTMLInputElement>('#symbol-search')?.addEventListener('input', event => {
    state.query = (event.target as HTMLInputElement).value;
    render();
    const input = app.querySelector<HTMLInputElement>('#symbol-search');
    input?.focus();
    input?.setSelectionRange(state.query.length, state.query.length);
  });
  app.querySelectorAll<HTMLElement>('[data-nav]').forEach(element => element.addEventListener('click', event => {
    const href = (element as HTMLAnchorElement).href;
    if (!href || (event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey || (event as MouseEvent).shiftKey) return;
    event.preventDefault();
    navigate(href, true);
  }));
  app.querySelectorAll<HTMLElement>('.symbol-item, .search-member-results a').forEach(element => {
    element.addEventListener('keydown', event => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== 'ArrowDown' && keyboardEvent.key !== 'ArrowUp') return;
      const focusable = [...app.querySelectorAll<HTMLElement>('.symbol-item, .search-member-results a')];
      const next = focusable[focusable.indexOf(element) + (keyboardEvent.key === 'ArrowDown' ? 1 : -1)];
      if (next) { keyboardEvent.preventDefault(); next.focus(); }
    });
  });
  app.querySelector('[data-action="toggle-sidebar"]')?.addEventListener('click', event => {
    state.lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.sidebarOpen = !state.sidebarOpen; render();
    if (state.sidebarOpen) app.querySelector<HTMLElement>('#symbol-search')?.focus();
  });
  app.querySelector('[data-action="close-sidebar"]')?.addEventListener('click', () => closeSidebar());
  app.querySelector('[data-action="clear-search"]')?.addEventListener('click', () => { state.query = ''; render(); });
}

function navigate(href: string, push = true): void {
  const url = new URL(href, window.location.href);
  if (push) window.history.pushState({}, '', url);
  else window.history.replaceState({}, '', url);
  state.route = readRoute();
  state.sidebarOpen = false;
  render();
  document.querySelector<HTMLElement>('.main-content')?.focus();
}

function closeSidebar(): void {
  state.sidebarOpen = false;
  render();
  state.lastFocused?.focus();
  state.lastFocused = null;
}

function routeHref(version: string, symbolId: string | null, anchor?: string): string {
  const params = new URLSearchParams({ version });
  if (symbolId) params.set('symbol', symbolId);
  const returnAnchor = state.route.sourceFile && state.route.symbolId === symbolId && state.route.version === version ? state.route.anchor : null;
  return `${window.location.pathname}?${params.toString()}#${anchor ?? returnAnchor ?? (symbolId ? symbolAnchor(version, symbolId) : 'reference')}`;
}

function anchoredHref(version: string, symbolId: string, anchor: string): string {
  return routeHref(version, symbolId, anchor);
}

function rebaseAnchor(anchor: string | null, oldVersion: string, nextVersion: string): string | undefined {
  if (!anchor) return undefined;
  const separator = anchor.indexOf('-');
  try {
    const parts = JSON.parse(decodeURIComponent(anchor.slice(separator + 1).replace(/_/g, '%'))) as string[];
    if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string') || parts[0] !== oldVersion) return undefined;
    parts[0] = nextVersion;
    return anchorId(anchor.slice(0, separator), ...parts);
  } catch {
    return undefined;
  }
}

function compareHref(version: string): string {
  return `${window.location.pathname}?version=${encodeURIComponent(version)}&compare=true#compare`;
}

function diagnosticsHref(): string {
  return `${window.location.pathname}?diagnostics=true#diagnostics`;
}

function compareVersions(latest: ApiVersion, previous: ApiVersion): { added: string[]; removed: string[]; changed: string[]; common: string[] } {
  const current = new Map(latest.symbols.map(symbol => [symbol.id, symbol]));
  const old = new Map(previous.symbols.map(symbol => [symbol.id, symbol]));
  const added = [...current.keys()].filter(id => !old.has(id));
  const removed = [...old.keys()].filter(id => !current.has(id));
  const shared = [...current.keys()].filter(id => old.has(id));
  const changed = shared.filter(id => JSON.stringify(comparableApi(current.get(id)!)) !== JSON.stringify(comparableApi(old.get(id)!)));
  return { added, removed, changed, common: shared.filter(id => !changed.includes(id)) };
}

function sourceHref(version: Pick<ApiVersion, 'version'>, source: SourceLocation, symbolId?: string, anchor?: string): string {
  const params = new URLSearchParams({ version: version.version, source: source.file });
  if (symbolId) params.set('symbol', symbolId);
  if (anchor) params.set('anchor', anchor);
  return `${window.location.pathname}?${params.toString()}#L${source.line}`;
}

function getVersion(version: string): ApiVersion | undefined {
  return state.api?.versions.find(item => item.version === version) ?? state.api?.versions[0];
}

function findSymbol(version: ApiVersion | undefined, id: string | null): SymbolEntry | undefined {
  if (!version || !id) return undefined;
  return version.symbols.find(symbol => symbol.id === id);
}

function symbolAnchor(version: string, id: string): string {
  return anchorId('symbol', version, id);
}

function memberAnchor(version: string, symbolId: string, id: string): string {
  return anchorId('member', version, symbolId, id);
}

function overloadAnchor(version: string, ownerId: string, index: number, memberId?: string): string {
  return anchorId('overload', version, ownerId, memberId ?? '', 'detail', String(index + 1));
}

function diffRowAnchor(version: string, symbolId: string, index?: number): string {
  return anchorId('diff', version, symbolId, index === undefined ? 'row' : `signature-${index + 1}`);
}

function anchorId(kind: string, ...parts: string[]): string {
  // Encode the tuple rather than a slug so punctuation and namespace IDs cannot collide.
  return `${kind}-${stableAnchor(JSON.stringify(parts)).replace(/_/g, '%5F').replace(/%/g, '_')}`;
}

function stableAnchor(value: string): string {
  return encodeURIComponent(value);
}

function getSignatures(symbol: SymbolEntry | undefined): string[] {
  return symbol?.overloads?.length ? symbol.overloads.map(overload => overload.signature) : symbol?.signatures ?? [];
}

function getSearchResults(query: string, selectedVersion: ApiVersion): SearchResult[] {
  if (!state.api) return [];
  if (!query.trim()) return selectedVersion.symbols.map(symbol => ({ symbol, version: selectedVersion }));
  return state.api.versions.flatMap(version => getFilteredSymbols(version, query).map(symbol => ({ symbol, version })));
}

function getFilteredSymbols(version: ApiVersion | undefined, query: string): SymbolEntry[] {
  if (!version || !query.trim()) return version?.symbols ?? [];
  const normalized = query.trim().toLowerCase();
  return version.symbols.filter(symbol => searchableSymbolText(symbol).includes(normalized) || symbol.members.some(member => searchableMemberText(member).includes(normalized)));
}

function searchableSymbolText(symbol: SymbolEntry): string {
  return [symbol.id, symbol.name, symbol.kind, symbol.namespace ?? '', symbol.summary, symbol.description, ...getSignatures(symbol)].join(' ').toLowerCase();
}

function searchableMemberText(member: Member): string {
  return [member.id, member.name, member.kind, member.summary, member.signature, ...(member.overloads ?? []).map(overload => overload.signature), ...member.parameters.map(parameter => `${parameter.name} ${parameter.type}`)].join(' ').toLowerCase();
}

function comparableMember(member: Member): unknown {
  return comparableApi(member);
}

function comparableApi(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(comparableApi);
    if (value.every(item => item && typeof item === 'object' && 'id' in item)) {
      items.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
    }
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'source')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, comparableApi(item)]));
}

function countKinds(symbols: SymbolEntry[]): Record<string, number> {
  return symbols.reduce<Record<string, number>>((counts, symbol) => { counts[symbol.kind] = (counts[symbol.kind] ?? 0) + 1; return counts; }, {});
}

function kindLabel(kind: string): string {
  return kind === 'interface' ? 'int' : kind === 'namespace' ? 'ns' : kind === 'constructor' ? 'ctor' : kind.slice(0, 4);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

window.addEventListener('popstate', () => { state.route = readRoute(); render(); });
window.addEventListener('hashchange', () => { state.route = readRoute(); render(); });
window.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    event.preventDefault();
    app.querySelector<HTMLInputElement>('#symbol-search')?.focus();
  }
  if (event.key === 'Escape' && state.sidebarOpen) { event.preventDefault(); closeSidebar(); return; }
  if (event.key === 'Tab' && state.sidebarOpen) {
    const focusable = [...app.querySelectorAll<HTMLElement>('#api-sidebar a, #api-sidebar button, #api-sidebar input, #api-sidebar select')].filter(element => !element.hasAttribute('disabled'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
