# Meta Webhook Security Offline — F1B-09

## 1. Purpose

Implement and test an HTTP-independent Meta webhook security boundary using
synthetic bytes and secrets only. **NO LIVE WHATSAPP CONNECTION EXISTS IN F1B-09.**

## 2. Scope

Provider-specific authentication and handshake implementations reuse gateway
raw requests, crypto primitives, authentication/handshake ports, the strict
F1B-08 decoder, durable idempotency contract, resolution ports, and readiness.

## 3. Explicit Non-Goals

No server, listening port, network, provider access, credential provisioning,
deployment, production store, worker, or CRM write. No dependency/npm change.
Private data is neither read nor moved into this repository.

## 4. Evidence Provenance

The supplied F1B-09 evidence authorizes offline implementation of archived Meta
security behavior. It does not establish current live verification. No new Meta
documentation or service was accessed. See `meta-official-protocol-evidence.md`.

## 5. Current Meta Official Evidence

`CURRENT_META_OFFICIAL` covers the supplied baseline: official Cloud API,
webhook events, WABA subscription, HTTPS/TLS, `whatsapp_business_account`,
entry/changes/value/messages, WhatsApp messaging product, metadata, supported
sent/delivered/read/failed statuses, timestamp preservation and unordered arrival.

## 6. Meta Official Archived Evidence

`META_OFFICIAL_ARCHIVED` covers GET hub.mode / hub.verify_token / hub.challenge,
challenge return after verification, POST x-hub-signature-256, App Secret,
HMAC SHA-256 over exact raw bytes, sha256=hex, and invalid-request rejection.

## 7. Current Reconfirmation Requirement

All archived security behavior remains `PENDING_CURRENT_META_RECONFIRMATION`.
`CURRENT_META_RECONFIRMATION_REQUIRED` is the phase requirement, represented by
the runtime blocker `CURRENT_META_PROTOCOL_RECONFIRMATION_REQUIRED`.
Archived evidence is never promoted to current by a caller flag.

## 8. Raw Body

`createLiveWebhookRequest` copies `Uint8Array` bytes, normalizes header names,
and retains ambiguous duplicates as comma-separated values for rejection.
The handler checks POST size before copying, snapshots the request before
resolving secrets, and authenticates precisely that snapshot. JSON parsing uses
the existing fatal UTF-8 decoder. Re-serialized JSON cannot substitute for raw
bytes. A future HTTP capture layer must preserve duplicates and bytes before
parsing; this phase does not implement that layer.

## 9. Signature Header

Only a single normalized `x-hub-signature-256` value with exact lowercase prefix
`sha256=` and 64 hex characters is accepted. Uppercase hex is valid. Empty,
non-hex, wrong algorithm/length, duplicate, comma-list and newline values fail
closed. Missing/malformed headers do not invoke the decoder.

## 10. HMAC SHA-256

`MetaWebhookAuthenticator` delegates to `InjectedHmacDigestVerifier` with the
resolved App Secret bytes and Node built-in SHA-256 HMAC. It never signs a parsed
object. Only `VERIFIED` proceeds; `REJECTED` and `NOT_CONFIGURED` stop processing.

## 11. Timing-Safe Comparison

The existing digest primitive checks equal byte lengths then uses Node
`timingSafeEqual`. Verify-token equality compares fixed-size SHA-256 digests
through the same crypto module. No textual secret/digest equality is used.
The implementation path is tested with a real primitive spy and source assertion.

## 12. App Secret Reference

`MetaWebhookSecurityConfig.appSecretRef` contains an opaque `SecretRef` only.
The local reference policy accepts a single `id` field with the `secret-ref-`
prefix and bounded alphanumeric/hyphen identifier. IDs must not contain secret
material. Extra config/reference value fields are rejected. The synchronous
`SecretResolver` port returns copied bytes or `NOT_CONFIGURED`; resolver errors
are sanitized. Production defaults to `UnconfiguredSecretResolver`.

## 13. Verify Token Reference

`verifyTokenRef` uses the same resolver. `InMemorySyntheticSecretResolver` is
test/simulator infrastructure only, copies inputs/outputs and keeps bytes in
private fields. Neither config nor audit contains token values. The existing
generic `ProviderSecretRefs` contract remains compatible.

## 14. GET Handshake

Require mode `subscribe`, a nonempty matching verify token and a valid challenge.
Local security policy limits the token to 4096 characters and challenge to 1–256
ASCII digits. Missing, repeated/array, malformed or incorrect values reject.
Only successful verification returns the exact challenge (including leading
zeroes), HTTP 200 and text/plain. Error codes 403/503 and challenge bounds are
**LOCAL IMPLEMENTATION POLICY**, not current Meta facts. GET ignores event body
and never decodes or acquires an idempotency record.

## 15. Pure HTTP Handler

`handleMetaWebhookRequest(request, dependencies)` returns statusCode, allowlisted
headers, body, optional internal processingResult and sanitized audit. It accepts
GET/POST; other methods return 405 with Allow: GET, POST before any processing.
It uses injected synchronous ports, an optional clock and opaque ID generation;
it does no external I/O. It is HTTP-independent, not a claim of mathematical
purity or production transport readiness. Only `body` is an HTTP response body;
processingResult contains transient internal event data and must never be logged
or serialized as the HTTP response.

## 16. POST Processing Order

Method/config/trust guards → raw byte size → content type → signature
authentication → only VERIFIED → UTF-8/JSON parse → existing strict official
decoder → durable acquisition → resolution ports → internal command/result.
The existing `ProviderRawDecoder` combines structural decode and pure
normalization, so constructing the normalized event precedes acquisition to
derive the adapter key. No business processing happens in that normalization.
Identity/conversation resolution now happens after acquisition, preventing
replay from re-running resolution. Resolution failure releases the lease as
retryable; it never becomes a completed success. Authentication remains inside
the shared `processLiveWebhookRequest` path, without a trusted-auth bypass.

## 17. Payload Size Policy

`maxWebhookBodyBytes` is required and must be a positive safe integer. Missing
or invalid policy returns 503. Excess bytes return 413 / PAYLOAD_TOO_LARGE before
content/auth/parse. The synthetic simulator uses 16384 bytes. This is **LOCAL
DEPLOYMENT SECURITY POLICY**, not an official Meta maximum.

## 18. Content Type Policy

POST fixtures require application/json with optional UTF-8 charset (case
insensitive, optionally quoted). Missing/unsupported/ambiguous types return
415 / UNSUPPORTED_CONTENT_TYPE before auth. This is a local JSON-fixture policy,
not a claim about every future Meta content type.

## 19. Strict Decoder Reuse

`WhatsAppMetaOfficialWebhookDecoder` is reused, not duplicated. The inherited
single-event request limitation remains: batches and unsupported event kinds
fail closed. Authenticated malformed JSON/envelopes return local HTTP 400.
The four supported statuses and timestamps remain distinct, with no arrival
sorting or implied chronology. Multi-event acceptance is future work.

## 20. Durable Idempotency

The handler requires `DurableIdempotencyStore`; tests use only
`InMemoryDurableIdempotencyStore`. Keys come from existing provider event identity,
never signatures, tokens, body hashes or phone numbers. First authenticated
request is ACCEPTED; completed replay is DUPLICATE without a second command or
resolution. The inherited store also classifies an active lease as duplicate;
production ACK/retry policy must account for in-flight failure before live use.
The memory store is not production durability. Lease duration is local policy.

## 21. Sanitized Audit

META_WEBHOOK_REQUEST, META_WEBHOOK_HANDSHAKE and META_WEBHOOK_SIGNATURE records
allow only event, generated requestId/correlationId, fixed provider, method
GET/POST/OTHER, result, technical reason, timestamp, durationMs and duplicate.
External request IDs and unknown methods are never echoed. No signature, verify
token, App Secret, raw body, phone, message, challenge, payload or exception text
is included. Reason codes may name a security concept but never contain values.

## 22. Synthetic Security Tests

The focused suite exercises real synthetic HMAC, mutation/reserialization,
signature format/duplicates, resolver failure, raw-byte snapshots, handshake
cases, method/size/type gates, auth/decode/store spies, duplicate resolution,
resolution retry, safe config/audit, statuses and architecture/no-network scans.
The 223 baseline cases remain; readiness expectations include new phase blockers.

Run the eight assertions-based scenarios with:

```text
node --import tsx services/channel-gateway/simulator/metaSecurity.ts
```

Output is explicitly `Simulação`: valid/invalid GET, valid/invalid signed POST,
body mutation, official inbound, official status and authenticated replay.

## 23. Health vs Readiness

Offline tests/simulation passing does not make the provider ready. HTTP 200 means
the local boundary accepted a handshake/event/duplicate, never delivery, CRM
persistence or a production ACK guarantee. A future live runtime must avoid
unnecessarily long synchronous work and separate durable acceptance from
downstream workers. No worker or official ACK timeout is implemented or claimed.

## 24. Remaining Live Blockers

Current security protocol reconfirmation; real secret provisioning/rotation;
HTTPS runtime, TLS and WABA subscription; production atomic durable store;
provider transport; server persistence and authorized identity/conversation
resolution; runtime observability; deployment hardening. Production batch and
in-flight ACK semantics, queue/worker and existing product/security approvals
also require a separately authorized design and validation phase.

## 25. Exact NOT_READY Status

META SECURITY FOUNDATION: PASS / OFFLINE IMPLEMENTED once validation passes.
WHATSAPP_META_OFFICIAL: **NOT_READY**. Code records
OFFLINE_SIGNATURE_PROTOCOL_IMPLEMENTED and OFFLINE_HANDSHAKE_PROTOCOL_IMPLEMENTED
with META_OFFICIAL_ARCHIVED / PENDING_CURRENT_META_RECONFIRMATION. Existing
OFFICIAL_SIGNATURE_PROTOCOL_NOT_VERIFIED and OFFICIAL_HANDSHAKE_PROTOCOL_NOT_VERIFIED
refer to current live verification, and remain blocked alongside the compiled
F1B-09 production gates. RCS is unchanged; Evolution remains optional/non-default.

## Validation environment

Baseline: privacy PASS, lint PASS, 223/223 tests PASS, build PASS. A first
sandboxed test launch was blocked by esbuild parent-directory access. The first
unsandboxed suite had a 20-second Test 92 process timeout; exact rerun passed
without modifying tests/timeouts/guards. The known tsx/os.userInfo ENOMEM failure
was handled with a narrow temporary preload outside the repository for local
CLI runs. No workaround is versioned. Vite's existing >500 kB chunk warning
remains a separate performance item.
