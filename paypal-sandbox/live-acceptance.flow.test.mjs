import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

function cli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['live-acceptance.mjs', ...args], { cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.once('close', code => resolve({ code, out, err }));
  });
}
test('complete mock gateway sequence is idempotent, human-gated, and never calls PayPal production', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sellerpilot-liveqa-test-'));
  let orders = 0, captures = 0, status = 'CREATED', explanations = 0;
  const fake = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    let body = { error: 'unknown' }, http = 404;
    if (req.method === 'POST' && req.url === '/orders') {
      orders++; assert.equal(data.amount, '0.01');
      body = { id: 'ABCD123456', status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ABCD123456' }] }; http = 201;
    } else if (req.method === 'GET' && req.url === '/orders/ABCD123456') {
      body = { id: 'ABCD123456', status, purchase_units: [{ payments: { captures: status === 'COMPLETED' ? [{ id: 'CAPTURE123456', status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.01' } }] : [] } }] }; http = 200;
    } else if (req.method === 'POST' && req.url === '/orders/ABCD123456/capture') {
      assert.equal(data.approved, true); captures++; status = 'COMPLETED';
      body = { id: 'ABCD123456', status, purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123456', status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.01' } }] } }] }; http = 200;
    } else if (req.method === 'POST' && req.url === '/orders/ABCD123456/explain') {
      explanations++; body = { explanation: 'Sandbox order is completed. No shipping conclusion.', model: 'fixture/test-model' }; http = 200;
    }
    res.writeHead(http, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  try {
    await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
    const env = { API_APPROVAL_TOKEN: 'x'.repeat(40), GATEWAY_ORIGIN: 'http://127.0.0.1:' + fake.address().port, PAYPAL_QA_STATE_PATH: join(dir, 'qa.json') };
    let r = await cli(['create'], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /sandbox_order_created/);
    r = await cli(['create'], env); assert.notEqual(r.code, 0); assert.equal(orders, 1, 'duplicate order was attempted');
    status = 'APPROVED';
    r = await cli(['inspect'], env); assert.equal(r.code, 0); assert.match(r.out, /APPROVED/);
    r = await cli(['capture'], env); assert.notEqual(r.code, 0); assert.equal(captures, 0);
    r = await cli(['capture', '--confirm-sandbox-capture'], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /sandbox_capture_verified/); assert.equal(captures, 1);
    r = await cli(['capture', '--confirm-sandbox-capture'], env); assert.equal(r.code, 0); assert.match(r.out, /already_captured_no_retry/); assert.equal(captures, 1);
    r = await cli(['explain'], env); assert.equal(r.code, 0, r.err); assert.match(r.out, /fixture\/test-model/); assert.equal(explanations, 1);
  } finally { await new Promise(resolve => fake.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

