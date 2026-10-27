# Firestore Schema Documentation
## LidacomZap Gestão Inteligente

### Multi-tenant Note
**The current operation pilot is for a single company (Restaurante Prato Mineiro).** There are currently no tenant-specific prefixes or isolated namespaces in the paths. All documents exist globally within their respective collections.

---

### Collections

#### 1. `contacts`
*   **Document ID:** Domain `contactId` (e.g. `c-1234`)
*   **Fields:** Standard contact fields.
*   **Timestamp Strategy:** Managed by Firestore (`serverTimestamp`) for `createdAt` and `updatedAt`.
*   **Realtime/On-demand:** Realtime updates planned via `onSnapshot` when activated.

#### 2. `opportunities`
*   **Document ID:** `contactId` (Matches the associated contact). **This structurally guarantees 1 Opportunity per Contact.**
*   **Domain ID (`opportunity.id`):** Still generated internally using `createId('opp')`.
*   **Transaction:** Written using `runTransaction` to safely enforce the singleton pattern per contact and correctly calculate the `created`, `changed`, `previousStage`, and `currentStage` fields.

#### 3. `dispatchQueue`
*   **Document ID:** `queueDocumentId` (where `queueDocumentId` = `dispatchQueueDocumentId(campaignId, contactId)`)
*   **Domain ID (`id`):** Maintained as the original technical ID (`queueEntryId`).
*   **Invariant:** Deterministic ID guarantees only 1 QueueEntry per Campaign + Contact pair, eliminating duplicates at the database level.
*   **Position:** The `position` is assigned authoritatively by `FirestoreRepository` when the real infrastructure is active, ensuring ordered monotonic behavior via `dispatchCampaigns`.
*   **Note:** The Document ID is NOT the `queueEntryId`. It uses the pattern `encodeURIComponent(campaignId)::encodeURIComponent(contactId)`.

#### 3.b `dispatchCampaigns`
*   **Document ID:** Domain `campaignId`
*   **Infrastructure Fields:** `nextQueuePosition` - infrastructure counter used for concurrent allocation of `dispatchQueue` positions.

#### 4. `pendingOutboundMessages`
*   **Document ID:** `queueEntryId` (The domain's technical UUID).
*   **Invariant:** Structurally guarantees a maximum of 1 active Draft per QueueEntry.

#### 5. `conversations`
*   **Document ID:** Domain `conversationId`

#### 6. `messages`
*   **Document ID:** Domain `messageId`
*   **Relationships:** Contains `conversationId` for parent lookup.
*   **Batching/Transactions:**
    *   During send operation (`sendPreparedMessage`), a `runTransaction` validates that the Draft, QueueEntry, and Conversation all belong to the correct IDs before securely deleting the draft, promoting the queue status to `SENT`, and writing the `message`.
    *   `processClientResponse` uses a transaction specifically to advance `SENT -> REPLIED`.

#### 7. `orders` & `orderItems`
*   **Document IDs:** Domain `orderId` and `orderItemId`.
*   **Transaction/Batch:** Uses `writeBatch` to atomically create the `order`, all its `orderItems`, and an optional `systemMessage`.

#### 8. `timelineEvents`
*   **Document ID:** Domain `timelineEventId`
*   **Fields:** Standard event logs (`MESSAGE_DRAFT_CREATED`, etc.).
*   **Batching:** Uses `writeBatch` for atomic insert.

#### 9. `customerProfiles` & `customerAddresses`
*   **`customerProfiles` Document ID:** `contactId` (1 per contact).
*   **`customerAddresses` Document ID:** Domain `addressId` (with `contactId` field).

---

### Timestamp Strategy
*   Domain Dates are isolated from Firestore representations.
*   When writing, `serverTimestamp()` is preferred for `createdAt`, `updatedAt`, `sentAt`, `repliedAt`.
*   The application continues to use standard JS `Date` objects in memory. A serialization layer handles the translation.
