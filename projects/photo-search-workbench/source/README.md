# Fieldnote — local photo-search workbench

Fieldnote is a small, local-first photo catalog that makes a SQLite metadata search feel tangible in the browser. It includes 24 bundled generated placeholder photographs, an editable nested query builder, and a deliberately small deterministic phrase parser. No photographs are uploaded or sent to a hosted service.

> **Source idea:** Interface the database search engine to an AI-based LLM (KDE Community) — [Google Summer of Code 2026 project](https://summerofcode.withgoogle.com/programs/2026/projects/qyiUD0bH).

## Run it locally

Requirements: Node.js 22.5+ (the server uses Node's built-in `node:sqlite` module).

```bash
npm install

# Terminal 1: SQLite catalog API and image server
npm run server

# Terminal 2: browser UI
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` and `/photos` to the local API at port 3001. The first server start creates `server/data/catalog.sqlite`; it is ignored by git and can be deleted to recreate a clean catalog.

## What is included

- A SQLite `photos` table with titles, dates, locations, labels, tags, favorite state, dimensions, and placeholder image URLs.
- 24 generated SVG landscape illustrations across the Dolomites, Kyoto, Algarve, Lofoten, Joshua Tree, and Swiss Alps.
- Nested `AND` / `OR` groups with editable rules for tags, labels, locations, dates, titles, and favorite state.
- Bound SQL parameters and validation on the search API.
- Favorite toggles that persist immediately in SQLite.
- A preview grid with sorting by newest, oldest, or title.
- JSON catalog export/import with full validation and an atomic replacement transaction. A malformed import is rejected before any row is changed.
- Search history stored in SQLite with reload and clear actions.
- Keyboard-friendly review, query editing, history loading, photo explanation disclosure, and responsive photo cards.

## Deterministic phrase parser and supported grammar

The phrase field is **not an LLM**. It is a small deterministic parser with a documented vocabulary. It returns an editable query tree plus recognized terms, unsupported terms, and clarification prompts when a phrase is ambiguous.

The parser accepts a small, case-insensitive grammar. It does not infer arbitrary language and it does not silently turn unknown words into filters.

```text
search       := term (AND term)* | term (OR term)*
term         := tag | place | year | date-comparison | favorite | relative-date | ambiguous-place
tag          := mountain(s) | beach(es) | coast(s) | forest(s) | sunset | city/cities | snow
place        := a known catalog location or country name
year         := in YYYY | YYYY
date-comparison := before YYYY-MM-DD | after YYYY-MM-DD
favorite     := favorite(s)
relative-date := recent | last summer | yesterday | last week | this month
ambiguous-place := near me | around <place phrase>
```

Supported examples:

- Tags: `mountain`, `mountains`, `beach`, `coast`, `forest`, `sunset`, `city`, `snow`
- Locations/countries: `Dolomites`, `Italy`, `Kyoto`, `Japan`, `Algarve`, `Portugal`, `Lofoten`, `Norway`, `Joshua Tree`, `USA`, `Swiss Alps`, `Switzerland`
- Dates: `in 2024`, `in 2023`, `in 2025`, `before 2024-06-01`, `after 2024-01-01`
- Favorites: `favorites`
- Boolean hints: `AND`, `OR` (the returned group operator is editable)

These phrases prompt for a choice rather than silently inventing a criterion:

- `last summer` → the most recently completed summer or the preceding summer
- `recent` → last 30 days or reference-date year-to-date
- `yesterday` → the reference date's previous calendar day
- `last week` → previous Monday–Sunday or previous rolling 7 days
- `this month` → month-to-date or the entire reference-date month
- `near me` → choose a catalog location
- `around Atlantis` → choose a catalog location when the place is not known

Relative phrases are deterministic. The visible **Reference date** field defaults to `2025-11-15`; the browser sends it to `POST /api/parse`, so changing it changes the clarification options predictably. A phrase is reviewed before it runs: the workbench shows recognized terms, unsupported terms, generated criteria, and any choices. Choose clarifications or edit the query builder, then explicitly run the search.

Unknown words are shown as unsupported. They do not become made-up search conditions.

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/catalog` | Photos, facets, and catalog statistics |
| GET | `/api/catalog/export` | Download a JSON catalog export |
| POST | `/api/catalog/import` | Validate and atomically replace catalog photos |
| POST | `/api/search` | Search with `{ query, sort }` |
| GET | `/api/search-history` | List successful searches |
| DELETE | `/api/search-history` | Clear search history |
| POST | `/api/parse` | Parse `{ text }` into editable criteria |
| PATCH | `/api/photos/:id` | Update `{ favorite: boolean }` |

The query shape is a group containing `children`, where each child is another group or a rule. A rule has `field`, `operator`, and `value`; for example:

```json
{
  "id": "root",
  "type": "group",
  "operator": "AND",
  "children": [
    { "id": "tag-1", "type": "rule", "field": "tag", "operator": "is", "value": "mountain" },
    { "id": "year-1", "type": "rule", "field": "date", "operator": "is", "value": "2024" }
  ]
}
```

The workbench also defines typed canonical filter nodes for the catalog-specific search engine:

```json
{
  "id": "root",
  "type": "group",
  "operator": "AND",
  "children": [
    { "id": "tags-1", "type": "tags", "mode": "all", "values": ["mountain", "snow"] },
    { "id": "label-1", "type": "label", "value": "Landscape" },
    { "id": "date-1", "type": "date-interval", "from": "2024-01-01", "to": "2024-12-31" },
    { "id": "location-1", "type": "location", "operator": "contains", "value": "Alps" }
  ]
}
```

- `tags` supports `any`, `all`, and `none` modes. An empty `any` set matches nothing; empty `all` and `none` sets are identities.
- `label` is an exact, case-insensitive value.
- `date-interval` has inclusive `from` and/or `to` bounds in strict `YYYY-MM-DD` form.
- `location` supports exact `is`, literal substring `contains`, and literal substring `is_not`.

The compiler recursively preserves group parentheses, validates the discriminated node shapes, allowlists SQL fragments, and binds every user-provided value as a SQLite parameter. `src/query-model.js` contains the JSDoc typedefs and factories; `server/query.mjs` contains the validating compiler.

## Inspiration and scope

This project is independently scoped prototype work inspired by KDE Community's GSoC idea, [“Interface the database search engine to an AI-based LLM”](https://summerofcode.withgoogle.com/programs/2026/projects/qyiUD0bH). It is **not** the KDE implementation, does not embed an LLM, and does not claim to integrate with KDE or any hosted AI provider. Its independent component scope is a local SQLite catalog, a deliberately bounded deterministic phrase parser, an editable query representation/compiler, and browser workflows for review, clarification, import/export, history, and photo explanations.

## Checks

```bash
npm test
npm run build
npm run test:browser
```

`npm test` runs the Node compiler, parser, catalog, API, and persistence tests. `npm run test:browser` starts the local API and Vite dev server through Playwright and checks phrase entry, clarification, criteria editing, saved-search persistence, keyboard interactions, malformed import handling, filter clearing, history, and responsive layout.
