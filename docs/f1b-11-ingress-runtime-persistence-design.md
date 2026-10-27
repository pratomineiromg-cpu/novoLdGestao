# F1B-11: Ingress Runtime + Persistence Design Offline

**THIS PHASE DOES NOT CONNECT WHATSAPP.**
**PRODUCTION DURABLE STORAGE IS NOT CONFIGURED.**
**RUNTIME IS NOT CONFIGURED.**
**META LIVE INGESTION IS NOT CONFIGURED.**

## Objective
The objective of F1B-11 is to produce the executable technical design for the production webhook ingress and runtime layer, ensuring that the contracts defined in F1B-10 are preserved. This phase closes the contracts for durable admission, idempotency, work queues, lease ownership, and crash recovery, representing them explicitly in the persistence ports without committing to a specific database implementation.

## 1. Invariants
- **Atomic Admission:** Admission records and work items must be written in a single transactional boundary.
- **Durable Idempotency:** The system must reliably distinguish new events, events in progress, completed events, and failed events, using a deterministic key.
- **Meta Independence:** The `providerEventId` and idempotency key for Meta messages and statuses must NOT include `changeIndex`.
- **Firebase Independence:** The Channel Gateway (`services/channel-gateway`) remains independent of Firebase/Firestore.

## 2. Persistence Ports
The contract is defined in `services/channel-gateway/persistence.ts`. It acts as the boundary between domain logic and future database adapters.
- `InboundAdmissionStore`: Handles deduplication and atomic commits.
- `InboundWorkQueue`: Handles the lifecycle of an admitted webhook payload (enqueue, reserve, ack, nack, failFinal).

## 3. Atomicity
The admission of a webhook payload and its insertion into the processing queue must occur transactionally.
- If the event is admitted, it **MUST** exist in the queue.
- If queuing fails, the admission **MUST NOT** be visible.
- This prevents scenarios where an event is deduplicated but lost, or enqueued but not recorded as admitted.

## 4. Leases and Worker Ownership
- **Reservation (`reserve`)**: A worker acquires a lease on a queue item by setting `ownerId` and `leaseExpiresAt`.
- **Exclusivity**: Only one worker can process an item at a time.
- **Expiration**: If a worker crashes, the lease expires based on time, making the item available for another worker to reserve.

## 5. Queue Lifecycle and Retries
- **`ack`**: Marks the item as `COMPLETED`.
- **`nack`**: Schedules a retry by setting the item to `FAILED_RETRYABLE` and updating `nextAttemptAt` and `attempt` based on a local retry policy.
- **`failFinal`**: Marks the item as `FAILED_FINAL` when retries are exhausted or a non-retryable error occurs.

## 6. Crash Recovery
- **Crash before admission commit**: Safe to replay; the system will admit it normally.
- **Crash after admission commit (before HTTP response)**: Safe to replay; the system will detect it as `DUPLICATE` or `ALREADY_PROCESSING`.
- **Crash during processing**: The worker's lease will expire, and another worker will retry the item.
- **Crash after completion**: Replay will detect it as `DUPLICATE` or `COMPLETED`. No duplicate business effect will occur.

## 7. Retry Model
- **HTTP Retry vs. Business Retry**: The HTTP webhook endpoint responds quickly based on admission status, decoupling from business processing.
- **Retries**: If business logic fails, retries are managed entirely by the durable queue.

## 8. Observability and Security Boundaries
- Sensitive payloads (PII, tokens, message content) are confined to the `InboundWorkItem`.
- They **MUST NOT** leak into `DurableIngressBatchRecord`, logs, or audit metrics.
- All secrets are managed via synthetic/local variables (`SecretRef`), with no hardcoded credentials in the source.

## 9. Future Adapter Boundary
This design clearly separates the `DOMAIN CONTRACTS` from the `PERSISTENCE ADAPTER`.
The future architecture will be:
`DOMAIN` → `PERSISTENCE PORTS` → `FIRESTORE ADAPTER` → `WORKER RUNTIME`.
None of the adapters or runtimes are implemented in this phase.
