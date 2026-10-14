# webpack API workbench

A small, dark, searchable browser workbench for the generated webpack TypeScript
API reference. The UI is designed for quickly moving from a symbol to its
declaration source, while keeping release changes visible.

Reference project: https://summerofcode.withgoogle.com/programs/2026/projects/ikzNNgeA

## Setup

Install the project dependencies with the repository's package manager, then
start the Vite development server:

```bash
npm install
npm run dev
```

The browser loads the generated document from `/generated/api.json`. The
machine-readable generation manifest is available at
`/generated/manifest.json`. The public directory is served by Vite, so both
paths work in development and in the production preview build.

## Commands

These are the project commands used by the workbench and its deterministic
documentation pipeline:

| Command | Purpose |
| --- | --- |
| `npm run docs:generate` | Extract both declaration samples into `public/generated/api.json`, `manifest.json`, and `diagnostics.json`. |
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Type-check and create the production browser bundle. |
| `npm run docs:export` | Generate the API artifacts and create the static Vite export in `dist/`. |
| `npm run docs:verify-versions` | Parse and validate both bundled declaration versions independently. |
| `npm run browser:smoke` | Build the static site and exercise search, deep links, comparison, and mobile navigation in Chromium. |
| `npm run test` | Run the extractor tests. |
| `npm run typecheck` | Run TypeScript without emitting files. |
| `npm run docs:check` | Confirm the committed generated API and manifest exactly match extraction output. |

Run the checks together before handing off a change:

```bash
npm run docs:generate
npm run docs:check
npm run docs:verify-versions
npm run test
npm run typecheck
npm run build
npm run browser:smoke
```

## Architecture

- `index.html` is the Vite HTML entry point and mounts the application.
- `src/main.ts` owns the browser workbench: API loading, typed schema models,
  hash/query routing, search, detail rendering, version comparison, and the
  bundled-source view.
- `src/styles.css` contains the responsive visual system. It has no external
  assets, fonts, or runtime dependencies.
- `scripts/extract.ts` reads TypeScript declarations with the TypeScript
  checker and emits symbols, overloads, parameters, members, descriptions, and
  source locations.
- `public/generated/api.json` is the browser's static data boundary. Both
  bundled versions include their declaration source text, so the source view
  does not need a second API request.
- `public/generated/manifest.json` is the machine-readable export index. It
  records version/source paths, symbol/member counts, URL templates, and stable
  anchor conventions for consumers of the static site.
- `public/generated/diagnostics.json` contains TypeScript compiler diagnostics
  for each source version. The **Build diagnostics** route exposes unresolved
  modules, malformed syntax, and other compiler feedback without putting raw
  diagnostic text into the page.

The browser is intentionally vanilla TypeScript. The navigation shell is
rendered from the generated schema and uses normal links for symbol and source
routes. A source link opens the bundled declaration in a new tab with a
line-fragment such as `#L125`.

## Deterministic generation

The two source versions are declared in `scripts/generate.ts` in release order:

- Latest `5.99.0` → `samples/v2/webpack.d.ts`
- Previous `5.98.0` → `samples/v1/webpack.d.ts`

Extraction creates a real TypeScript program with strict diagnostics, formats
the resulting document and manifest as stable two-space JSON, and preserves
source paths and line numbers. The manifest records the source versions and
paths, per-version symbol/member counts, and the stable URL/anchor templates:
version routes use `/?version={version}`, symbol routes use
`#symbol-{stableSymbolId}`, member/overload routes use deterministic ID-based
anchors, and source locations use `#L{line}`. `docs:check`
regenerates both expected strings in memory and fails if either committed JSON
differs. Update the samples first, then run `npm run docs:generate` and commit
the generated output with the sample change.

Vite copies `public/generated/` into `dist/generated/` during both `build` and
`docs:export`, so the static export serves the same API and manifest files as
the development server.

## Browser flow

1. Open the workbench and choose **Latest · 5.99.0** or **Previous · 5.98.0**.
2. Use the sidebar search, or press `/`, to filter symbols by name, kind,
   namespace, description, signatures, and member names.
3. Select a reference entry to open its detail route. The selected version and
   symbol are encoded in the query/hash URL, so reload, copy, and back/forward
   navigation preserve the selection.
4. Inspect the overview, overload signatures, parameter table, return type,
   examples, and class/interface member cards. Namespace entries are shown in
   the same member-card treatment.
5. Use **View source** to open the bundled declaration source at its exact line.
6. Use **Compare versions** for side-by-side release statistics and added,
    removed, changed, and unchanged symbol counts. Changed rows show previous
    and latest signatures side by side; changed symbols account for signature,
    parameter, return type, kind, and member-surface differences.

Search results display the version they came from. Run `npm run docs:export`,
then serve `dist/` with any static HTTP server: the export includes the browser
bundle, `generated/api.json`, and `generated/manifest.json` and needs no runtime
parser or server.

Use **Build diagnostics** (or `/?diagnostics=true`) to inspect compiler errors
after editing a declaration sample. Regenerate with `npm run docs:generate` or
`npm run dev`; the browser reads the refreshed API, source, links, and
diagnostics artifacts together.

The interface includes an empty result state for unmatched searches, an empty
reference state before a symbol is selected, a data-load error state, keyboard
focus states, accessible labels, and a mobile navigation drawer.

## Independent documentation-tool scope

This project is an independent documentation tool for the Webpack API surface;
it does not build or execute Webpack itself. Its scope is limited to parsing the
bundled TypeScript declaration samples with the TypeScript compiler API,
rendering searchable/versioned reference pages, comparing those generated
models, and exporting static JSON/site artifacts. The source-of-truth proposal
reference is the GSoC project page:
https://summerofcode.withgoogle.com/programs/2026/projects/ikzNNgeA

Exact verification commands:

```bash
npm test
npm run docs:verify-versions
npm run typecheck
npm run docs:check
npm run build
npm run browser:smoke
```
