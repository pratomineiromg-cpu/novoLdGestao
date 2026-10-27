import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase/firebase';
import { AppRepository, DatabaseState, OpportunityTransitionResult } from './IRepository';
import { ID, Order, OrderItem, Message, TimelineEvent, DispatchQueueEntry, PendingOutboundMessage, FunnelStage, DispatchQueueIdentity, Contact, Conversation, Opportunity, DispatchCampaign, CustomerProfile, CustomerAddress } from '../domain/types';
import { createEmptyDatabaseState } from './firestore/emptyState';
import { COLLECTIONS } from './firestore/schema';
import { fromFirestore } from './firestore/serializers';
import {
  validateContact,
  validateConversation,
  validateMessage,
  validateOpportunity,
  validateDispatchCampaign,
  validateDispatchQueueEntry,
  validatePendingOutboundMessage,
  validateOrder,
  validateOrderItem,
  validateTimelineEvent,
  validateCustomerProfile,
  validateCustomerAddress
} from './firestore/readValidators';

export type HydrationStatus = 'idle' | 'loading' | 'ready' | 'error';

export const OPERATIONAL_COLLECTIONS = [
  COLLECTIONS.CONTACTS,
  COLLECTIONS.CONVERSATIONS,
  COLLECTIONS.MESSAGES,
  COLLECTIONS.OPPORTUNITIES,
  COLLECTIONS.DISPATCH_CAMPAIGNS,
  COLLECTIONS.DISPATCH_QUEUE,
  COLLECTIONS.PENDING_OUTBOUND_MESSAGES,
  COLLECTIONS.ORDERS,
  COLLECTIONS.ORDER_ITEMS,
  COLLECTIONS.TIMELINE_EVENTS,
  COLLECTIONS.CUSTOMER_PROFILES,
  COLLECTIONS.CUSTOMER_ADDRESSES
] as const;

export type AllowedOperationalCollection = typeof OPERATIONAL_COLLECTIONS[number];

export function isOperationalCollectionAllowed(col: string): boolean {
  if (col === COLLECTIONS.USERS) return false;
  return (OPERATIONAL_COLLECTIONS as readonly string[]).includes(col);
}

export class FirestoreReadOnlyRepository implements AppRepository {
  private cache: DatabaseState;
  private status: HydrationStatus = 'idle';
  private errorMessage: string | null = null;
  private generation: number = 0;
  private listeners: Set<() => void> = new Set();
  private firestoreInstance: any;

  constructor(customDb?: any) {
    this.cache = createEmptyDatabaseState();
    this.firestoreInstance = customDb || db;
  }

  // AppReadStore implementation
  getState(): DatabaseState {
    return this.cache;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }

  // Hydration status getters
  getHydrationStatus(): HydrationStatus {
    return this.status;
  }

  getHydrationError(): string | null {
    return this.errorMessage;
  }

  getHydrationGeneration(): number {
    return this.generation;
  }

  // Write defense in depth: All mutable operations reject before touching Firebase
  async addDispatchQueueEntries(_entries: DispatchQueueEntry[]): Promise<void> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async prepareDrafts(
    _queueUpdates: { id: ID; status: 'DRAFT_PREPARED'; preparedAt: Date }[],
    _newDrafts: PendingOutboundMessage[]
  ): Promise<ID[]> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async sendPreparedMessage(
    _message: Message,
    _draftId: ID,
    _queueEntryId: ID,
    _sentAt: Date
  ): Promise<boolean> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async processClientResponse(
    _message: Message,
    _conversationId: ID,
    _updatedAt: Date,
    _queueEntryToReply?: DispatchQueueIdentity,
    _repliedAt?: Date
  ): Promise<void> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async createOrderWithItems(
    _order: Order,
    _orderItems: OrderItem[],
    _systemMessage?: Message
  ): Promise<void> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async updateCampaignDailyLimit(_campaignId: ID, _limit: number, _updatedAt: Date): Promise<void> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async transitionOpportunityStage(
    _contactId: ID,
    _tenantId: ID,
    _newStage: FunnelStage,
    _timestamp: Date
  ): Promise<OpportunityTransitionResult> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async addTimelineEvent(_event: TimelineEvent): Promise<void> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  async reset(): Promise<void> {
    throw new Error('Operation is disabled in FIRESTORE_READONLY mode.');
  }

  // Atomic Hydration with stale protection
  async hydrate(customLoader?: (colName: AllowedOperationalCollection) => Promise<any[]>): Promise<boolean> {
    const currentGen = ++this.generation;
    this.status = 'loading';
    this.errorMessage = null;
    this.notify();

    try {
      // 1. Fetch each collection either with customLoader (testable) or getDocs
      const fetchCollectionDocs = async (colName: AllowedOperationalCollection): Promise<any[]> => {
        if (!isOperationalCollectionAllowed(colName)) {
          throw new Error(`Collection ${colName} is not in the operational allowlist.`);
        }

        if (customLoader) {
          return await customLoader(colName);
        }

        const colRef = collection(this.firestoreInstance, colName);
        const snapshot = await getDocs(colRef);
        const docs: any[] = [];
        snapshot.forEach(docSnap => {
          docs.push({
            _docId: docSnap.id,
            ...fromFirestore(docSnap.data())
          });
        });
        return docs;
      };

      // Atomic fetch of all 12 allowed operational collections in parallel
      const [
        rawContacts,
        rawConversations,
        rawMessages,
        rawOpportunities,
        rawCampaigns,
        rawDispatchQueue,
        rawPending,
        rawOrders,
        rawOrderItems,
        rawTimeline,
        rawProfiles,
        rawAddresses
      ] = await Promise.all([
        fetchCollectionDocs(COLLECTIONS.CONTACTS),
        fetchCollectionDocs(COLLECTIONS.CONVERSATIONS),
        fetchCollectionDocs(COLLECTIONS.MESSAGES),
        fetchCollectionDocs(COLLECTIONS.OPPORTUNITIES),
        fetchCollectionDocs(COLLECTIONS.DISPATCH_CAMPAIGNS),
        fetchCollectionDocs(COLLECTIONS.DISPATCH_QUEUE),
        fetchCollectionDocs(COLLECTIONS.PENDING_OUTBOUND_MESSAGES),
        fetchCollectionDocs(COLLECTIONS.ORDERS),
        fetchCollectionDocs(COLLECTIONS.ORDER_ITEMS),
        fetchCollectionDocs(COLLECTIONS.TIMELINE_EVENTS),
        fetchCollectionDocs(COLLECTIONS.CUSTOMER_PROFILES),
        fetchCollectionDocs(COLLECTIONS.CUSTOMER_ADDRESSES)
      ]);

      // 2. Validate & Map strictly into candidate state (throws on any malformed/invalid record)
      const contacts: Contact[] = rawContacts.map(validateContact);
      const conversations: Conversation[] = rawConversations.map(validateConversation);
      const messages: Message[] = rawMessages.map(validateMessage);
      const opportunities: Opportunity[] = rawOpportunities.map(validateOpportunity);
      const campaigns: DispatchCampaign[] = rawCampaigns.map(validateDispatchCampaign);
      const dispatchQueue: DispatchQueueEntry[] = rawDispatchQueue.map(validateDispatchQueueEntry);
      const pendingMessages: PendingOutboundMessage[] = rawPending.map(validatePendingOutboundMessage);
      const orders: Order[] = rawOrders.map(validateOrder);
      const orderItems: OrderItem[] = rawOrderItems.map(validateOrderItem);
      const timeline: TimelineEvent[] = rawTimeline.map(validateTimelineEvent);
      const customerProfiles: CustomerProfile[] = rawProfiles.map(validateCustomerProfile);
      const customerAddresses: CustomerAddress[] = rawAddresses.map(validateCustomerAddress);

      const candidateState: DatabaseState = {
        tenant: {
          id: 't-pratomineiro',
          name: 'Restaurante Prato Mineiro',
          createdAt: new Date(),
          updatedAt: new Date()
        },
        users: [],
        contacts,
        conversations,
        messages,
        pendingMessages,
        opportunities,
        campaigns,
        dispatchQueue,
        orders,
        orderItems,
        timeline,
        products: [],
        customerProfiles,
        customerAddresses
      };

      // 3. Stale guard: Check if this generation is still current
      if (currentGen !== this.generation) {
        return false;
      }

      // 4. Atomic commit: Replace whole cache only after ALL succeeded
      this.cache = candidateState;
      this.status = 'ready';
      this.errorMessage = null;
      this.notify();
      return true;

    } catch (err: any) {
      if (currentGen !== this.generation) {
        return false;
      }

      this.status = 'error';
      this.errorMessage = err?.message || 'Falha ao hidratar dados do Firestore.';
      this.notify();
      return false;
    }
  }
}

