# SellerPilot PayPal AI Hackathon 2026 — sandbox Orders gateway

**STATUS: Direct PayPal developer sandbox API payment verified on November 2. The SellerPilot gateway has automated tests; its own credentialed checkout and live AI response remain unverified. NOT a final submission.** The original SellerPilot dashboard was built for Meta Global AI Developer Hackathon; this gateway is a subsequent, substantial but still incomplete PayPal-specific implementation.

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

## Sandbox-only acceptance helper

`live-acceptance.mjs` is a local QA tool that calls **this application's localhost gateway**, not PayPal production. It operates on a fixed simulated USD 0.01 order and preserves non-secret request IDs so an interrupted operation does not silently use a new idempotency key.

1. Set `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`, and a randomly generated 32+-character `API_APPROVAL_TOKEN` privately (never commit or share them). Start `node index.mjs` on the developer machine.
2. In a second terminal with the same `API_APPROVAL_TOKEN`, run `node live-acceptance.mjs create`. It prints the order ID and an HTTPS buyer link on **sandbox.paypal.com** only.
3. Approve the order using a **personal PayPal sandbox buyer** and simulated PayPal funds. Then run `node live-acceptance.mjs inspect` to confirm `APPROVED`.
4. Run `node live-acceptance.mjs capture --confirm-sandbox-capture`. The CLI requires the explicit flag and only reports success after validating a `COMPLETED` capture ID, matching order ID, and exact USD 0.01 amount. A repeat call checks the existing completed capture rather than charging again.
5. With a legitimate configured OpenAI-compatible AI endpoint, run `node live-acceptance.mjs explain`; it fails closed if the model does not actually answer.

The CLI stores the current **non-secret** operation state in a user-local temporary file and refuses to start a new logical order while that state exists. Keep that file private. Do not manually delete it after an uncertain network failure; investigate the status and original idempotency key first. On Windows PowerShell, use `$env:KEY = 'value'` instead of Unix `export KEY='value'`.

A compatible optional free-plan model endpoint is Groq `https://api.groq.com/openai/v1/chat/completions` with `MODEL_ID=openai/gpt-oss-20b`, subject to the developer's actual free quota and having a valid private API key. The repository contains **no model credentials or paid-usage authorization**.

Run `node --test` or `npm test` inside this directory for acceptance-helper, gateway, and startup tests. **A passing mock test does not constitute a live PayPal payment or a real AI inference.**
