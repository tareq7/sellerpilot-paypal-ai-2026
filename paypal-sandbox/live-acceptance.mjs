import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function localOrigin(value = 'http://127.0.0.1:4202') {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    throw new Error('Gateway must be a local-only http://127.0.0.1:<port> URL');
  }
  return u.origin;
}
export function sandboxApprovalLink(order) {
  const candidate = order?.links?.find(x => x.rel === 'approve' || x.rel === 'payer-action')?.href;
  if (typeof candidate !== 'string') throw new Error('PayPal did not return buyer approval link');
  const u = new URL(candidate);
  if (u.protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(u.hostname)) throw new Error('Approval link is not a PayPal sandbox URL');
  return u.href;
}
export function verifiedCapture(order, expectedOrderId, expectedAmount) {
  const captures = order?.purchase_units?.flatMap(p => p.payments?.captures || []) || [];
  const completed = captures.find(c => c.status === 'COMPLETED');
  const total = completed?.amount;
  if (order?.id !== expectedOrderId || order?.status !== 'COMPLETED' || !completed?.id ||
      total?.currency_code !== 'USD' || total?.value !== expectedAmount) {
    throw new Error('PayPal order/capture/amount not independently verified');
  }
  return { orderId: order.id, orderStatus: order.status, captureId: completed.id, captureStatus: completed.status, amount: total.value, currency: total.currency_code };
}
const key = () => 'paypalqa_' + randomUUID().replaceAll('-', '');
const path = process.env.PAYPAL_QA_STATE_PATH || join(tmpdir(), 'sellerpilot-paypal-sandbox-qa.json');
function readState() {
  if (!existsSync(path)) return null;
  const s = JSON.parse(readFileSync(path, 'utf8'));
  if (s.mode !== 'sandbox' || s.amount !== '0.01') throw new Error('Existing state is not the expected sandbox-only $0.01 session');
  return s;
}
function saveState(s) {
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* Windows access controls may differ */ }
}
async function api(method, endpoint, body) {
  const token = process.env.API_APPROVAL_TOKEN;
  if (!token || token.length < 32) throw new Error('API_APPROVAL_TOKEN must be set in the local environment (32+ characters)');
  const origin = localOrigin(process.env.GATEWAY_ORIGIN);
  const r = await fetch(origin + endpoint, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Local gateway returned HTTP ' + r.status + ': ' + String(j.error || 'request failed').slice(0, 100));
  return j;
}
async function main() {
  const action = process.argv[2];
  if (!['create', 'inspect', 'capture', 'explain'].includes(action)) throw new Error('Usage: node live-acceptance.mjs create|inspect|capture|explain');
  let s = readState();
  if (action === 'create') {
    if (s?.orderId) throw new Error('Existing sandbox order found. Use inspect/capture; do not create duplicates. To start anew, explicitly remove PAYPAL_QA_STATE_PATH after recording evidence.');
    if (!s) { s = { mode: 'sandbox', amount: '0.01', createRequestId: key(), orderId: null, captureRequestId: null }; saveState(s); }
    const o = await api('POST', '/orders', { amount: s.amount, requestId: s.createRequestId, approved: true });
    if (!/^[A-Z0-9]{8,32}$/.test(o?.id || '') || !['CREATED', 'APPROVED'].includes(o.status)) throw new Error('Order created but provider response not verified');
    const approval = sandboxApprovalLink(o);
    s.orderId = o.id; saveState(s);
    console.log(JSON.stringify({ result: 'sandbox_order_created', orderId: o.id, orderStatus: o.status, amount: s.amount, approvalUrl: approval }, null, 2));
  } else {
    if (!s?.orderId) throw new Error('No saved sandbox order: run create first');
    const o = await api('GET', '/orders/' + s.orderId);
    if (action === 'inspect') {
      const c = o.purchase_units?.flatMap(p => p.payments?.captures || []).find(x => x.status === 'COMPLETED');
      console.log(JSON.stringify({ orderId: o.id, orderStatus: o.status, captureId: c?.id ?? null, captureStatus: c?.status ?? null }, null, 2));
      return;
    }
    if (action === 'capture') {
      if (!process.argv.includes('--confirm-sandbox-capture')) throw new Error('Capture requires explicit --confirm-sandbox-capture flag; use sandbox buyer approval first');
      if (o.status === 'COMPLETED') { console.log(JSON.stringify({ result: 'already_captured_no_retry', ...verifiedCapture(o, s.orderId, s.amount) }, null, 2)); return; }
      if (o.status !== 'APPROVED') throw new Error('Buyer has not approved this sandbox order; no capture was attempted');
      if (!s.captureRequestId) { s.captureRequestId = key(); saveState(s); }
      const captured = await api('POST', '/orders/' + s.orderId + '/capture',
        { requestId: s.captureRequestId, approved: true });
      console.log(JSON.stringify({ result: 'sandbox_capture_verified', ...verifiedCapture(captured, s.orderId, s.amount) }, null, 2));
    } else {
      verifiedCapture(o, s.orderId, s.amount);
      const reply = await api('POST', '/orders/' + s.orderId + '/explain', {});
      if (!reply?.explanation || !reply?.model) throw new Error('No verified live model output');
      console.log(JSON.stringify({ result: 'live_model_explanation', orderId: s.orderId, model: reply.model, explanation: reply.explanation }, null, 2));
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error('PAYPAL_SANDBOX_QA_FAILED: ' + e.message); process.exitCode = 1; });
}

