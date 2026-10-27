import {
  Tenant, User, Contact, Conversation, Message, PendingOutboundMessage,
  Opportunity, DispatchCampaign, DispatchQueueEntry, DispatchQueueIdentity, Order, OrderItem, TimelineEvent, Product, ID, FunnelStage,
  CustomerProfile, CustomerAddress
} from '../domain/types';

export interface DatabaseState {
  tenant: Tenant;
  users: User[];
  contacts: Contact[];
  conversations: Conversation[];
  messages: Message[];
  pendingMessages: PendingOutboundMessage[];
  opportunities: Opportunity[];
  campaigns: DispatchCampaign[];
  dispatchQueue: DispatchQueueEntry[];
  orders: Order[];
  orderItems: OrderItem[];
  timeline: TimelineEvent[];
  products: Product[];
  customerProfiles: CustomerProfile[];
  customerAddresses: CustomerAddress[];
}

export interface AppReadStore {
  getState: () => DatabaseState;
  subscribe: (listener: () => void) => () => void;
}

export interface OpportunityTransitionResult {
  opportunity: Opportunity;
  created: boolean;
  changed: boolean;
  previousStage?: FunnelStage;
  currentStage: FunnelStage;
}

export interface AppRepository extends AppReadStore {
  // Write Operations
  addDispatchQueueEntries(entries: DispatchQueueEntry[]): Promise<void>;
  
  prepareDrafts(
    queueUpdates: { id: ID; status: 'DRAFT_PREPARED'; preparedAt: Date }[],
    newDrafts: PendingOutboundMessage[]
  ): Promise<ID[]>;

  sendPreparedMessage(
    message: Message,
    draftId: ID,
    queueEntryId: ID,
    sentAt: Date
  ): Promise<boolean>;

  processClientResponse(
    message: Message,
    conversationId: ID,
    updatedAt: Date,
    queueEntryToReply?: DispatchQueueIdentity,
    repliedAt?: Date
  ): Promise<void>;

  createOrderWithItems(
    order: Order,
    orderItems: OrderItem[],
    systemMessage?: Message
  ): Promise<void>;

  updateCampaignDailyLimit(campaignId: ID, limit: number, updatedAt: Date): Promise<void>;

  transitionOpportunityStage(
    contactId: ID,
    tenantId: ID,
    newStage: FunnelStage,
    timestamp: Date
  ): Promise<OpportunityTransitionResult>;
  
  addTimelineEvent(event: TimelineEvent): Promise<void>;

  reset(): Promise<void>;
}
