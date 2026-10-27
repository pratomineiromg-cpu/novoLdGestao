# F1B-15: Durable Persistence Adapter / Firestore

**THIS PHASE DOES NOT ACTIVATE LIVE META.**
**THIS PHASE DOES NOT ACTIVATE LIVE RCS.**
**THIS PHASE DOES NOT DEPLOY A WORKER.**
**THIS PHASE DOES NOT CREATE PRODUCTION INFRASTRUCTURE.**
**THIS PHASE DOES NOT PUBLISH PROVIDER CREDENTIALS.**

## Objective

F1B-15 adds the first durable persistence adapter for the inbound Channel
Gateway admission and worker queue model. The target architecture is:

`DOMAIN / GATEWAY -> PERSISTENCE PORTS -> FIRESTORE ADAPTER -> FIRESTORE`

The existing Gateway core, provider decoders, worker kernel, and domain modules
continue to depend only on provider-neutral contracts. Firestore is known only
inside `services/channel-gateway/adapters/firestore`.

## Adapter Boundary

The adapter is `FirestoreDurableWebhookIngressStore`. It mirrors the existing
`InboundAdmissionStore`, `InboundWorkQueue`, and `DurableWebhookIngressStore`
operations, but exposes them asynchronously because the official server-side
Firestore SDK is asynchronous. The current offline Gateway runtime remains
synchronous and is not rewired in this phase.

The adapter uses the official server-side package:

`@google-cloud/firestore`

The UI/CRM `firebase` client SDK and existing `FirestoreRepository` /
`FirestoreReadOnlyRepository` are not reused by the Gateway. Those components
serve CRM/UI persistence. The new adapter keeps internal queue payload storage
separate from CRM documents.

## Configuration And Credentials

`createChannelGatewayFirestore()` creates a server-side Firestore client.
Configuration accepts only non-secret runtime settings such as `projectId`,
`databaseId`, and `preferRest`.

Credentials are not hardcoded, accepted as JSON, or stored in source. Future
runtime activation must use Application Default Credentials or managed identity.
The known target region for future infrastructure planning remains
`southamerica-east1`, but no infrastructure is created by this phase.

## Collections

F1B-15 introduces Gateway-internal collections:

- `channelGatewayInboundAdmissions`
- `channelGatewayInboundWorkItems`
- `channelGatewayIngressBatches`

These collections are intentionally separate from CRM/UI collections documented
in `docs/firestore-schema.md`.

Document IDs:

- admissions: `encodeURIComponent(idempotencyKey)`
- work items: `encodeURIComponent(workItemId)`
- ingress batches: `encodeURIComponent(ingressBatchId)`

The idempotency key never depends on Meta `changeIndex`.

## Serialization

Dates are serialized explicitly to Firestore `Timestamp` values through the
adapter serializer. Deserialization converts supported Firestore timestamp
representations back to JavaScript `Date`.

The full `InboundWorkItem` payload is persisted only in
`channelGatewayInboundWorkItems` because it is required for durable processing.
The adapter does not log payloads, provider addresses, tokens, secrets, message
content, or idempotency keys.

## Transaction Model

`admit()` runs in one Firestore transaction:

1. read admission by idempotency key;
2. read work item by work item ID;
3. if admission exists, return a duplicate/processing/final disposition without
   writing a second work item;
4. if no admission exists but the work item ID exists, reject with
   `WORK_ITEM_ID_COLLISION`;
5. otherwise write admission and queued work item in the same transaction.

If the transaction fails, neither admission nor work item is committed.

`ack()`, `nack()`, and `failFinal()` also update the work item and corresponding
admission in one transaction.

## reserveNext

`reserveNext()` does not expose list-then-reserve to callers. It runs candidate
selection and lease assignment inside one Firestore transaction.

The adapter reads bounded candidate windows for:

- `QUEUED` items ordered by `enqueuedAt`;
- `FAILED_RETRYABLE` items whose `nextAttemptAt` is due;
- `RESERVED` items whose `leaseExpiresAt` is expired.

It deterministically chooses by availability time, enqueue time, and
`workItemId`, then re-reads the selected item in the same transaction before
writing the lease. Firestore transaction retries preserve lease exclusivity
under concurrent workers. The delivery semantics remain at-least-once, not
exactly-once.

## Leases And Retries

Reservation sets:

- `state = RESERVED`
- `ownerId`
- `leaseExpiresAt`
- incremented `attempt`

An active, unexpired lease cannot be taken by another worker. If a worker dies,
the lease can be recovered after `leaseExpiresAt`.

`nack()` validates ownership, applies the existing retry policy, clears the
lease, records `failureReasonCode`, and sets either `FAILED_RETRYABLE` with
`nextAttemptAt` or `FAILED_FINAL`.

`ack()` validates ownership, marks work and admission `COMPLETED`, and clears
`ownerId`, `leaseExpiresAt`, `nextAttemptAt`, and `failureReasonCode`.

`failFinal()` validates ownership, marks work and admission `FAILED_FINAL`,
clears the lease, and preserves the safe reason code.

## Security

The adapter has no provider SDK, HTTP client, webhook endpoint, Cloud Run,
Cloud Functions, service account file, private key, token, API key, or deploy
logic.

Operational and test assertions verify that Gateway core/domain code outside
the adapter does not import `firebase`, `firebase-admin`, or
`@google-cloud/firestore`.

## Tests

`src/tests/f1b-15-durable-persistence-adapter-firestore.test.ts` uses a small
transactional fake Firestore surface. It runs without Google credentials,
service account JSON, Firebase project, emulator, production Firestore, or
network writes.

Coverage includes:

- atomic admission and rollback;
- duplicate idempotency;
- admission/work consistency;
- work item ID collision;
- explicit reserve and ownership;
- deterministic `reserveNext`;
- concurrent `reserveNext`;
- expired lease recovery;
- retry scheduling;
- ack owner mismatch and completion;
- nack retry exhaustion;
- final failure;
- crash recovery;
- Timestamp round-trip;
- payload persistence without logs;
- injection and Firestore boundary checks.

## Phase Limits

This phase does not wire the async Firestore adapter into the synchronous
offline runtime. Hosted worker composition, async runtime orchestration,
indexes, IAM, ADC provisioning, production database creation, and live provider
traffic remain future work.
