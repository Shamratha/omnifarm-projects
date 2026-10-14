import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function startLocalServer() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exit = once(child, 'exit');
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Server startup timed out: ${output}`)); }, 10000);
    const failed = error => { clearTimeout(timeout); reject(error); };
    child.once('error', failed);
    child.once('exit', code => failed(new Error(`Server exited before ready (${code}): ${output}`)));
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
  return { url, stop: async () => { child.kill(); await exit; } };
}
