# Omnichannel Contact and Messaging Foundation

## Scope and baseline

LidacomZap Gestão Inteligente is the official baseline for this work. Historical
projects and concepts, including CRM GreenHub, WhatsApp Web automation, Baileys,
Evolution API flows, old screens, and old prompts are reference material only.
They do not replace this repository's approved domain contracts or architecture.

F1B-05B establishes offline domain contracts, pure routing, tests, and
documentation. It does not connect to a channel, install a channel SDK, obtain
credentials, access remote Firestore, run a bootstrap apply, or create a live
provider adapter.

## Contact, channels, and providers

`Contact` represents a person/customer in the CRM. It is not a WhatsApp contact,
an RCS address, a Google Contact record, a spreadsheet row, or a provider session.
One Contact can have multiple `ContactChannelIdentity` records, such as one
WhatsApp identity and one RCS identity. A channel identity owns its normalized
address and optional provider reference; it never changes the Contact's CRM ID.

The existing `Contact.phone` field remains untouched for backwards compatibility
with the approved F1B-05A bootstrap and existing UI. It is not a new provider
binding and must not be used as the identity or routing model for a new channel.

`CommunicationChannel` contains only `WHATSAPP` and `RCS`. `OrderChannel` retains
`NONE`, because an order can have no channel attribution without treating `NONE`
as a communicable channel.

Providers are replaceable domain identifiers:

- `WHATSAPP_META_OFFICIAL` is the principal future product direction.
- `WHATSAPP_EVOLUTION_OPTIONAL` is an optional, isolated, experimental future
  alternative. It is not the baseline, is not the default, and must be removable
  without changing Contact, Conversation, Message, Order, Campaign, or routing.
- `RCS_GOOGLE` is the future RCS provider contract.

There is no WhatsApp Web dependency or structural `WhatsApp Web Active` state.
The desired future WhatsApp mode is coexistence with WhatsApp Business App only
when the account is eligible and the official implementation details have been
confirmed in a live phase. History sync, contact sync, message echoes, presence,
catalog support, onboarding, and coexistence eligibility are capabilities or
adapter behavior, never universal domain guarantees.

## Identity, availability, eligibility, and capabilities

Each `ContactChannelIdentity` has an opaque LidacomZap technical ID. Its ID and
any future public menu token must never contain a phone number, name, email, or
other PII. Future identity document keys use an opaque generated ID, not an
address-derived key.

Availability and eligibility are intentionally separate:

- Availability is `UNKNOWN`, `KNOWN_AVAILABLE`, or `KNOWN_UNAVAILABLE`, with a
  timestamp/source when known.
- Eligibility is `UNKNOWN`, `ELIGIBLE`, or `INELIGIBLE`.

`UNKNOWN` is never silently treated as available or eligible. The pure identity
factory defaults both values to `UNKNOWN`; no capability check or policy is
performed by this foundation.

`ProviderCapabilities` records only capabilities explicitly reported by a future
adapter for a channel/provider pair. An absent record or absent capability is not
available. The existence of values such as audio, catalog, read receipt, message
echo, presence, contact sync, rich media, or template does not claim a live
provider supports them.

Future RCS capability work may perform individual or batch checks, cache evidence
with a timestamp/source, and process later updates. Capability is not eternal.
Any future batch RCS capability work must respect the regionalization and API
requirements current at that time. RCS inbound messages and related delivery,
read, subscription, and unsubscription events will arrive through a future
adapter/webhook boundary; this phase has no HTTP implementation or Google SDK.

## Conversations and messages

Conversation remains a CRM entity, not a raw provider object. It can now carry
optional channel, provider, and external-conversation-ID metadata while preserving
legacy documents that have none of those fields. No access token, API key,
session, QR material, or credential belongs in it.

Message retains its LidacomZap internal ID, sender, textual content, and timestamp.
Optional channel, provider, external provider message ID, origin surface, and
content type prepare it for omnichannel history without media upload, storage,
streaming, audio, PDF, or provider-media behavior. Content types are domain labels
only.

`provider + providerMessageId` is an external-event idempotency reference. It
does not replace the internal Message ID. The future persistence adapter must use
that pair to prevent logical duplication of the same provider event.

`WHATSAPP_BUSINESS_APP` is a representable origin surface. If a future official
provider actually delivers an operator's mobile-app message event, it may be added
to the existing Contact and Conversation with the provider message ID. This is not
a promise that every provider supplies echoes, sync, history, or presence.

## Ingestion and import reporting

WhatsApp coexistence, Excel, CSV, and Google Contacts are ingestion sources, not
Contact entities. `ContactImporter` is an offline parsing/preview contract that
turns already-acquired input into Contact candidates, channel identities, and a
technical report. It does not know infrastructure and has no OAuth, Google People,
file-upload, spreadsheet, CSV, or WhatsApp implementation in this phase.

Import reports contain source, opaque operation/import IDs, timestamps, aggregate
found/valid/rejected/duplicate counts, and coded technical reasons. They do not
include address, name, phone, email, or source-row content by default. Existing
F1B-05A canonical-phone normalization and deduplication remain unchanged; this
foundation does not introduce a competing normalization rule or replace bootstrap.

## Campaigns, orders, menu attribution, and routing

`DispatchCampaign` remains the concrete sending operation. `MarketingCampaign`
is a separate commercial/planning contract and is not fused into the dispatch
queue. A dispatch campaign may carry an optional `RoutingMode`; it does not cause
any sending behavior in this phase.

Order attribution stays intact:

- `entryPoint`: `DIGITAL_MENU`, `CHAT`, `POS`, or `TABLE_QR`
- `channel`: `WHATSAPP`, `RCS`, or `NONE`
- `creationMode`: `CUSTOMER`, `HUMAN_OPERATOR`, `AI_ASSISTED`, or `AUTOMATION`
- optional `conversationId`, `dispatchCampaignId`, and `queueEntryId`

A future menu link uses an opaque attribution token. Whether that link was sent by
the platform, copied by an operator, sent from a mobile app, or delivered over a
future channel must not create a parallel ordering system. After token/context
resolution, the Order enters the same official domain and can reference its
Conversation, Contact, and Campaign when available.

The pure router accepts Contact ID, requested mode, identities, and an explicit
evaluation time. It has no provider calls, network access, sending, capability
probe, or mutable state.

- `WHATSAPP` selects WhatsApp only when an identity is both
  `KNOWN_AVAILABLE` and `ELIGIBLE`.
- `RCS` follows the same rule.
- `BOTH_SMART` selects exactly one channel: eligible WhatsApp first, otherwise
  eligible RCS, otherwise no route.

`BOTH_SMART` never means send to both channels. It never uses a test message to
discover WhatsApp availability. Every decision has a typed, auditable reason,
including selected, unavailable fallback, ineligible fallback, requested-channel
failure, and no-eligible-channel outcomes.

## Firestore and repository boundary

Firebase/Firestore remains the official future persistence boundary; the VPS is
not the commercial source of truth. This phase does not activate Firestore writes
or alter the safe `MOCK` default. `FIRESTORE_READONLY` continues to reject every
mutation before any Firebase operation.

The local schema reserves `contactChannelIdentities` and an opaque document-key
policy for a future persistence phase. It is deliberately not included in the
current `DatabaseState`, read-only hydration allowlist, rules rollout, or
repository write surface. Adding it to live persistence requires one coordinated
future change to state, validation, read-only hydration, rules, and semantic
repository methods. Routing decisions and provider capabilities are contracts in
this phase, not active collections.

The existing recursive Firestore serializer can represent optional domain fields;
strict validators preserve legacy Conversation/Message documents while validating
omnichannel fields whenever they are present. Views, routing, and importers remain
independent from Firebase.

## Future Channel Gateway and omnichannel console

The future deployment shape is documentation only:

```text
Hostinger KVM2
        ↓
LidacomZap Channel Gateway
  ├── WhatsApp Meta Adapter
  ├── Evolution Adapter (optional)
  ├── Google RCS Adapter
  ├── inbound webhooks
  ├── outbound workers
  ├── idempotency, retries, observability
  └── channel routing
        ↓
LidacomZap domain and official Firestore persistence
```

The future central is omnichannel, not `WhatsAppView`, with three coordinated
surfaces: a conversations list, an active conversation, and CRM context for the
Contact. UI controls are capability-driven: audio, catalog, templates, rich media,
read receipts, message echo, and presence appear only when the actual channel,
provider, configuration, and reported capability support them. No feature is
shown merely because it appeared in a historical UI design.
