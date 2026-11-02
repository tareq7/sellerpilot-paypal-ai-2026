import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('.', import.meta.url));

async function freeLocalPort() {
  const srv = createServer();
  await new Promise((resolve, reject) => srv.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise(resolve => srv.close(resolve));
  return port;
}

test('Node entrypoint starts localhost-only gateway on Windows and POSIX', { timeout: 12000 }, async () => {
  const port = await freeLocalPort();
  const child = spawn(process.execPath, ['index.mjs'], {
    cwd: folder,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port),
      PAYPAL_SANDBOX_CLIENT_ID: '', PAYPAL_SANDBOX_CLIENT_SECRET: '',
      API_APPROVAL_TOKEN: '', MODEL_CHAT_COMPLETIONS_URL: '',
      MODEL_ID: '', MODEL_API_KEY: ''
    }
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    let health;
    for (let attempt = 0; attempt < 35; attempt++) {
      if (child.exitCode !== null) throw new Error('Gateway process exited early: ' + output.slice(0, 200));
      try {
        health = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) });
        if (health.ok) break;
      } catch { /* allow process startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(health?.ok, 'Gateway did not start on the configured localhost port');
    const state = await health.json();
    assert.equal(state.mode, 'SANDBOX_ONLY');
    assert.equal(state.configured, false);
    assert.equal(state.aiConfigured, false);
  } finally {
    child.kill();
  }
});
