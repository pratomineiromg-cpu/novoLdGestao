# Channel Gateway Offline Foundation

This directory is a server-side/offline boundary around the approved domain
contracts. The dependency direction is `channel-gateway -> src/domain`; domain,
repositories, and UI do not import this service.

The adapters accept only objects marked `synthetic: true`, normalize them to a
provider-neutral event, reserve a process-local idempotency key, produce a
provider-neutral command boundary, and return a sanitized audit record. They do
not create Contact, Conversation, Order, or any repository write.

`prepareOutbound` produces an in-memory `PREPARED` envelope from an existing
domain `RoutingDecision`. The gateway does not calculate or change routing and
has no delivery operation.

The simulator reads only JSON basenames from `simulator/fixtures`. It does not
open a port or expose an ingress process. Repeating a fixture in one command
proves process-local idempotency:

```powershell
npm run gateway:simulate -- --provider WHATSAPP_META_OFFICIAL --fixture whatsapp-inbound-text.json --repeat 2
```

Standard output is a sanitized audit event. It never contains the fixture's
address, message content, raw payload, or provider identifiers.

## Fixture policy

**FIXTURES ARE SYNTHETIC TEST DATA.** They contain only deliberately invented
addresses, opaque identifiers, and test text. They are not production payloads,
provider webhook samples, or customer data.

Provider capabilities are supplied explicitly to each adapter instance. Empty
configuration means no known capability. Normalizing an observed application
message does not claim that message echo is universally available.

F1B-07 adds separate live-untrusted and trusted-fixture entrypoints, exact raw
byte preservation, typed authentication/handshake boundaries, durable lease
semantics, resolution ports, pure state machines, an in-memory outbound queue
reference, and an explicit live-readiness evaluator. Meta live decoding,
authentication, transport, production persistence, workers, ingress, and runtime
deployment remain unconfigured. See `docs/meta-live-prerequisites-offline.md`.

F1B-08 adds a strict offline decoder for the verified official Meta webhook
envelope and synthetic official fixtures. It still does not implement signature,
challenge, subscription management, Graph API calls, transport, credentials, or
provider connectivity.

F1B-12 adds a provider-neutral, deterministic one-item inbound worker kernel.
It atomically claims queued work, resolves only existing references, invokes an
injected command handler, and acknowledges only after that handler succeeds. It
does not start a worker process, schedule work, implement a database or CRM
write, or connect a provider. See `docs/f1b-12-inbound-worker-kernel-offline.md`.

F1B-14 adds a process-local idempotent implementation behind the command
handler boundary and a safe operational-event sink. It models replay-safe
downstream effects and emits payload-free stage outcomes without claiming
distributed exactly-once delivery, durable persistence, hosted observability,
or live readiness. See `docs/f1b-14-downstream-observability-offline.md`.
