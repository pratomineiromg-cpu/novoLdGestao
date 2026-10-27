# Channel Gateway Offline Foundation

## Purpose and architectural position

F1B-05D creates a local-only server-side boundary between future channel
providers and the existing LidacomZap domain. The gateway normalizes synthetic
provider fixtures, applies process-local idempotency, emits provider-neutral
commands, prepares outbound envelopes, and produces sanitized technical audit
events. It is not the CRM, database, Contact, Conversation, Order, or commercial
source of truth.

The dependency rule is one-way: `services/channel-gateway` may import
`src/domain`, while `src/domain` never imports the gateway. The gateway has no
repository import and no persistence behavior.

## Adapters and normalized events

Offline adapters implement the same `ChannelGatewayAdapter` contract for
`WHATSAPP_META_OFFICIAL`, `RCS_GOOGLE`, and the non-default
`WHATSAPP_EVOLUTION_OPTIONAL`. Each adapter declares only explicitly configured
capabilities. Unknown or omitted capabilities remain unavailable; message echo
is never a universal promise.

Provider-specific synthetic objects are converted to `NormalizedChannelEvent`.
Supported concepts include inbound and observed outbound messages, delivery and
read status, capability and subscription updates, and provider status. Raw
provider objects do not become domain entities.

## Privacy, idempotency, and command boundary

Addresses and message content may exist transiently in a normalized event or
future resolution command, but never in standard output, errors, or
`GatewayAuditEvent`. Audit records contain only opaque internal ID, provider,
channel, event type, outcome, reason code, timestamps, retry count, and duplicate
status.

Idempotency uses provider plus provider event ID when present, or provider plus
provider message ID for message-related events. It never derives keys or internal
IDs from address, name, or content. `InMemoryIdempotencyStore` exists only for
tests and the simulator; no durable state is implied.

An accepted event yields a provider-neutral command such as
`InboundMessageReceived`, `MessageDeliveryUpdated`, `MessageReadUpdated`, or
`ChannelCapabilityUpdated`. The gateway does not resolve an address into Contact
and does not create Conversation. Dedicated interfaces document those future
authorized boundaries.

## Outbound preparation, routing, and retry

Outbound processing consumes an existing domain `RoutingDecision`, selects the
matching adapter, and returns a `PreparedOutboundMessage`. It does not recompute
commercial routing, switch channel, or claim delivery. The envelope contains no
endpoint or secret material.

The retry policy is a deterministic calculation with exponential backoff,
maximum attempt and delay limits, and retryable/non-retryable classification. It
does not wait, schedule, enqueue, or run a worker.

## Simulator and synthetic fixtures

`npm run gateway:simulate` reads only versioned basenames from the gateway
fixture directory. It does not start an HTTP server or open a port. `--repeat 2`
replays in one process so the first result is `ACCEPTED` and the second is
`DUPLICATE`. Standard output is the sanitized audit representation.

**FIXTURES ARE SYNTHETIC TEST DATA.** No fixture contains customer or restaurant
data. The unconfigured webhook authenticator reports `NOT_CONFIGURED`; it does
not pretend to verify production traffic.

## Future runtime boundary

A later runtime may run on Hostinger KVM2, Cloud Run, or another container host
without changing CRM domain contracts. A future deployment may add HTTPS
ingress, real webhook verification, provider adapters, outbound queue, retry
worker, persistent idempotency, observability, and health checks. None is
implemented in this phase.

F1B-05D contains no active provider connection, credential, ingress server,
Firebase/Firestore access, repository write, VPS-specific code, or deployment.
