# Meta Live Prerequisites Offline

F1B-07 date: 2026-09-04

Official product: LidacomZap Gestão Inteligente

Pilot: Restaurante Prato Mineiro

**THIS PHASE DOES NOT CONNECT WHATSAPP.** It adds offline contracts and reference
semantics only. It creates no provider connection, credential, public runtime,
remote persistence, or live delivery claim.

## 1. Purpose

Reduce the architectural risk of a later WhatsApp Meta integration by defining
fail-closed, provider-neutral boundaries that can be verified without network or
real customer data.

## 2. Scope

The scope is raw request preservation, trust separation, authentication and
handshake contracts, strict synthetic decoding, durable idempotency semantics,
resolution ports, pure state machines, an outbound queue reference, retry/rate
limit foundations, sanitized observability, readiness, configuration, transport
and persistence ports, tests, and an offline simulator.

## 3. Explicit Non-Goals

There is no official Meta protocol implementation, HTTP server, endpoint,
provider SDK, token, secret material, remote database, queue worker, deployment,
or automatic Contact, Conversation, Message, or Order creation.

## 4. Current Official Baseline

The dependency direction remains `domain <- channel gateway <- provider
adapters`. `WHATSAPP_META_OFFICIAL` is primary, `RCS_GOOGLE` is the planned
second official channel, and `WHATSAPP_EVOLUTION_OPTIONAL` remains optional and
non-default. Historical WhatsApp Web, Baileys, Evolution, and GreenHub projects
are not implementation baselines.

## 5. Live vs Synthetic Entry Points

`processLiveWebhookRequest` accepts only `RawWebhookRequest` marked
`LIVE_UNTRUSTED`. `processTrustedSyntheticFixture` requires the explicit
`TRUSTED_SYNTHETIC_FIXTURE` mode. A fixture never obtains or represents live
verification.

## 6. Raw Webhook Body Boundary

`createLiveWebhookRequest` copies exact `Uint8Array` bytes before parsing,
normalizes header names, and retains method, optional path, query, receipt time,
and opaque request ID. `decodeRawWebhookJson` parses a copy and retains a byte
copy; it never reserializes JSON as a substitute for the received body.

## 7. Webhook Authentication Contract

`WebhookAuthenticator` returns a typed result containing `VERIFIED`, `REJECTED`,
or `NOT_CONFIGURED`, plus provider, reason, opaque request ID, and evaluation
time. Both non-verified states reject live processing. `NOT_CONFIGURED` is never
treated as verification.

## 8. Cryptographic Primitive Boundary

`InjectedHmacDigestVerifier` is a provider-neutral primitive using Node built-in
cryptography, injected algorithm and injected secret bytes, plus constant-time
comparison for equal-length digests. It is not named or represented as the Meta
signature protocol. Tests generate synthetic secret material at runtime.

## 9. Handshake Boundary

`WebhookHandshakeVerifier` models `VERIFIED`, `REJECTED`, `NOT_CONFIGURED`, and
`UNSUPPORTED` without assuming provider challenge field names. The reference
implementation is explicitly unconfigured.

## 10. Strict Event Decoding

The pipeline separates authentication, byte decoding, provider structural
decoding, normalized event validation, and idempotency. Invalid JSON, absent
required fields, arrays where records are required, unsupported event kinds,
invalid timestamps, missing technical identifiers, and incompatible
provider/channel combinations fail closed.

## 11. Internal Synthetic Meta Fixture Schema

`INTERNAL_SYNTHETIC_META_V1` supports only synthetic inbound messages, delivery
status, and observed application-origin messages required by the offline suite.
It requires explicit Meta provider and WhatsApp channel markers.

**THIS IS AN INTERNAL SYNTHETIC FIXTURE CONTRACT. IT IS NOT THE OFFICIAL META
LIVE PAYLOAD SCHEMA.**

## 12. Durable Idempotency Contract

`DurableIdempotencyStore` defines atomic conceptual acquisition, completion,
failure, and lookup around `PROCESSING`, `COMPLETED`, `FAILED_RETRYABLE`, and
`FAILED_FINAL`. The contract can be implemented later by authorized server-side
storage without changing provider adapters.

## 13. Lease / Ownership Model

Acquisition records owner, attempt, start, and lease expiry. A valid lease cannot
be stolen by another owner. An expired lease or retryable failure can be
reacquired and increments the attempt. Completion and failure require matching
ownership. Completed and final-failure records cannot be reacquired.

## 14. Contact Identity Resolution

`ContactIdentityResolver` receives provider/channel and transient external
identity data. Results are `RESOLVED_EXISTING`, `NOT_FOUND`, `AMBIGUOUS`, or
`REJECTED`. Only the existing-resolution result may advance; the port never
creates a Contact.

## 15. Conversation Resolution

`ConversationResolver` receives an already resolved internal Contact ID plus
channel/provider context. It has the same fail-closed result shape and never
creates a Conversation.

## 16. Inbound State Machine

The pure graph covers receipt, auth, validation, idempotency, normalization,
identity and Conversation resolution, acceptance, rejection, duplicate, and
retryable/final failures. Invalid transitions throw an explicit technical error;
terminal states do not progress. The graph performs no I/O.

## 17. Outbound State Machine

The pure graph models `PREPARED -> QUEUED -> RESERVED -> SENDING ->
PROVIDER_ACCEPTED -> DELIVERED -> READ`, with retryable/final failure and
cancellation branches. Cancelled, final-failure, and read states are terminal;
delivered work can only progress to read.

## 18. Outbound Queue

`OutboundQueue` defines enqueue, reserve, ack, nack, cancel, and get. The
in-memory reference deduplicates internal message and correlation IDs, protects
leases, finalizes acknowledged delivery, and applies bounded retry decisions.
It is not a production queue or worker.

## 19. Retry Foundation

Retry remains a deterministic calculation with explicit attempt and delay caps.
Failure classification is provider-neutral. No provider error codes, clock wait,
scheduler, or transport behavior is invented.

## 20. Rate Limit Foundation

Rate limiting is represented as `RATE_LIMITED` with an optional provider-supplied
retry hint. The policy selects the safer of policy delay and hint. No Meta quota
or universal limit is hardcoded.

## 21. Observability

Metric and operational event contracts allow provider, channel, technical stage,
outcome, reason code, duration bucket, retry count, duplicate flag, opaque
correlation ID, timestamp, and health impact. They have no address, phone, name,
email, message, raw payload, token, or secret field. Existing `GatewayAuditEvent`
remains allowlisted and sanitized.

## 22. Health vs Readiness

Health reports whether a process is healthy, degraded, or unhealthy. Readiness
reports whether a provider path has all controls required for live operation. A
healthy offline simulator does not make Meta live-ready.

## 23. Secret References

`SecretRef` carries an opaque reference ID only. Provider configuration never
contains secret values, tokens, or key material.

## 24. Provider Transport

`ProviderTransport` defines a future send boundary for prepared messages. Its
only implementation in this phase returns `TRANSPORT_NOT_CONFIGURED`; it contains
no endpoint, network primitive, credential, or delivery side effect.

## 25. Persistence Ports

`ChannelGatewayPersistencePorts` groups technology-neutral contracts for durable
idempotency, Contact identity resolution, Conversation resolution, and outbound
queue persistence. No storage technology is selected.

## 26. Firestore Client Write Status

Client write remains **BLOCKED** by the repository factory. F1B-07 does not
change that guard, rules, schema allowlist, hydration, or mutation behavior.

## 27. Server-Side Persistence Status

Channel gateway server persistence is **NOT IMPLEMENTED**. The in-memory stores
are semantic references and test tools only.

## 28. Meta Offline Adapter

The Meta offline adapter validates the explicit internal fixture contract and
normalizes supported synthetic events. F1B-08 adds a separate strict offline
decoder for the verified official envelope and supported synthetic official
message/status examples. The pending decoder still deliberately fails with
`OFFICIAL_PROTOCOL_NOT_VERIFIED` when a caller chooses the unresolved live
protocol boundary.

## 29. RCS Regression

The existing RCS synthetic adapter, capability behavior, normalization, routing,
and simulator remain offline and covered. No RCS scope was expanded.

## 30. Evolution Optional Status

Evolution remains optional, non-default, offline, and replaceable. No Evolution
transport or provider behavior was added.

## 31. Official Meta Protocol Verification

**PENDING OFFICIAL SPEC VERIFICATION.** Signature header names and encoding,
algorithm, challenge fields, live payload details outside the verified envelope
subset, coexistence behavior, echo, sync, presence, catalog, and
account-specific capabilities were not assumed.

## 31A. Official Protocol Evidence Added in F1B-08

F1B-08 records official-source provenance in
`docs/meta-official-protocol-evidence.md` and adds an offline strict decoder for
the verified generic WhatsApp Business Platform webhook envelope:

- `object = whatsapp_business_account`
- non-empty `entry` array
- `entry[].id`
- non-empty `entry[].changes`
- `changes[].field = messages`
- `changes[].value.messaging_product = whatsapp`
- `value.metadata.display_phone_number`
- `value.metadata.phone_number_id`
- message/status event foundation under the `messages` field
- status values `sent`, `delivered`, `read`, and `failed`

The decoder remains offline and does not call Graph API, Meta, WhatsApp, RCS,
Evolution, Firebase, Firestore, Hostinger, or any provider runtime. Unsupported
official event shapes are classified fail-safe instead of being silently
accepted.

VERIFIED OFFICIAL:

- WABA webhook delivery requires app subscription to the WABA.
- Future public webhook ingress requires HTTPS and a valid TLS certificate.
- Alternate callback URL configuration uses the `verify_token` concept.

PENDING:

- Exact POST webhook signature header, signature algorithm, and canonicalization.
- Exact GET challenge protocol and query keys.
- Coexistence, message echo, contact sync, history sync, presence, catalog, and
  unverified provider limits.

Generic crypto primitive status: READY.

Meta POST signature protocol: PENDING OFFICIAL SPEC VERIFICATION.

WhatsApp Meta Official live status: NOT_READY.

## 32. Remaining Live Blockers

Official protocol verification, real webhook authentication, secret provisioning
and rotation, hardened HTTPS ingress, payload limits, live transport, production
durable idempotency, authorized identity and Conversation persistence, durable
queue/worker, distributed throttling, redacted runtime observability, alerting,
deployment hardening, rollback, and approved product/legal policies remain.

## 33. Exact Requirements for NOT_READY to READY

Every readiness input must be evidenced: official POST signature protocol
verified, official handshake protocol verified, WABA subscription configured,
webhook verification token supplied as a secret reference, HTTPS ingress and TLS
certificate configured, transport configured behind approved credentials,
durable persistence configured, and all operational/security gates approved.
Until all applicable reasons are absent, the result is `NOT_READY`. In F1B-08,
the compiled phase gate keeps Meta signature and handshake reasons pending even
if a caller supplies optimistic configuration flags; a later authorized phase
must replace that gate with verified implementation evidence.

## 34. Safe Next Phase

Verify the remaining official Meta signature and handshake protocol details from
primary documentation in a separately authorized phase, then specify exact-byte
authentication tests without live credentials. Keep transport unconfigured until
durable storage, resolution, queue/worker, observability, deployment, and product
approval gates are ready together.

## F1B-09 Addendum — Archived Security Implemented Offline

The historical F1B-07/F1B-08 descriptions above remain phase records. F1B-09 adds
an offline Meta GET handshake and raw-body HMAC signature implementation,
SecretResolver, pure HTTP-shaped handler, method/body/type gates and sanitized
audit. It reuses the existing decoder and durable idempotency pipeline.
Identity/conversation resolution now occurs after acquisition and is skipped on
replay. See `meta-webhook-security-offline.md` for policies and inherited limits.

OFFLINE_SIGNATURE_PROTOCOL_IMPLEMENTED / OFFLINE_HANDSHAKE_PROTOCOL_IMPLEMENTED
use META_OFFICIAL_ARCHIVED evidence, pending PENDING_CURRENT_META_RECONFIRMATION.
They do not clear current protocol verification, secrets, HTTPS/TLS, WABA,
production store, transport, persistence, observability or hardening blockers.
WhatsApp Meta Official remains NOT_READY; no real connection exists.
