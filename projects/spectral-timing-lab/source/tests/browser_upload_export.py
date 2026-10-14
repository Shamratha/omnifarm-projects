"""Optional real-browser upload -> analysis -> JSON export smoke test.

Run with a local server, for example:
    python -m http.server 8000 --directory web
    python tests/browser_upload_export.py --url http://127.0.0.1:8000/

Requires the optional Playwright package and Chromium browser installation.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright


def csv_text(phase: float) -> str:
    rows = ["time,value,units"]
    for i in range(256):
        time = i / 128
        value = math.sin(2 * math.pi * 2 * time + phase)
        rows.append(f"{time:.12g},{value:.12g},counts")
    return "\n".join(rows) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000/")
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(accept_downloads=True)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url, wait_until="networkidle")
        page.locator("#segmentLength").fill("128")
        page.locator("#segmentLength").dispatch_event("change")
        page.locator("#fileFirst").set_input_files({
            "name": "uploaded-a.csv", "mimeType": "text/csv", "buffer": csv_text(0).encode()
        })
        page.locator("#fileSecond").set_input_files({
            "name": "uploaded-b.csv", "mimeType": "text/csv", "buffer": csv_text(math.pi / 4).encode()
        })
        page.wait_for_function("document.querySelector('#statusText').textContent.includes('Analysis complete')")
        assert page.locator("#validationState").inner_text() == "PASS"
        assert page.locator("#exportJson").is_enabled()
        with page.expect_download() as download_info:
            page.locator("#exportJson").click()
        with TemporaryDirectory() as directory:
            path = Path(directory) / "review.json"
            download_info.value.save_as(path)
            payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["config"]["inputs"]["a"]["source"] == "uploaded-a.csv"
        assert payload["config"]["inputs"]["b"]["source"] == "uploaded-b.csv"
        assert payload["spectralArrays"]["frequency"]
        assert payload["spectralArrays"]["phase"]
        assert not errors, errors
        print("browser upload -> analysis -> export passed")
        browser.close()


if __name__ == "__main__":
    main()
