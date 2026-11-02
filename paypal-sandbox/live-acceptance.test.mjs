import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { localOrigin, sandboxApprovalLink, verifiedCapture } from './live-acceptance.mjs';

test('rejects non-local, insecure, and credentialed gateway URLs', () => {
  for (const host of ['https://api-m.paypal.com', 'http://example.com:4202', 'http://127.0.0.1:4202/evil', 'http://evil@localhost:4202/'])
    assert.throws(() => localOrigin(host));
  assert.equal(localOrigin(), 'http://127.0.0.1:4202');
});
test('only accepts sandbox PayPal buyer approval URL', () => {
  assert.equal(sandboxApprovalLink({ links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ABC' }] }),
    'https://www.sandbox.paypal.com/checkoutnow?token=ABC');
  assert.throws(() => sandboxApprovalLink({ links: [{ rel: 'approve', href: 'https://www.paypal.com/checkoutnow?token=ABC' }] }));
  assert.throws(() => sandboxApprovalLink({ links: [] }));
});
test('requires completed capture status with exact amount, currency and order ID', () => {
  const a = { id: 'ORDER12345', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.01' } }] } }] };
  assert.equal(verifiedCapture(a, 'ORDER12345', '0.01').captureId, 'CAPTURE123');
  assert.throws(() => verifiedCapture(a, 'WRONGORDER', '0.01'));
  assert.throws(() => verifiedCapture(a, 'ORDER12345', '1.00'));
  assert.throws(() => verifiedCapture({ ...a, status: 'APPROVED' }, 'ORDER12345', '0.01'));
  assert.throws(() => verifiedCapture({ ...a, purchase_units: [{ payments: { captures: [{ ...a.purchase_units[0].payments.captures[0], status: 'PENDING' }] } }] }, 'ORDER12345', '0.01'));
});

