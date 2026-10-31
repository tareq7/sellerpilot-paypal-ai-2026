import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const ORIGIN = 'https://api-m.sandbox.paypal.com';
const ORDER_ID = /^[A-Z0-9]{8,32}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/;
const WAIT_MS = 15000;

export class SafeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function requireCredentials(id, secret) {
  if (!id || !secret) throw new SafeError('PayPal SANDBOX credentials not configured', 503);
}
function strictAmount(value) {
  if (typeof value !== 'string' || !MONEY.test(value) || Number(value) < 0.01 || Number(value) > 10) {
    throw new SafeError('Amount must be a USD string from 0.01 through 10.00');
  }
  return value;
}
function idempotency(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new SafeError('Valid caller-stable requestId is required');
  return value;
}
async function jsonOrError(response, label) {
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new SafeError(label + ' gave non-JSON response', 502); }
  if (!response.ok) {
    // No raw provider body or access tokens are logged or returned.
    throw new SafeError(label + ' failed (HTTP ' + response.status + ')', 502);
  }
  return parsed;
}
export class PayPalSandbox {
  constructor({ clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID, clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET, fetcher = globalThis.fetch, clock = () => Date.now() } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetcher = fetcher;
    this.clock = clock;
    this.token = '';
    this.expiresAt = 0;
  }
  async accessToken() {
    requireCredentials(this.clientId, this.clientSecret);
    if (this.token && this.clock() < this.expiresAt) return this.token;
    const response = await this.fetcher(ORIGIN + '/v1/oauth2/token', {
      method: 'POST',
      signal: AbortSignal.timeout(WAIT_MS),
      headers: { Authorization: 'Basic ' + Buffer.from(this.clientId + ':' + this.clientSecret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const data = await jsonOrError(response, 'OAuth');
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new SafeError('Incomplete OAuth response', 502);
    this.token = data.access_token;
    this.expiresAt = this.clock() + Math.max(0, data.expires_in - 90) * 1000;
    return this.token;
  }
  async request(method, path, body, requestId) {
    const token = await this.accessToken();
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = idempotency(requestId);
    const response = await this.fetcher(ORIGIN + path, {
      method, headers, signal: AbortSignal.timeout(WAIT_MS), ...(body ? { body: JSON.stringify(body) } : {})
    });
    return jsonOrError(response, 'PayPal Orders v2');
  }
  async createOrder({ amount, requestId, approved }) {
    if (approved !== true) throw new SafeError('Explicit human approval required', 403);
    const value = strictAmount(amount);
    return this.request('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: 'SELLERPILOT_SYNTHETIC_DEMO', description: 'Synthetic test inventory only', amount: { currency_code: 'USD', value } }]
    }, requestId);
  }
  async getOrder(orderId) {
    if (!ORDER_ID.test(orderId || '')) throw new SafeError('Invalid order id');
    return this.request('GET', '/v2/checkout/orders/' + orderId);
  }
  async captureOrder({ orderId, requestId, approved }) {
    if (approved !== true) throw new SafeError('Explicit human approval required', 403);
    idempotency(requestId);
    const order = await this.getOrder(orderId);
    if (order.status !== 'APPROVED') throw new SafeError('Buyer has not approved order', 409);
    return this.request('POST', '/v2/checkout/orders/' + orderId + '/capture', {}, requestId);
  }
}
export async function explainOrderWithModel(order, { endpoint = process.env.MODEL_CHAT_COMPLETIONS_URL, model = process.env.MODEL_ID, key = process.env.MODEL_API_KEY, fetcher = globalThis.fetch } = {}) {
  if (!endpoint || !model || !key) throw new SafeError('Live AI inference not configured (no fabricated fallback)', 503);
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) {
    throw new SafeError('Model endpoint must be HTTPS or localhost');
  }
  const safeOrder = { id: String(order.id || '').slice(0, 50), status: String(order.status || '').slice(0, 30), amount: order.purchase_units?.[0]?.amount ?? null };
  const r = await fetcher(url, { method: 'POST', signal: AbortSignal.timeout(WAIT_MS),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 256, messages: [
      { role: 'system', content: 'Explain the PayPal SANDBOX status of a synthetic demo order to a merchant. Use only given fields. Do not infer capture or shipment. Say when unpaid or awaiting buyer approval. Do not request purchases.' },
      { role: 'user', content: JSON.stringify(safeOrder) }
    ] })
  });
  const data = await jsonOrError(r, 'AI inference');
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new SafeError('No valid AI output', 502);
  return { explanation: content, model, order: safeOrder };
}
function verifiedApproval(req, env) {
  const actual = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const expected = env.API_APPROVAL_TOKEN;
  if (!expected || expected.length < 32) throw new SafeError('Local approval token not configured', 503);
  if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new SafeError('Unauthorized', 401);
}
async function readBody(req) {
  let content = '';
  for await (const chunk of req) {
    content += chunk.toString('utf8');
    if (content.length > 4096) throw new SafeError('Request too large', 413);
  }
  try { return content ? JSON.parse(content) : {}; } catch { throw new SafeError('Invalid JSON'); }
}
export function makeServer({ client = new PayPalSandbox(), env = process.env, explain = explainOrderWithModel } = {}) {
  return createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.url === '/health' && req.method === 'GET') return respond(200, {
        mode: 'SANDBOX_ONLY', configured: Boolean(env.PAYPAL_SANDBOX_CLIENT_ID && env.PAYPAL_SANDBOX_CLIENT_SECRET && env.API_APPROVAL_TOKEN), aiConfigured: Boolean(env.MODEL_CHAT_COMPLETIONS_URL && env.MODEL_ID && env.MODEL_API_KEY)
      });
      verifiedApproval(req, env);
      if (req.url === '/orders' && req.method === 'POST') return respond(201, await client.createOrder(await readBody(req)));
      const capture = /^\/orders\/([A-Z0-9]{8,32})\/capture$/.exec(req.url || '');
      if (capture && req.method === 'POST') {
        const body = await readBody(req);
        return respond(200, await client.captureOrder({ orderId: capture[1], ...body }));
      }
      const retrieve = /^\/orders\/([A-Z0-9]{8,32})$/.exec(req.url || '');
      if (retrieve && req.method === 'GET') return respond(200, await client.getOrder(retrieve[1]));
      const explainMatch = /^\/orders\/([A-Z0-9]{8,32})\/explain$/.exec(req.url || '');
      if (explainMatch && req.method === 'POST') return respond(200, await explain(await client.getOrder(explainMatch[1]), { endpoint: env.MODEL_CHAT_COMPLETIONS_URL, model: env.MODEL_ID, key: env.MODEL_API_KEY }));
      return respond(404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof SafeError ? error.status : 502;
      return respond(status, { error: error instanceof SafeError ? error.message : 'Upstream service unavailable' });
    }
  });
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  // Explicitly localhost-only. Do not deploy without session auth and risk review.
  const port = Number(process.env.PORT || 4202);
  makeServer().listen(port, '127.0.0.1', () => console.log('SellerPilot PayPal SANDBOX gateway on localhost:' + port));
}
