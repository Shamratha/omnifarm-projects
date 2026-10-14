import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { dataset } from '../src/fixtures.js';
import { buildScorecard } from '../src/evaluation.js';

const scorecard = buildScorecard(dataset, 'run-1-2', 'run-1-3');
const args = process.argv.slice(2);
const output = args.find((value) => value !== '--check') || 'scorecard.json';
const content = `${JSON.stringify(scorecard, null, 2)}\n`;
if (args.includes('--check')) {
  assert.equal(await readFile(output, 'utf8'), content, 'Scorecard is stale. Run npm run scorecard.');
  console.log(`Verified byte-for-byte deterministic scorecard: ${output}`);
} else {
  await writeFile(output, content, 'utf8');
  console.log(`Wrote deterministic scorecard to ${output}`);
}
