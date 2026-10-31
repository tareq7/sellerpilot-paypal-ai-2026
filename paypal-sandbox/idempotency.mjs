/**
 * Local UI retry keys. This is NOT durable or a replacement for PayPal-side idempotency.
 * Kept in memory and reused for retries of the same logical operation.
 */
export function createOperationIds(makeId = () => globalThis.crypto.randomUUID().replaceAll('-', '')) {
  const entries = new Map();
  return Object.freeze({
    get(action, subject) {
      if (!['create', 'capture'].includes(action) || typeof subject !== 'string' || !subject.trim()) {
        throw new Error('Invalid operation identity');
      }
      const key = action + ':' + subject;
      if (!entries.has(key)) {
        const id = makeId();
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
          throw new Error('Idempotency key generator failed');
        }
        entries.set(key, id);
      }
      return entries.get(key);
    },
    reset() { entries.clear(); },
    count() { return entries.size; }
  });
}
