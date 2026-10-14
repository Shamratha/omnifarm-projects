import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, bandTile, STUDIO_TODAY } from '../src/fixtures.js';
import { compareTiles, buildReport } from '../src/engine.js';

test('every bundled tile and both bands can be compared and reported', () => {
  for (const fixture of Object.values(FIXTURES)) {
    for (const band of ['infrared', 'visible']) {
      const before = bandTile(fixture.before, band), after = bandTile(fixture.after, band);
      const result = compareTiles(before, after, .20, { now: STUDIO_TODAY });
      const report = buildReport(before, after, .20, { now: STUDIO_TODAY, fixtureName: fixture.name, band });
      assert.equal(result.valid.length, 96 * 96);
      assert.equal(before.rgb.length, 96 * 96);
      assert.ok(result.nodataCount > 0);
      assert.ok(result.cloudCount > 0);
      assert.ok(result.lowConfidenceCount > 0);
      assert.equal(report.stats.changedCount, result.changedCount);
      assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
      assert.equal(result.changed.some((value, i) => value && !result.valid[i]), false);
    }
  }
});

test('flood and urban scenarios have signal, archive is a stale no-change control', () => {
  for (const [key, changed, stale] of [['river-bend', 585, false], ['new-block', 411, false], ['archive-haze', 0, true]]) {
    const fixture = FIXTURES[key];
    const result = compareTiles(bandTile(fixture.before, 'infrared'), bandTile(fixture.after, 'infrared'), .20, { now: STUDIO_TODAY });
    assert.equal(result.changedCount, changed);
    assert.equal(result.stale.after, stale);
  }
});
