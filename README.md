# SellerPilot AI — PayPal AI Hackathon 2026

I’m building SellerPilot PayPal AI so a seller can check an order, test a PayPal checkout, and get a simple explanation before taking action. I confirmed one simulated checkout directly through PayPal’s sandbox. The full checkout through my app and the live AI explanation still need their own end-to-end tests, so this project is not ready for final submission yet.


[PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) · [Sandbox gateway](paypal-sandbox/README.md) · [Original SellerPilot project](https://github.com/tareq7/sellerpilot-ai)

## Project

SellerPilot helps merchants review inventory and advertising decisions alongside a controlled, **sandbox-only** checkout workflow. The PayPal-specific gateway implements REST OAuth 2.0 and Orders v2 to create and retrieve synthetic orders, direct a buyer to PayPal's sandbox approval page, and capture an approved order. No production PayPal payments or real funds are involved.

An optional OpenAI-compatible model endpoint explains the current order state using limited synthetic fields. It fails closed when live inference is not configured; there is no fabricated model response.

The project also retains the original bilingual (English/Arabic) inventory, campaign, evidence, and what-if dashboards.

## What is implemented

- PayPal Orders v2 sandbox API client, server-side OAuth, create/get/capture routes, and localhost-only demonstration UI.
- Explicit merchant approval checks and caller-stable request IDs for safe retries.
- Buyer approval performed separately in the official PayPal sandbox.
- Live model-provider adapter for merchant-facing transaction explanations, with bounded order fields.
- Automated tests covering authorization, retries, denied capture, API failure, and AI fail-closed behavior.

## Verification status

A **direct developer sandbox API test** on November 2, 2026 successfully authenticated, created a simulated USD 0.01 order, obtained personal sandbox-buyer approval, captured it, and independently rechecked its `COMPLETED` status.

**Scope of that evidence:** the direct PayPal developer API test confirms the sandbox credentials and PayPal payment lifecycle. It was **not executed through the SellerPilot gateway or browser demo**. The gateway has passing mock/regression tests, but its own authenticated end-to-end run and a real model-generated explanation still require verification. No final hackathon submission is claimed here.

## Run locally

**Requirements:** Node.js 22+ and npm for the dashboard; the standalone PayPal sandbox gateway supports Node.js 20+.

```bash
git clone https://github.com/tareq7/sellerpilot-paypal-ai-2026.git
cd sellerpilot-paypal-ai-2026
npm ci
npm test
npm run build
```

For the separate PayPal gateway, enter sandbox-only credentials in a **private terminal environment**, never in source code, public issues, or screenshots:

```bash
cd paypal-sandbox
export PAYPAL_SANDBOX_CLIENT_ID='YOUR_SANDBOX_CLIENT_ID'
export PAYPAL_SANDBOX_CLIENT_SECRET='YOUR_SANDBOX_CLIENT_SECRET'
export API_APPROVAL_TOKEN='A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS'
node index.mjs
```

Browse to [http://127.0.0.1:4202/demo](http://127.0.0.1:4202/demo), enter the local approval token, create a synthetic order, approve using a **personal PayPal sandbox buyer account**, refresh the order, and capture it only after approval.

Optionally, configure `MODEL_CHAT_COMPLETIONS_URL`, `MODEL_ID`, and `MODEL_API_KEY` for a genuine supported chat-completions provider before starting the gateway. The app reports model errors rather than supplying fictitious explanations.

For API request formats, current safety constraints, and regression tests, see [paypal-sandbox/README.md](paypal-sandbox/README.md).

## Security boundaries

- PayPal API calls target `https://api-m.sandbox.paypal.com` only.
- The gateway listens on `127.0.0.1`; do **not** expose it publicly without additional security review.
- The app uses synthetic test fixtures, not private customer records.
- Buyer approval and server-side capture are separate, explicit actions.
- This is a hackathon prototype, not a production checkout, identity, or accounting service. It lacks production-grade session management, durable audit infrastructure, and multi-tenant authorization.

## Original work and attribution

This repository is an adaptation of [SellerPilot AI](https://github.com/tareq7/sellerpilot-ai), developed for the October 2026 Meta Global AI Developer Hackathon. Its original bilingual interface, inventory/advertising analysis and demo media predate the PayPal event. The PayPal-specific gateway, simulated checkout UI and corresponding tests were developed for this hackathon. Original Git history is retained for transparent attribution and judging.

## License, demo and final submission

A top-level software `LICENSE` and documented rights for inherited images/video must be finalized before a qualifying submission. Public source, a reproducible functional demo, and a new **public YouTube video shorter than three minutes** are required by the [official PayPal AI Hackathon rules](https://paypalaihackathon.devpost.com/rules).

**Submission deadline:** November 12, 2026, 12:00 PM Pacific Time.

This README describes the current candidate and its verified evidence; it does not claim the final Devpost entry has been submitted.
