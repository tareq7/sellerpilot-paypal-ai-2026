# PayPal AI Hackathon 2026 — submission preparation

**Status:** NOT SUBMITTED. No PayPal sandbox feature or event-specific functional demo has been verified.

**Repository:** https://github.com/tareq7/sellerpilot-paypal-ai-2026

**Provenance:** Full-history derivative of https://github.com/tareq7/sellerpilot-ai, originally developed for the Meta Global AI Developer Hackathon in October 2026. Disclose inherited and newly written components in the final form. The Meta submission is a different event and remains unchanged.

## Proposed project

Seller-facing payment approval and reconciliation flow: combine existing stock/spend recommendations with PayPal sandbox Orders API and a bounded AI assistant that explains order/payment outcomes. Keep all real payment actions sandbox-only and human-approved.

## What is implemented

The original SellerPilot stock-aware commerce analytics, synthetic demonstration, bilingual interface and deterministic calculations are present. The model-assisted endpoint is intentionally disabled in the public demo. **No PayPal integration exists in this cloned baseline.**

## Outstanding proof

- [ ] Integrate a real, testable PayPal sandbox API or SDK as a central feature (for example Orders v2, approved seller checkout and refund simulation).
- [ ] Make AI operational in the user experience. The inherited Meta API route is disabled, so it cannot be represented as working AI integration.
- [ ] Implement and test significant functionality in this hackathon's submission period; disclose prior work and provide a clear change log.
- [ ] Publish an actual functional build, publicly accessible source and an explicit open-source LICENSE file.
- [ ] Record an event-specific YouTube demo under three minutes, demonstrating the PayPal sandbox and AI behavior.

**Never submit a description claiming completed PayPal API payments, new AI inference, or a revised video until they are working and independently verified.**
