#!/usr/bin/env python3
"""Validate track JSON or convert event CSV using only the standard library.

Usage:
    python scripts/import_tracks.py --check public/data/silicon-cascade.json
    python scripts/import_tracks.py events.csv tracks.json

CSV requires the columns in CSV_COLUMNS (header order is arbitrary). Leave
parent_id empty, or use null, for a root track. Rows may interleave tracks;
events within each track must already be in nondecreasing time order. Track
attributes must agree across rows. Coordinates are nanometers, time is fs,
and deposited energy is eV. The default incident energy is 30 keV per ion.
Importing performs no simulation, interpolation, or physical validation.

Optional CSV column event_type maps to eventType on each JSON event. Values
are trimmed; absent or blank cells omit eventType, preserving legacy output.
JSON eventType, when present, must be a nonempty string; labels are free-form
and case-sensitive, with no physics interpretation or inferred default.
"""

import argparse
import csv
import json
import math
from pathlib import Path
import sys


CSV_COLUMNS = (
    "ion_id", "parent_id", "species", "kind", "time_fs",
    "x_nm", "y_nm", "z_nm", "deposited_energy_ev",
)


def _number(value, location, minimum=None, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{location}: expected a finite number")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError(f"{location}: expected a finite number")
    if minimum is not None and value < minimum:
        raise ValueError(f"{location}: must be >= {minimum}")
    if positive and value <= 0:
        raise ValueError(f"{location}: must be positive")


def _vector(value, location, positive=False):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{location}: expected an array of three numbers")
    for index, component in enumerate(value):
        _number(component, f"{location}[{index}]", positive=positive)


def _string(value, location):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{location}: expected a nonempty string")


def validate_document(document):
    """Raise ValueError with a field location if the contract is violated.

    Equal event times are allowed. Parent links must resolve and be acyclic.
    Geometry bounds, parent birth positions, and energy conservation are not
    part of this structural validator; it makes no physics fidelity claims.
    """
    if not isinstance(document, dict):
        raise ValueError("document: expected an object")
    metadata = document.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("metadata: expected an object")
    for field in ("name", "description", "source", "ion", "material"):
        _string(metadata.get(field), f"metadata.{field}")
    _number(metadata.get("incidentEnergyKeV"), "metadata.incidentEnergyKeV", minimum=0)
    _vector(metadata.get("targetSizeNm"), "metadata.targetSizeNm", positive=True)

    tracks = document.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("tracks: expected an array")
    parents = {}
    for index, track in enumerate(tracks):
        location = f"tracks[{index}]"
        if not isinstance(track, dict):
            raise ValueError(f"{location}: expected an object")
        ion_id = track.get("ionId")
        if type(ion_id) is not int:
            raise ValueError(f"{location}.ionId: expected an integer")
        if ion_id in parents:
            raise ValueError(f"{location}.ionId: duplicate id {ion_id}")
        if "parentId" not in track:
            raise ValueError(f"{location}.parentId: required (integer or null)")
        parent_id = track["parentId"]
        if parent_id is not None and type(parent_id) is not int:
            raise ValueError(f"{location}.parentId: expected an integer or null")
        parents[ion_id] = parent_id
        _string(track.get("species"), f"{location}.species")
        if track.get("kind") not in ("primary", "recoil"):
            raise ValueError(f"{location}.kind: expected primary or recoil")
        events = track.get("events")
        if not isinstance(events, list) or not events:
            raise ValueError(f"{location}.events: expected a nonempty array")
        previous_time = None
        for event_index, event in enumerate(events):
            event_location = f"{location}.events[{event_index}]"
            if not isinstance(event, dict):
                raise ValueError(f"{event_location}: expected an object")
            time = event.get("timeFs")
            _number(time, f"{event_location}.timeFs", minimum=0)
            if previous_time is not None and time < previous_time:
                raise ValueError(f"{event_location}.timeFs: events must be chronological")
            previous_time = time
            _vector(event.get("positionNm"), f"{event_location}.positionNm")
            _number(event.get("depositedEnergyEv"),
                    f"{event_location}.depositedEnergyEv", minimum=0)
            if "eventType" in event:
                _string(event["eventType"], f"{event_location}.eventType")

    for ion_id, parent_id in parents.items():
        if parent_id is not None and parent_id not in parents:
            raise ValueError(f"track {ion_id}: missing parent {parent_id}")
    # Iterative traversal avoids recursion limits for long recoil chains.
    resolved = set()
    for ion_id in parents:
        chain = set()
        current = ion_id
        while current is not None and current not in resolved:
            if current in chain:
                raise ValueError(f"track {ion_id}: parent cycle through {current}")
            chain.add(current)
            current = parents[current]
        resolved.update(chain)


def import_csv(path):
    """Group CSV rows in first-seen track order and validate the result."""
    tracks_by_id = {}
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames
        if headers is None:
            raise ValueError("CSV: missing header")
        if len(headers) != len(set(headers)):
            raise ValueError("CSV: duplicate column names")
        missing = set(CSV_COLUMNS) - set(headers)
        if missing:
            raise ValueError(f"CSV: missing columns: {', '.join(sorted(missing))}")
        for row in reader:
            location = f"CSV line {reader.line_num}"
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f"{location}: row length does not match header")
            try:
                ion_id = int(row["ion_id"])
                parent_text = row["parent_id"].strip()
                parent_id = None if parent_text.lower() in ("", "null") else int(parent_text)
                species = row["species"].strip()
                kind = row["kind"].strip()
                event = {
                    "timeFs": float(row["time_fs"]),
                    "positionNm": [float(row[field]) for field in ("x_nm", "y_nm", "z_nm")],
                    "depositedEnergyEv": float(row["deposited_energy_ev"]),
                }
            except ValueError as error:
                raise ValueError(f"{location}: invalid numeric field ({error})") from error
            event_type = row.get("event_type", "").strip()
            if event_type:
                event["eventType"] = event_type
            if ion_id not in tracks_by_id:
                tracks_by_id[ion_id] = {
                    "ionId": ion_id, "parentId": parent_id,
                    "species": species, "kind": kind, "events": [],
                }
            track = tracks_by_id[ion_id]
            if (track["parentId"], track["species"], track["kind"]) != (parent_id, species, kind):
                raise ValueError(f"{location}: conflicting attributes for track {ion_id}")
            track["events"].append(event)
    if not tracks_by_id:
        raise ValueError("CSV: no event rows")
    document = {
        "metadata": {
            "name": "Imported argon / silicon tracks",
            "description": "CSV event import; default target and incident energy metadata. "
                           "No simulation or physics fidelity is implied; verify defaults "
                           "against the input provenance.",
            "source": f"CSV import: {Path(path).name}; provenance supplied by CSV author",
            "ion": "Ar",
            "material": "Si",
            "incidentEnergyKeV": 30,
            "targetSizeNm": [100, 100, 160],
        },
        "tracks": list(tracks_by_id.values()),
    }
    validate_document(document)
    return document


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", metavar="FILE", type=Path, help="validate existing track JSON")
    parser.add_argument("input", nargs="?", type=Path, help="input event CSV")
    parser.add_argument("output", nargs="?", type=Path, help="output track JSON")
    args = parser.parse_args(argv)
    if args.check is not None:
        if args.input is not None or args.output is not None:
            parser.error("--check cannot be combined with positional input/output")
    elif args.input is None or args.output is None:
        parser.error("provide --check FILE or positional input.csv output.json")
    try:
        if args.check is not None:
            with args.check.open(encoding="utf-8") as handle:
                document = json.load(handle)
            validate_document(document)
            action = f"Valid: {args.check}"
        else:
            if args.input.resolve() == args.output.resolve():
                raise ValueError("input and output must be different files")
            document = import_csv(args.input)
            with args.output.open("w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=2, allow_nan=False)
                handle.write("\n")
            action = f"Imported: {args.output}"
        tracks = document["tracks"]
        events = [event for track in tracks for event in track["events"]]
        max_time = max((event["timeFs"] for event in events), default=0)
        print(f"{action} ({len(tracks)} tracks, {len(events)} events, max time {max_time:g} fs)")
    except (OSError, ValueError, csv.Error) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
