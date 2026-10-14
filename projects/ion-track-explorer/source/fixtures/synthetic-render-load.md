# Synthetic render-load data

`synthetic-render-load.csv` is generated geometric test data, **not a physics
simulation**, experimental data, or OpenTRIM output. Species, event labels,
times, energies, and parent links are arbitrary test values.

The fixed dataset contains **320 tracks (8 primary, 312 recoil), 20,480 events,
and 20,160 line segments** before rendering limits. Each track has 64 events.
All events are visible by 254 fs. Coordinates stay within a 100 × 100 × 160 nm
target, deposited energies are 1–240 eV, and parent links form an acyclic forest.
The four event types each occur 5,120 times.

Import this CSV using **Import trajectory**. At 254 fs with every layer/type
enabled and no energy bounds, the UI reports **20,480 loaded**, **20,480
eligible**, and **8,000 rendered** events. The current 3D caps are 8,000 events
and 500 tracks; a selected eligible track is reserved a slot. Counts refer to
records, not pixels: overlapping markers may occupy the same screen position.
Type, energy, layer, and time filters reduce eligibility without deleting loaded
records. The frontend test imports this exact checked fixture and verifies the
cap, counts, filters, and session round trip.

Regenerate the checked CSV from the repository root:

```sh
python3 scripts/generate_render_fixture.py --format csv --output fixtures/synthetic-render-load.csv
```

Generate a browser-contract JSON file with explicit synthetic provenance:

```sh
python3 scripts/generate_render_fixture.py --output public/data/synthetic-render-load.json
python3 scripts/import_tracks.py --check public/data/synthetic-render-load.json
```

The JSON is generated on demand to avoid storing a second, larger copy. The
CSV also exercises `scripts/import_tracks.py` through its normal input path.
The generator uses fixed integer arithmetic, no randomness or timestamps,
and fixed counts to keep output bounded and reproducible.

## Optional event type contract

Python validation accepts an optional `eventType` on each JSON event. When
present, it must be a nonempty string (null, numbers, and whitespace-only
strings are invalid). Labels are free-form and case-sensitive.

CSV `event_type` is optional and may appear anywhere in the header. The importer
trims surrounding whitespace and omits `eventType` for blank cells or a missing
column. Legacy CSVs retain exactly their previous event shape. Event types may
vary within a track. No default type or physical meaning is inferred.
