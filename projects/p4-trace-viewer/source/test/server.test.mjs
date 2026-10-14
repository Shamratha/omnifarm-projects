import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalServer } from '../scripts/local-server.mjs';

test('local routes serve all application assets and fixtures with correct content types', async () => {
  const server = await startLocalServer();
  try {
    for (const [path, type] of [
      ['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/pipeline.css', 'text/css'],
      ['/fixtures.json', 'application/json'], ['/src/trace-model.mjs', 'text/javascript'],
      ['/src/trace-view.mjs', 'text/javascript'], ['/src/pipeline-path.mjs', 'text/javascript']
    ]) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get('content-type').startsWith(type), path);
      assert.ok((await response.text()).length > 0, path);
    }
    assert.equal((await fetch(`${server.url}/missing`)).status, 404);
    assert.equal((await fetch(`${server.url}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${server.url}/%ZZ`)).status, 400);
    assert.equal((await fetch(`${server.url}/src/..%2F.git%2Fconfig`)).status, 404);
    // Bad URLs must not take down the server.
    assert.equal((await fetch(`${server.url}/`)).status, 200);
  } finally {
    await server.stop();
  }
});
