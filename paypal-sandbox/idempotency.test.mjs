import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationIds } from './idempotency.mjs';

test('repeated HTTP timeouts retain the same logical create id', () => {
  let count=0; const store=createOperationIds(()=> 'request000' + ++count);
  assert.equal(store.get('create','1.00'),store.get('create','1.00'));
  assert.equal(count,1);
});
test('different operation and subject generate distinct keys', () => {
  let count=0;const store=createOperationIds(()=> 'request000' + ++count);
  const first=store.get('create','1.00');
  assert.notEqual(first,store.get('create','2.00'));
  assert.notEqual(first,store.get('capture','9HX123456789'));
});
test('new order requires an explicit reset', () => {
  let count=0;const store=createOperationIds(()=> 'request000' + ++count);
  const before=store.get('create','1.00');
  store.reset();
  assert.notEqual(before,store.get('create','1.00'));
});
test('rejects invalid operation and missing/untrusted key identifiers', () => {
  const store=createOperationIds(()=> 'bad');
  assert.throws(()=>store.get('create','1.00'));
  assert.throws(()=>store.get('refund','1.00'));
  assert.throws(()=>store.get('capture',''));
});
