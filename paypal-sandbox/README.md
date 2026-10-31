# SellerPilot PayPal AI Hackathon 2026 — sandbox Orders gateway

**STATUS: API CODE ADDED, NOT END-TO-END VERIFIED AGAINST PAYPAL; NOT A HACKATHON SUBMISSION.** The original SellerPilot dashboard was built for Meta Global AI Developer Hackathon; this gateway is a subsequent, substantial but still incomplete PayPal-specific implementation.

An isolated localhost-only Node.js server implements official **PayPal Orders v2** create, get and capture paths using server-side OAuth 2.0 client credentials. Order creation and capture require an explicit `approved: true` flag **and** a long server-issued `API_APPROVAL_TOKEN` bearer secret. A buyer still must approve an order in the PayPal sandbox before capture. No real transactions are supported.

Optional AI endpoint calls a real OpenAI-compatible `/chat/completions` provider using environment-supplied credentials and a minimal scrubbed order summary. **It fails closed without a configured model**—there is no fabricated AI output. The existing Meta model route remains gated. No model service or PayPal credentials have been verified by this module alone.

## Safe retries in the local browser demo

The demo uses in-memory, caller-stable `PayPal-Request-Id` keys for repeated create/capture requests until **Start a new order** is explicitly clicked. This avoids changing idempotency keys merely because a request times out. The keys are lost on page reload or process restart; there is **no durable order/capture journal or cross-device duplicate protection**. Before retrying an ambiguous capture, GET the order status and confirm it is still APPROVED. The current test UI is not a production payment frontend and has no proven live PayPal transaction.

## Setup

Node.js 20+. From this subdirectory:

```sh
npm test
# In a private .env or shell (do not commit secrets):
export PAYPAL_SANDBOX_CLIENT_ID='YOUR_SANDBOX_CLIENT_ID'
export PAYPAL_SANDBOX_CLIENT_SECRET='YOUR_SANDBOX_CLIENT_SECRET'
export API_APPROVAL_TOKEN='GENERATE_A_RANDOM_SECRET_WITH_AT_LEAST_32_CHARACTERS'
# Optional model settings for live AI, all required to activate:
export MODEL_CHAT_COMPLETIONS_URL='https://YOUR_TRUSTED_PROVIDER/v1/chat/completions'
export MODEL_ID='YOUR_MODEL'
export MODEL_API_KEY='YOUR_MODEL_TOKEN'
node index.mjs
```

Service binds **127.0.0.1 only**, port 4202. All non-health endpoints require `Authorization: Bearer <API_APPROVAL_TOKEN>`. `POST /orders` body: `{"amount":"1.00","requestId":"your-stable-unique-key","approved":true}`. Returns PayPal sandbox order details with a buyer approval URL when connected to a live sandbox. After a buyer approves, `POST /orders/<ID>/capture` with `{"requestId":"stable-capture-key","approved":true}`. `POST /orders/<ID>/explain` uses configured live AI. **Never use production accounts, cards, credentials, or payment endpoints.**

The demo server provides no persistent audit DB, user identity verification, web UI, host security or anti-CSRF protections. It must not be made publicly reachable until proper authentication, approvals, persistent idempotency and audit storage are implemented and independently assessed. **It has only mock tests; there is no verified sandbox execution or demo video yet.**

## References
- https://developer.paypal.com/api/rest/authentication
- https://developer.paypal.com/api/rest/integration/orders-api
- https://developer.paypal.com/api/make-api-requests
- https://paypalaihackathon.devpost.com/rules

## Next acceptance gates
- [ ] Obtain real developer sandbox credentials in correct jurisdiction; verify actual create/approve/capture with evidence.
- [ ] Provide browser demo UI, operational LLM and human approval UX.
- [ ] Add secure persistent state/audit and deployable judge demo or complete local run flow.
- [ ] Determine lawful open-source license after auditing inherited assets; add top-level LICENSE.
- [ ] Record and publish new under-three-minute **YouTube** demo, submit final Devpost entry, verify confirmation.
