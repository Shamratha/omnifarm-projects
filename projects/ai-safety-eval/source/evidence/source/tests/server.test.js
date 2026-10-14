import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function ownedServer(t) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Test server did not report its owned listening port.')), 10000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Test server exited (${code}) before readiness.`)));
    child.stdout.on('data', (data) => {
      output += data.toString();
      const match = output.match(/Guardrail is ready at http:\/\/localhost:(\d+)/u);
      if (!match) return;
      clearTimeout(timer);
      assert.ok(Number(match[1]) > 0, 'Server must report the allocated port, not requested port 0.');
      resolve(`http://127.0.0.1:${match[1]}`);
    });
  });
}

test('parallel local servers own distinct allocated ports and serve the static application assets', async (t) => {
  const [first, second] = await Promise.all([ownedServer(t), ownedServer(t)]);
  assert.notEqual(first, second, 'Parallel verification must not reuse or collide on a fixed port.');
  for (const baseURL of [first, second]) {
    for (const path of ['/', '/styles.css', '/src/app.js', '/src/evaluation.js', '/src/fixtures.js', '/src/presentation.js', '/src/workspace.js', '/src/icons.js']) {
      const response = await fetch(baseURL + path, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, `${path} is present in the static package.`);
      assert.ok((await response.text()).length > 0);
      assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
      if (path.endsWith('.js')) assert.match(response.headers.get('content-type'), /text\/javascript/);
    }
  }
});
