# ListView Model Studio

An independent browser prototype for exploring an incremental `ListView` data model inspired by the GSoC ListView idea. It uses stable item IDs and keeps the canonical collection separate from the rendered/filter projection, so an update can patch one item without rebuilding the full list.

This is a local web prototype only. It is **not Android/iOS integration**, does not provide native platform bindings, and does not claim production cross-platform parity.

## What is included

- A deterministic local fixture with 12,000 records.
- Add, remove, update, filter, single-selection, and multi-selection operations.
- Stable IDs (`fixture-00001`, `local-00001`, etc.) that survive updates and filtering.
- Rendered preview with row selection, modifier-click multi-selection, and shift-click range selection.
- Model inspector for the selected item, revision, editable fields, and selection counts.
- Event log showing every state operation and the IDs it touched.
- Atomic batch transactions with duplicate-ID rejection and rollback.
- Canonical reordering that preserves selection by ID.
- Measured virtual scrolling across the full filtered collection, with ID-based scroll-to-item and bounded overscan.
- Keyboard navigation (arrows, Home/End, Page Up/Down, Space/Enter, Escape) and polite accessible selection announcements.
- Honest preview instrumentation: measured viewport, scroll offset, mounted-row range/count, overscan, and cumulative model update counters.
- Versioned JSON model snapshots and scenario documents for repeatable authoring.
- Scenario runner with an initial snapshot plus model/visible-view state after every operation.
- Undo/redo for model edits, imports, and completed scenario runs.
- No backend, account, or network data required.

## Selection and transaction semantics

Selection belongs to stable item IDs, never to array positions:

- **Edit:** editing a selected item keeps it selected and keeps its ID. If the edit changes its title/category/active state so it no longer matches the filter, the ID remains selected but is reported as hidden by the filter.
- **Filter:** filtering only changes the visible projection. Selected IDs that are filtered out remain selected and are included in batch and remove operations.
- **Remove:** removing an item removes its ID from selection. If the removed item was the range anchor, the anchor is cleared; the model does not silently select a neighboring row.
- **Reorder:** reordering changes canonical display order but preserves selected IDs and the anchor ID. Shift-click ranges use the current visible order after the reorder.
- **Single mode:** switching to single selection retains the most recently selected ID. Multiple mode retains all selected IDs.
- **Batch:** a batch is an all-or-nothing transaction. Operations run against a temporary state and commit with one `transaction` event. An unknown update/remove, empty ID, duplicate ID, or duplicate add in the same batch rejects the full batch and leaves data, order, and selection unchanged.

Duplicate stable IDs are rejected both when initializing a fixture and when adding items. Reorders must provide every current ID exactly once.

## Start and check commands

```bash
npm install
npm run dev
```

Open the local Vite URL printed in the terminal, normally <http://127.0.0.1:5173/>.

Run the model/unit checks:

```bash
npm test
npm run typecheck
npm run build
```

Run the real Chromium browser checks:

```bash
npm run test:browser
```

The browser suite uses Playwright and a local Vite server. It covers the 12,000-item list, virtual scrolling, measured resize, scroll-to-item, multi-selection, filtering, announcements, update counters, reorder, and authoring undo/redo.

## Component contract

The prototype's model contract is intentionally small and explicit:

- Every item has a non-empty, unique, stable `id`. The `id` is never derived from an array position and cannot be changed by an update.
- The canonical model is `itemsById + order`. The visible list is derived from the current `FilterState`; filtering never deletes or reindexes canonical data.
- `add`, `remove`, `update`, `batch`, `reorder`, `set-filter`, `set-selection-mode`, `select`, and `clear-selection` are the supported operations.
- A successful update preserves the item ID and increments its `revision`. Duplicate IDs, unknown targets, incomplete reorders, and invalid batches are rejected.
- Batches are atomic: either every nested operation commits or the model, selection, and order remain unchanged.
- Selection is an ID set plus an optional range anchor. Selected IDs survive filtering and editing; removing an item removes its ID from selection. Reordering preserves IDs and changes only canonical order.
- The browser preview virtualizes the filtered ID order using the measured scroll viewport, fixed 58px row geometry, and five-row overscan. The mounted row count is observable UI state, not a performance claim.
- Keyboard navigation moves an active ID through the current visible order. Space/Enter changes selection, Shift extends a range, and Escape clears it. A polite live region announces selection totals and hidden-by-filter counts.
- Model JSON snapshots use `format: "listview-model-studio"`, version `1`. Scenario JSON uses `format: "listview-model-studio-scenario"`, version `1`, and at most 200 operations. Malformed or state-invalid scenarios are validated before they can change live state.
- Undo/redo records authoring edits, imports, and completed scenario runs. Browsing a scenario trace is read-only.

## Interaction guide

1. Click a row to inspect its stable ID and edit its title, category, value, or active state.
2. Use **Apply update** to emit a targeted `update` event and increment that item's revision.
3. Use `cmd/ctrl`-click to toggle multiple rows, or `shift`-click to select a visible range.
4. Search and filter the preview. The canonical 12,000-item model remains intact while the visible projection changes.
5. Use **Batch +1 selected** to apply one transaction to all selected IDs, including IDs hidden by a filter.
6. Use **Reverse order** to change canonical order and then try a shift-click range.
7. Use the **Scroll to ID** field to jump to a row that is not currently mounted. Clear the filter first if the ID is hidden.
8. Focus the rendered preview and use arrow keys, Home/End, Page Up/Down, Space/Enter, and Escape.
9. Read the preview measurements and model counters as observed state, not as benchmark claims. They show how many rows are mounted and how many model updates changed/skipped/rejected items.
10. Use **Export model** / **Import model** for versioned JSON snapshots. Invalid JSON, unknown fields, duplicate IDs, and inconsistent order data are rejected without changing the live model.
11. Edit the Scenario JSON, click **Validate**, then **Run**. A malformed or state-invalid scenario is rejected before the live model changes. Use the step selector to inspect each model state and visible view.
12. Use **Undo** / **Redo** to navigate authoring edits. Browsing scenario snapshots is read-only; a successful run is one undoable authoring edit.
13. Use **Add item**, the reset button, and the event log to trace the model operations.

## JSON formats

Model exports use a versioned envelope:

```json
{
  "format": "listview-model-studio",
  "version": 1,
  "exportedAt": "2026-10-14T12:00:00.000Z",
  "state": {
    "itemsById": {},
    "order": [],
    "filter": { "query": "", "category": "All", "activeOnly": false },
    "selectionMode": "multiple",
    "selectedIds": [],
    "anchorId": null,
    "updateMetrics": { "requested": 0, "changed": 0, "skipped": 0, "rejected": 0, "transactions": 0 },
    "events": [],
    "nextItemNumber": 1,
    "nextEventNumber": 1
  }
}
```

Scenarios use `format: "listview-model-studio-scenario"`, `version: 1`, a name, and an `operations` array. Operations can be `add`, `remove`, `update`, `batch`, `reorder`, `set-filter`, `set-selection-mode`, `select`, or `clear-selection`. Scenario structure is validated first, then operations are dry-run against a clone so missing IDs, duplicate adds, invalid reorders, and rejected batches never publish a partial trace or mutate the live state.

## Virtual scrolling and measurement notes

The preview keeps the complete filtered ID order in the model but mounts only the measured viewport window plus five rows of overscan on each side. Row geometry is currently fixed at 58px; the scroll container's actual `clientHeight` is measured with `ResizeObserver`, and the visible range is recalculated from `scrollTop`, viewport height, row height, item count, and overscan.

The UI intentionally does not claim a frame-rate or end-to-end performance improvement. It exposes:

- **Viewport / scroll:** the measured scroll container height and current scroll offset.
- **Mounted range/count:** the row positions and DOM row count currently rendered.
- **Model update counters:** cumulative requested, changed, skipped, rejected, and committed transaction counts since reset. These are model-operation counts, not render timings.

## Source reference

The source idea is **ListView Component Update Performance Redesign, Cross-Platform Parity, a Beginner-Friendly UX system (MIT App Inventor)**. Reference: <https://summerofcode.withgoogle.com/programs/2026/projects/sxZpFLJk>
