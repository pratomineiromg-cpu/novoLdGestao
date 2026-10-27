# F1B-12: Inbound Worker Kernel Offline

**THIS PHASE DOES NOT CONNECT WHATSAPP.**
**NO WORKER PROCESS, SERVER, DURABLE DATABASE, OR CRM WRITE IS CONFIGURED.**
**FIREBASE/FIRESTORE REMAINS OUTSIDE THE CHANNEL GATEWAY.**

## Objective

F1B-11 closed the persistence and lease contracts but deliberately did not
implement a runtime. F1B-10's `dispatchStagedBatchItems` is a batch-bound
compatibility helper: it cannot discover work independently after a restart and
has no downstream command-handling boundary.

F1B-12 adds the smallest provider-neutral offline kernel needed to consume one
durably admitted inbound work item at a time. It makes the missing worker claim
and command-completion boundary explicit without selecting a database, running a
loop, or connecting a provider.

## Architecture

```text
InboundWorkQueue.reserveNext (atomic claim)
  -> lease held by owner
  -> resolve existing identity/conversation only for inbound messages
  -> create existing GatewayCommand
  -> injected InboundCommandHandler
  -> ack only after handler reports COMPLETED
```

`dispatchNextInboundWorkItem` is a deterministic, synchronous, one-item step.
It owns no scheduler, timer, HTTP listener, transport, provider SDK, persistence
implementation, or secret. A future runtime must call it deliberately with an
approved durable adapter and a separately authorized command handler.

## Contracts

### `InboundWorkQueue.reserveNext`

The queue now exposes one atomic selection-and-reservation attempt. A durable
adapter must select an eligible item and assign its lease in one persistence
boundary; callers must not list work and then reserve it in separate operations.
The in-memory reference selects deterministically by availability time,
enqueue time, and opaque work ID.

### `InboundCommandHandler`

The kernel passes an `InboundCommandExecution` to an injected handler. It
contains the existing provider-neutral `GatewayCommand`, opaque work and
idempotency IDs, attempt number, and resolved existing references when they are
required. The gateway supplies no handler implementation and therefore does not
write Contact, Conversation, Message, or any repository entity.

The handler returns exactly one of:

- `COMPLETED` — the kernel acknowledges the leased item;
- `RETRYABLE_FAILURE` — the kernel applies the existing retry policy through
  `nack`;
- `FINAL_FAILURE` — the kernel calls `failFinal`.

## Invariants

- A command handler runs only after an atomic queue lease is acquired.
- An inbound message resolves only already-existing Contact and Conversation
  references; `NOT_FOUND`, `AMBIGUOUS`, and rejection never create either.
- Status and provider-state commands bypass identity resolution.
- A successful handler is acknowledged only after it returns `COMPLETED`.
- If acknowledgement cannot be confirmed, the result is explicitly
  `ACKNOWLEDGMENT_UNCONFIRMED`; the worker does not issue a speculative second
  state transition. The handler receives the idempotency key so a future durable
  handler can tolerate recovery/replay at that boundary.
- Worker results include only state, technical reason, opaque work ID, and
  command type. They never return an event, address, content, secret, or raw
  provider payload.

## Tests

`src/tests/f1b-12-inbound-worker-kernel-offline.test.ts` verifies:

- deterministic atomic next-work reservation without a batch record;
- resolution before handling and acknowledgement after success;
- message and status processing through the same provider-neutral kernel;
- active-lease exclusivity and post-expiry recovery;
- retryable and final failure transitions;
- rejection of a handler result outside the closed safe reason-code contract;
- no implicit Contact/Conversation creation on failed resolution;
- acknowledgement uncertainty and payload-free worker results;
- invalid local worker configuration before any claim.

## Deliberate limits

F1B-12 does not implement a Firestore adapter, a production queue, a worker
process, scheduling, concurrency control outside the queue transaction,
observability export, CRM command implementation, HTTP ingress, secrets,
credentials, Meta/WhatsApp/RCS transport, network calls, deployment, or live
readiness. WhatsApp Meta Official remains **NOT_READY** and current protocol
reconfirmation remains required.

The next architectural increment is an offline design and test suite for a
durable `InboundWorkQueue` adapter with atomic `reserveNext` semantics and an
idempotent downstream command boundary. It must remain disconnected until the
separate persistence, product, security, and live-readiness approvals exist.
