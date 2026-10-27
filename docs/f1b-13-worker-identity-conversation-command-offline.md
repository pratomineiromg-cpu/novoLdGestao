# F1B-13: Worker Identity, Conversation and Command Integration Offline

**THIS PHASE DOES NOT CONNECT WHATSAPP, RCS, FIREBASE, OR A LIVE DATABASE.**
**NO WORKER PROCESS, SCHEDULER, HTTP CLIENT, PROVIDER SDK, OR CRM REPOSITORY IS CONFIGURED.**

## Objective

F1B-13 connects the F1B-12 inbound worker kernel to explicit identity and
conversation outcomes before dispatching the existing provider-neutral
`GatewayCommand`. The step remains synchronous, deterministic, injected, and
offline.

## Flow

1. Atomically reserve one eligible work item.
2. Resolve the contact identity for inbound messages.
3. Resolve an existing conversation or accept a resolver-confirmed new one.
4. Build the existing provider-neutral command.
5. Invoke the injected command handler.
6. Acknowledge only after the handler reports `COMPLETED`.

Status and provider-state events bypass identity and conversation resolution.

## Resolution contracts

Identity outcomes are `RESOLVED`, `NOT_FOUND`, `AMBIGUOUS`, `INVALID`,
`RETRYABLE_FAILURE`, and `FINAL_FAILURE`.

Conversation outcomes are `EXISTING_CONVERSATION`, `NEW_CONVERSATION`,
`AMBIGUOUS`, `RETRYABLE_FAILURE`, and `FINAL_FAILURE`. The F1B-12 values
`RESOLVED_EXISTING`, `NOT_FOUND`, and `REJECTED` remain accepted only as
deprecated compatibility values while older callers are migrated.

`NEW_CONVERSATION` means that the injected resolver has already confirmed an
idempotent creation and returns its opaque ID. The kernel itself never creates a
conversation. The worker supplies the durable work-item idempotency key as
`creationIdempotencyKey`; a new-conversation outcome without that key fails
closed with `CONVERSATION_REJECTED`.

The command execution receives only opaque internal references. For a newly
created conversation it also receives `conversationCreated: true`. No resolver
reason outside the closed `GatewayErrorCode` set can enter worker results.

## Failure mapping

- not found or ambiguous identity/conversation: retryable;
- invalid identity or deprecated rejection: terminal safe rejection;
- explicit retryable failure: `nack` using the allow-listed reason;
- explicit final failure: `failFinal` using the allow-listed reason;
- unexpected exception or invalid handler result: retryable
  `COMMAND_HANDLER_FAILED`;
- acknowledgement uncertainty remains explicit and replay-safe as defined in
  F1B-12.

## Tests

`src/tests/f1b-13-worker-identity-conversation-command-offline.test.ts` covers
the six identity outcomes, five conversation outcomes, ordering, admission
idempotency, retry/final transitions, command composition, status-event bypass,
and the absence of network calls. The F1B-12 and related Meta offline suites are
also retained as regression coverage.

## Deliberate limits

This phase provides contracts and an in-memory reference path only. It does not
provide a durable conversation creator, a durable identity resolver, a durable
queue adapter, a deployed worker, live credentials, live provider traffic, or a
production command handler. Those require separate persistence, security,
privacy, and live-readiness approval.
