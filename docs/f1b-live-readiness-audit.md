# F1B Live Readiness Audit

Audit date: 2026-09-04

Official product: LidacomZap Gestão Inteligente

Pilot: Restaurante Prato Mineiro

Audit branch: `f1b-06-live-readiness-audit`

## 1. Executive Summary

The F1B offline foundation is coherent and ready to support a separately
authorized provider-integration phase. It is not live-ready by itself and this
audit does not authorize a provider connection, Firestore write activation,
deployment, credential creation, or processing of real customer data.

The baseline clean install, lint, 167 pre-audit tests, and production build
passed. The audit found and corrected three small defects: impossible
channel/provider pairs were accepted at domain and Firestore read boundaries;
the contact bootstrap could write a PII-bearing plan with a non-ignored generic
JSON suffix; and the runtime event log included complete message/order event
payloads. One wall-clock assertion was also removed from an otherwise pure retry
test. Three contract tests were added, bringing the suite to 170 tests.

WhatsApp Meta and Google RCS remain offline foundations. Evolution remains an
optional, replaceable, non-default adapter. Firestore first write and a hosted
channel gateway remain blocked until the controls listed in this report exist.

## 2. Official Baseline

- Repository: `C:\Users\dfant\lidacomzap-gestao-inteligente`
- Branch: `f1b-06-live-readiness-audit`
- Starting HEAD: `849b7b5ff1ea9c0a356a8380c787661a293ce82a`
- Local `main`: `849b7b5ff1ea9c0a356a8380c787661a293ce82a`
- Local `origin/main` tracking ref: `849b7b5ff1ea9c0a356a8380c787661a293ce82a`
- Starting worktree: clean
- Package manager declaration: `npm@11.13.0`
- Lockfile: npm lockfile version 3
- Pre-audit approved tests: 167

The audit used the current checkout as the only official source. Historical CRM,
WhatsApp Web, Baileys, and Evolution projects were not treated as implementation
evidence.

## 3. Git Checkpoints

The pre-edit checkpoint matched the expected root, branch, HEAD, local main, and
local `origin/main` tracking ref. No fetch, push, merge, rebase, force operation,
branch deletion, or history rewrite was performed. The final audit commit is
local-only and must not be interpreted as remote delivery.

## 4. Architecture Map

```text
UI (views/components)
  -> application actions and event engine
  -> AppRepository semantic contract
     -> MockRepository (active default)
     -> FirestoreReadOnlyRepository (explicit read-only mode)
     -> FirestoreRepository (implemented but activation blocked)
  -> domain types and invariants

local contact tools
  -> bootstrap/import validation and planning
  -> domain types + Firestore schema/validators
  -> local filesystem only

offline channel gateway
  -> provider-neutral gateway contracts
  -> provider adapters for synthetic fixtures
  -> domain omnichannel contracts
  -> no repository or Firebase dependency
```

Classification of the versioned modules:

| Layer | Modules |
|---|---|
| Domain | `src/domain/types.ts`, `omnichannel.ts`, `routing.ts` |
| Application / use cases | `src/services/Actions.ts`, `src/events/EventEngine.ts` |
| Repositories | `IRepository.ts`, `MockRepository.ts`, repository factory |
| Firestore infrastructure | write/read-only repositories, schema, serializers, validators, empty state |
| Auth | auth service/provider, user profile service, auth gate |
| UI | app, components, views, app store |
| Local tools | contact bootstrap and contact import |
| Omnichannel | domain channel, provider, capability, identity, and routing contracts |
| Channel gateway | contracts, normalization, inbound processing, idempotency, retry, adapters, simulator |
| Tests | core, architecture, Firestore/auth/read-only/bootstrap, import, omnichannel, gateway |
| Documentation | Firestore, import, omnichannel, gateway, and this audit |

## 5. Dependency Direction

- Domain imports only other domain modules. It has no Firebase, UI, gateway, SDK,
  credential, or transport dependency.
- Routing is deterministic and data-only. It performs no network probe, send, or
  capability discovery.
- The gateway depends on domain contracts. Domain, repositories, and UI do not
  depend on the gateway.
- The gateway does not import repositories, Firebase, or Firestore and does not
  recalculate a `RoutingDecision`.
- UI mutations flow through application actions and the semantic repository
  contract. UI has no direct Firebase SDK access. `DataSourceGate` knows the
  read-only repository concrete type only to coordinate hydration status.
- Contact tools have Node filesystem dependencies only; they contain no network,
  Firebase, OAuth, or provider client.

No dependency-direction violation was found.

## 6. Domain Invariants

- `Contact` remains the CRM person and does not own channel/provider state.
- `ContactChannelIdentity` owns channel address, availability, eligibility, and
  optional provider identity metadata.
- Channel and provider are separate concepts. The audit added fail-closed checks
  so RCS accepts only `RCS_GOOGLE`, while WhatsApp accepts Meta Official or the
  optional Evolution adapter.
- `Conversation` and `Message` remain internal entities. Provider IDs are optional
  external references and never replace internal IDs.
- `DispatchCampaign` remains an executable dispatch operation;
  `MarketingCampaign` is a separate planning concept.
- Opportunity funnel stage and dispatch queue status remain independent types.
- `Order`, `Conversation`, and queue entries remain distinct entities.

Legacy Conversation and Message documents without omnichannel metadata remain
valid.

## 7. Commercial Flow

The event engine preserves the approved transitions:

- `MESSAGE_DRAFT_CREATED` -> `RASCUNHO`
- `MESSAGE_SENT` -> `LEAD`
- `MESSAGE_RECEIVED` -> `EM ATENDIMENTO`
- `ORDER_CREATED` -> `PEDIDO GERADO`

The queue state model remains `QUEUED -> DRAFT_PREPARED -> SENT`, followed by
`REPLIED`, `FAILED`, or `SKIPPED` as applicable. Repository methods guard logical
queue/draft/send idempotency independently of the Opportunity stage.

## 8. Order Attribution

The required attribution contracts remain unchanged:

- `entryPoint`: `DIGITAL_MENU`, `CHAT`, `POS`, `TABLE_QR`
- `channel`: `WHATSAPP`, `RCS`, `NONE`
- `creationMode`: `CUSTOMER`, `HUMAN_OPERATOR`, `AI_ASSISTED`, `AUTOMATION`
- optional references: `conversationId`, `dispatchCampaignId`, `queueEntryId`

No omnichannel regression was found in the order validator or domain type.

Future menu attribution is documented as an opaque token/context. It must not
embed phone, name, email, or other PII and must remain usable after a link is
copied, sent manually, sent by the platform, or delivered over either channel.
No live token was implemented.

## 9. Repository Boundary

`AppRepository` exposes semantic operations for queue population, draft
preparation, prepared-send state transition, client response, order creation,
campaign limit update, funnel transition, timeline append, and reset. A generic
application-level `update()` has not returned.

The Mock and Firestore implementations preserve the same semantic method surface.
Firestore's internal transaction `update` calls are infrastructure operations,
not a generic repository escape hatch. The Firestore write implementation exists
but the repository factory refuses `FIRESTORE` activation.

## 10. Firestore Safety

Data-source modes are exactly `MOCK`, `FIRESTORE_READONLY`, and `FIRESTORE`.
Missing or blank configuration resolves to `MOCK`. Invalid configuration throws.
`FIRESTORE` throws `Firestore write mode is not enabled.` and is not activated.

`FIRESTORE_READONLY`:

- rejects every AppRepository mutation before Firebase access;
- reads only a 12-collection operational allowlist;
- excludes the auth `users` collection from operational hydration;
- fetches into a candidate state and commits only after every validator passes;
- protects against stale concurrent hydration generations;
- exposes an explicit error state and never falls back to MOCK.

Active-now schema collections are contacts, conversations, messages,
opportunities, dispatch campaigns, dispatch queue, pending outbound messages,
orders, order items, timeline events, customer profiles, and customer addresses.

Reserved-for-future concepts are `contactChannelIdentities` (name and opaque path
contract only), provider capabilities, and routing decisions. They are not in
DatabaseState, the read-only allowlist, repository mutation methods, or deployed
rules and must not be represented as live persistence.

## 11. Authentication / Authorization

Firebase email/password login and logout are explicit; there is no public signup
surface. Auth state distinguishes loading, unauthenticated, authorizing,
authorized, and unauthorized. Profile validation requires UID equality, active
boolean, allowed role, strings, and valid Firestore timestamps. Generation checks
prevent a stale profile result from authorizing after logout or a user switch.

The UI reaches operational content only in `authorized` state. The known
administrative UID is absent from runtime source; the existing cross-platform
test scans runtime files while excluding tests.

The versioned Firestore rules require authentication plus an active user profile
for operational collections, limit user-profile reads to the authenticated user's
active document, block all client writes to `users`, and end with default deny.
There is no allow-all rule.

Limit: rules tests are static source assertions, not Firestore emulator tests.
Operational rules currently permit every active role to read/write every global
pilot collection and do not enforce tenant or role granularity. This is acceptable
only while client writes remain disabled and is a blocker for first write or
multi-tenant activation.

## 12. Contact Bootstrap

The bootstrap is offline, project-guarded, tenant-guarded, operation-ID guarded,
strict about ISO timestamps and impossible calendar dates, rejects duplicate IDs
and canonical phones, validates safe Firestore document IDs, and emits create-only
operations with `currentDocument.exists = false`.

`--apply` is rejected before input processing. The audit additionally requires
all plan output to use the globally ignored `.plan.json` suffix, preventing a
PII-bearing plan from being accidentally written as a trackable generic JSON
file. No network or live write path exists.

The fictional example produced two create-only planned writes successfully.

## 13. Contact Import Pipeline

The local importer supports explicit-mapping CSV and manually exported Google
Contacts CSV. It reuses the bootstrap `canonicalPhone` implementation, performs
deduplication on that canonical value, creates opaque UUID-based IDs, produces a
bootstrap-compatible manifest, and validates it before output.

Preview and report output contain aggregate counts, opaque operation/import IDs,
and technical reason codes only. Manifests require `.local.json`; reports require
`.report.json`; both suffixes and `.plan.json` are ignored globally. There is no
OAuth, People API, Firestore, or provider access.

The fictional CSV run found four rows: two valid, one invalid, and one duplicate;
it produced two manifest candidates without writing a manifest or report.

Phone canonicalization currently removes non-digits and rejects an empty result.
A real-import phase still needs an explicitly approved country/length validity
policy; this audit did not invent a commercial phone rule.

## 14. Omnichannel Domain

The domain models `CommunicationChannel`, `ChannelProvider`,
`ContactChannelIdentity`, availability, eligibility, provider capabilities,
message content types, and origin surfaces independently. Identity creation
defaults availability and eligibility to `UNKNOWN`; the router requires
`KNOWN_AVAILABLE` plus `ELIGIBLE`. Unknown never becomes available or eligible.

Capability enum membership is not evidence of provider support. Empty adapter
configuration yields no known capabilities; configured or provider-observed
capabilities remain specific to that provider/channel record and timestamp/source.

## 15. Smart Routing

`WHATSAPP` and `RCS` route only a matching identity that is known available and
eligible. `BOTH_SMART` returns at most one channel, preferring WhatsApp, falling
back to RCS when appropriate, and returning `NO_ELIGIBLE_CHANNEL` otherwise.
Identities belonging to another Contact are ignored. The function is pure,
deterministic, does not mutate input, and performs no discovery send or network
probe.

## 16. Channel Gateway

The gateway is a provider-neutral offline boundary, not domain, repository, CRM,
or persistence. It does not create Contact, Conversation, or Order; it consumes an
existing routing decision and emits a provider-neutral command. Raw provider
fixture objects are normalized and do not become official domain entities.

External provider event/message IDs remain external. Gateway event IDs and CRM
IDs remain internal and opaque. Standard audit events exclude raw payload,
address, message content, and provider message/event IDs.

## 17. Provider Adapters

Meta Official, Google RCS, and optional Evolution implement the same adapter
contract. Evolution is not selected by default and removing it requires no CRM
domain change.

Idempotency uses provider plus provider event ID, or provider plus provider
message ID for message-related events. Keys exclude address, name, and content.
The first synthetic event is `ACCEPTED`; a replay is `DUPLICATE` and emits no
second logical command. The store is process-local only; durable idempotency is a
live-phase blocker.

Outbound preparation produces state `PREPARED` only and contains no endpoint,
token, secret, transport, or implicit `SENT` claim. Retry logic is a pure bounded
calculation with no clock, sleep, timer, worker, queue, or network operation.

Offline simulations passed for Meta inbound, WhatsApp Business App observed
origin, RCS inbound, RCS capability update, and Meta duplicate replay. Output was
the sanitized audit shape.

## 18. Privacy / PII

- Real `*.local.json` files were not opened.
- Real `*.local.json`, `*.plan.json`, and `*.report.json` files must not live
  inside the Git repository, even when ignored.
- No such file is tracked, and F1B-07A adds a workspace privacy check to block
  private local data files and generated artifacts inside the working tree.
- Versioned bootstrap/import/gateway fixtures are explicitly synthetic.
- Contact import reports and gateway audit events are sanitized.
- Technical and idempotency IDs are opaque and do not derive from addresses.
- The event engine now logs only the event type rather than the complete event,
  preventing message/order payload leakage through default runtime logs.

No real PII was added to the branch.

## 19. Network Isolation

No `fetch`, Axios, HTTP(S) request, WebSocket, Socket, Graph endpoint, RCS
endpoint, Evolution endpoint, Google People API, or provider SDK use exists in
the F1B omnichannel, gateway, bootstrap, or import implementation.

Pre-existing Firebase Auth and user-profile reads remain the application's auth
boundary. The optional read-only repository uses the Firebase SDK only when
explicitly selected. Firestore write code exists but its factory activation is
blocked. These are pre-existing Firebase boundaries, not new channel integration.

No provider or remote Firebase call was made by this audit.

## 20. Credential Audit

A versioned-file scan found no private key, service-account material, client
secret, bearer token, provider credential, SSH private key, or embedded channel
secret. Matches for “password” are login parameters and negative security tests.
The `.env.example` contains placeholders only.

The versioned Firebase Web client configuration was treated as public client
configuration, not automatically classified as a private secret. No private
credential was printed or copied into this report.

## 21. Test Inventory / Quality

| Area | Tests after audit | Qualitative coverage |
|---|---:|---|
| Core/application/domain repository behavior | 19 | flow, isolation, referential integrity, idempotency |
| Architecture | 2 | concrete repository escape, generic update, safe logging |
| Firestore write infrastructure | 17 | schema, transaction structure, addressing, activation guard |
| Auth/authorization | 23 | login surface, profile gate, races, UID/runtime scan, rules assertions |
| Firestore read-only | 16 | write rejection, allowlist, atomic/stale hydration, validators |
| Contact bootstrap | 18 | project/tenant/ISO/ID/dedup/create-only/apply/output suffix |
| Contact import | 19 | CSV shapes, mapping, dedup, privacy, output, XLSX fail-closed |
| Omnichannel | 24 | identities, routing, capabilities, persistence validation, compatibility |
| Channel gateway | 32 | normalization, adapters, idempotency, privacy, retry, simulation |
| **Total** | **170** | **5 test files; all offline** |

The pre-audit suite had 167 tests. Three focused contract tests were added. The
audit removed a real-time `<100 ms` assertion from the retry test because exact
output, plus a source assertion forbidding timers, proves the pure contract
without scheduler-dependent flakiness. No exception-swallowing false positive,
mandatory Unix shell command, order-dependent shared test, or bug-hidden timeout
was found. The 20-second bootstrap CLI test timeout remains a Windows process
startup allowance and does not weaken the `--apply` assertion.

## 22. Reproducibility

The first sandboxed `npm ci` failed inside npm while writing its cache/log. The
same approved command outside the sandbox completed with 332 packages. A
sandboxed Vitest launch also failed before config load because esbuild could not
read the parent directory; outside the sandbox the suite passed. The tsx CLIs
similarly required execution outside this sandbox. These were environment
isolation failures, not product failures.

Initial validated sequence:

- `npm ci --no-audit --no-fund`: PASS outside sandbox
- `npm run lint`: PASS
- `npm run test`: 167/167 PASS before audit changes
- `npm run build`: PASS

Final clean reinstall verification: PASS. Only `node_modules` was removed, the
same lockfile install restored 332 packages, and lint, all 170 tests, and the
production build passed again.

## 23. Known Warnings

- npm reports the transitive deprecated package `node-domexception@1.0.0`; no
  direct dependency change was made.
- Vite reports a minified JavaScript chunk above 500 kB (about 1.0 MB before
  gzip). This is a performance warning, not an offline-foundation correctness or
  security blocker.
- Firestore security coverage is static; emulator-backed rule tests are pending.

## 24. Threat Model

| Risk | Existing mitigation | Pending before live |
|---|---|---|
| Webhook spoofing | Authenticator explicitly reports `NOT_CONFIGURED` | Provider-specific signature/challenge verification on exact raw body |
| Replay / duplicate delivery | Provider-scoped key and in-memory reserve; replay test | Durable atomic idempotency with retention and account/tenant scope |
| Token leak | No token fields or credentials in gateway/audit | Secret manager, rotation, least privilege, redaction tests |
| PII in logs | Sanitized gateway/import output; event payload log removed | Central structured logging policy and production verification |
| Provider outage | Typed retryability and bounded pure retry decision | Queue, jitter, circuit breaker, dead-letter handling, operator status |
| Retry storm / rate limit | Maximum attempts/delay model | Distributed throttling, jitter, backpressure, provider quotas |
| Wrong Contact resolution | Gateway cannot create/resolve Contact | Authorized deterministic identity resolver with ambiguity rejection |
| Duplicate Conversation | Gateway cannot create Conversation | Atomic conversation resolution/persistence invariant |
| Duplicate Order | Gateway cannot create Order | Application idempotency keyed to authorized business command |
| Channel mismatch | Router selects one channel; compatibility validators added | Persist and revalidate decision/identity versions at send time |
| Unauthorized admin action | Auth/profile gate, users write deny, default deny | Role/tenant rules and emulator coverage before writes |
| Malformed provider payload | Synthetic validators fail closed to sanitized code | Provider schemas, size/depth limits, raw-body authenticity, fuzzing |

## 25. Live Readiness Matrix

| Capability | Classification | Technical basis |
|---|---|---|
| WhatsApp Meta Official | FOUNDATION READY | Neutral contracts, pure routing, offline adapter, normalized events, prepared outbound; no live transport/auth/persistence |
| Google RCS | FOUNDATION READY | RCS identity/capability/event foundation and simulator; no credentials, agent configuration, regional capability adapter, or live webhook |
| Evolution Optional | DEFERRED | Replaceable offline proof only; non-default and not part of the recommended primary production path |
| Google Contacts People API | DEFERRED | Manual CSV import works; OAuth, consent, API acquisition, and credentials intentionally absent |
| Excel/XLSX | FOUNDATION READY | Input boundary and fail-closed status exist; dependency decision remains pending |
| Firestore first write | BLOCKED | Factory block is intentional; role/tenant rules, emulator proof, activation/runbook, and reserved schema integration are incomplete |
| Hostinger KVM2 channel gateway | BLOCKED | No hardened runtime, ingress, secrets, workers, persistence, observability, or deployment configuration exists |

## 26. Blocking Items

These block live activation, not completion of the offline F1B audit:

1. Product/legal approval for consent, templates, provider onboarding, retention,
   and permitted outbound behavior.
2. Provider sandbox/test accounts and credentials managed outside source control.
3. HTTPS ingress with provider-specific verification/signature and payload limits.
4. Persistent, atomic, tenant/account-scoped idempotency.
5. Authorized identity and Conversation resolution with ambiguity rejection.
6. Durable outbound queue, delivery state machine, retry worker, backpressure,
   dead-letter policy, and rate limiting.
7. Structured privacy-safe observability, alerts, audit retention, and runbooks.
8. Firestore write activation design with role/tenant rules and emulator tests.
9. Hardened deployment/runtime boundary for the chosen host.

## 27. Non-Blocking Pending

- Decide and document real phone validity/country rules before real import.
- Add Firestore emulator-based authorization tests before any write activation.
- Integrate reserved identities/capabilities/routing only in a coordinated future
  schema, repository, rules, hydration, and validator phase.
- Address the Vite chunk-size warning as a separate UI performance task.
- Resolve or accept the transitive npm deprecation through a dependency-governed
  future update; this audit did not alter versions.

## 28. Deferred Items

- Google People API and OAuth.
- XLSX parser/dependency selection.
- Optional Evolution live adapter.
- Real media upload/download and rich-content behavior.
- Provider history/contact sync, presence, catalog, message echo, and other
  capabilities unless confirmed for the configured account/provider.
- Any Hostinger, Docker, SSH, port, IAM, App Check, service-account, or deployment
  work.

## 29. Recommended Next Phase

Proceed with a separately authorized, offline-first “live adapter prerequisites”
phase for one primary provider, preferably WhatsApp Meta Official. Build and test
the HTTP-independent verification interface, canonical provider schemas, durable
idempotency repository contract, identity/Conversation resolution contracts,
outbound state machine, and structured audit contract before introducing real
credentials or network transport.

For RCS, perform the equivalent contract work while treating agent configuration,
regional behavior, per-recipient capability evidence, delivery/read events, and
provider quotas as adapter concerns. Keep Evolution out of the default path.

Host prerequisites must be separated explicitly:

- Code: runtime entrypoint, health/readiness contract, verified webhook boundary,
  persistent idempotency, queue/worker, graceful shutdown.
- Infrastructure: DNS/TLS, isolated service runtime, private egress policy,
  persistence/backup, rollback.
- Security: secret manager, rotation, least privilege, signature verification,
  payload/rate limits, patching, dependency scanning.
- Observability: structured redacted logs, metrics, tracing/correlation, provider
  health, queue depth, retry/dead-letter alerts, incident runbook.

## 30. Exact Safe Activation Sequence

1. Keep `MOCK` as the immediate rollback-safe default.
2. Exercise the existing offline adapters and synthetic contract suites.
3. Introduce one provider sandbox/test adapter behind explicit configuration,
   with no production credentials and with signature/idempotency tests.
4. Observe verified live inbound events without creating automatic outbound or
   business side effects.
5. Enable controlled outbound for a restricted allowlist, rate, template, and
   operator workflow, with durable idempotency and monitoring.
6. Run a time-bounded Restaurante Prato Mineiro pilot with documented consent,
   rollback, incident, and reconciliation procedures.
7. Broaden operation only after evidence from the pilot and a new approval gate.
8. Preserve the ability to return to `MOCK` throughout every activation stage.

## Addendum — F1B-07 Meta Live Prerequisites Offline (2026-09-04)

F1B-07 added offline-only raw-body and trust boundaries, typed webhook auth and
handshake contracts, a provider-neutral cryptographic primitive, strict internal
Meta fixture decoding, durable idempotency lease semantics, Contact identity and
Conversation resolution ports, pure inbound/outbound state machines, an outbound
queue reference, failure/retry/rate-limit foundations, privacy-safe operational
contracts, health/readiness separation, opaque secret references, an
unconfigured transport port, provider-neutral persistence ports, and Simulator
V2 security scenarios.

This addendum does not revise the historical audit conclusion. WhatsApp Meta
foundation maturity advanced, but live remains **NOT_READY**. Official protocol
verification, real authentication, secrets, HTTPS runtime, live transport,
production durable storage and resolution, queue workers, runtime observability,
deployment hardening, and approval gates remain blockers. No channel connection,
remote persistence, credential, deployment, or real-data access was added.

## Addendum — F1B-09 Meta Webhook Security Offline

Meta security now has offline signature and handshake implementations backed by
the supplied archived official evidence, with current reconfirmation explicitly
pending. The handler enforces method, byte-size, JSON content type and auth before
strict decoding; duplicate acquisition precedes resolution. Tests use synthetic
secrets, raw bytes and memory stores. No server or live dependency is configured.
See `meta-webhook-security-offline.md` and the evidence document for exact scope.

META SECURITY FOUNDATION: OFFLINE IMPLEMENTED.
META LIVE STATUS: NOT_READY. Current protocol reconfirmation, real secret
provisioning, HTTPS/TLS, WABA subscription, production durable store, transport,
server persistence, runtime observability and deployment hardening remain.

## Addendum — F1B-10 Batch Webhook Ingress + Durable Admission & ACK Semantics Offline

F1B-10 evolves the Meta webhook boundary to a batch-first, admission-first offline model.
The authenticated POST request is decoded once into independent items. Valid items enter a
conceptual atomic `InboundAdmissionStore` boundary where dedupe/admission state and queued
work become visible together. Contact identity and Conversation resolution are no longer
part of the pre-ACK HTTP path; they execute only in the downstream reference worker.

- **Batch-first decode**: all supported `entry[]`, `changes[]`, `messages[]`, and `statuses[]` candidates are traversed without a single-event-first fallback.
- **Item isolation**: valid, duplicate, unsupported, final-rejected, already-processing, and retryable-admission outcomes are represented independently.
- **Atomic admission semantics**: a new event cannot become a successful dedupe/completed marker before its work item exists. Crash-before-commit allows replay admission; crash-after-commit/response-loss dedupes safely.
- **Inbound work queue**: provider-neutral reference operations cover enqueue, reserve, ack, nack, failFinal, get/list with lease/retry state, using the existing mathematical retry policy.
- **ACK policy separation**: `ACKNOWLEDGE`, `RETRY_REQUEST`, and `REJECT_REQUEST` are LOCAL PROCESSING POLICY. HTTP mapping is a separate function and HTTP status is not persisted as admission state.
- **Current Meta semantics remain unverified**: `META_ACK_RETRY_SEMANTICS_CURRENT_RECONFIRMATION_REQUIRED` remains a live blocker; local HTTP behavior must not be described as current provider retry fact.
- **Local limits/privacy**: `maxDecodedItemsPerRequest` is a local safety limit. Raw payloads, customer/provider addresses, message content, signatures, and secret values stay outside audits/metrics/idempotency errors/provider-facing response bodies.

THIS PHASE DOES NOT CONNECT WHATSAPP.

BATCH INGRESS & ATOMIC ADMISSION FOUNDATION: OFFLINE IMPLEMENTED AFTER AUDIT HARDENING.
META LIVE STATUS: NOT_READY. Production durable admission/work queue, current Meta protocol
and ACK/retry reconfirmation, real secrets, WABA configuration, HTTPS/TLS runtime, worker
runtime, observability, deployment hardening, and controlled live approval remain blockers.
