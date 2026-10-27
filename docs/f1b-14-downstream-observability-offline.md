# F1B-14: Downstream Pipeline and Safe Observability Offline

**THIS PHASE DOES NOT CONNECT A PROVIDER, FIREBASE, A LIVE DATABASE, OR A HOSTED RUNTIME.**
**THE JOURNAL AND OPERATIONAL COLLECTOR ARE PROCESS-LOCAL REFERENCES ONLY.**

## Objective

F1B-14 supplies the missing offline implementation behind the F1B-13
`InboundCommandHandler` boundary. A provider-neutral processor is wrapped by a
replay-safe journal, while the worker emits sanitized operational events for
resolution, command handling, and acknowledgement.

## Delivery semantics

The worker remains at-least-once. The downstream handler provides idempotent
effects within the reference process:

1. begin execution using the durable-work idempotency key;
2. skip the processor when that key is already completed;
3. allow a retry after an explicitly retryable failure;
4. preserve an explicitly final failure;
5. reject reuse of one key for a different work item or command type;
6. acknowledge the queue item only after downstream completion.

This is deliberately not described as distributed exactly-once delivery. A
production implementation requires the F1B-15 durable adapter and transactional
guarantees appropriate to the selected database.

## Downstream boundary

`OfflineIdempotentCommandHandler` receives all seven existing
provider-neutral `GatewayCommand` variants. It delegates to an injected
`DownstreamCommandProcessor`; it does not import a UI repository, Firebase,
provider SDK, or network client. The processor receives transient command data
and opaque internal references. The journal stores only execution metadata,
never the command, event payload, address, or message content.

## Safe observability

Operational events have a closed schema:

- provider and channel;
- stage, outcome, safe reason code, and health impact;
- retry count and duplicate flag;
- opaque correlation ID and timestamp.

The stages added in this phase are `DOWNSTREAM_IDEMPOTENCY`,
`COMMAND_HANDLING`, and `ACKNOWLEDGMENT`. Resolution and queue stages use the
existing vocabulary. Events never contain message content, external address,
raw payload, idempotency key, token, or secret. A failing event sink is ignored
so observability cannot change processing results.

## Deliberate limits

- no durable database adapter or distributed lock;
- no hosted worker, timer, scheduler, HTTP server, or exporter;
- no CRM repository write supplied by the gateway;
- no provider credentials, endpoint, SDK, or live traffic;
- no production-readiness claim.

F1B-15 owns durable persistence. F1B-16 owns hosted runtime, HTTPS, secrets,
and a real observability exporter.

