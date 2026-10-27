import type {
  ChannelProvider,
  CommunicationChannel,
  ContactChannelIdentity,
  ContactImportReport,
  ContactImportSource,
  MessageContentType,
  MessageOriginSurface,
  OrderChannel,
  RoutingMode
} from './omnichannel';

export type {
  CapabilitySource,
  ChannelAvailability,
  ChannelCapability,
  ChannelEligibility,
  ChannelProvider,
  CommunicationChannel,
  ContactChannelIdentity,
  ContactImportReport,
  ContactImportSource,
  ContactImportTechnicalReason,
  ContactImportTechnicalReasonCode,
  CreateContactChannelIdentityInput,
  CreateProviderCapabilitiesInput,
  EligibilitySource,
  ExternalMessageReference,
  MessageContentType,
  MessageOriginSurface,
  OrderChannel,
  ProviderCapabilities,
  RoutingDecision,
  RoutingMode,
  RoutingReason
} from './omnichannel';

export type ID = string;

export interface Tenant {
  id: ID;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: ID;
  tenantId: ID;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Contact {
  id: ID;
  tenantId: ID;
  name: string;
  phone: string;
  avatar?: string;
  tags: string[];
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A source adapter produces candidates; the contact remains a CRM person and
 * identities stay separate so one person can be present on multiple channels.
 */
export interface ContactImportCandidate {
  contact: Pick<Contact, 'tenantId' | 'name' | 'phone' | 'avatar' | 'tags' | 'notes'>;
  identities: ContactChannelIdentity[];
}

export interface ContactImportPreview {
  candidates: ContactImportCandidate[];
  report: ContactImportReport;
}

/** Offline parsing contract only. Source acquisition belongs to a future adapter. */
export interface ContactImporter {
  readonly source: ContactImportSource;
  preview(input: unknown): ContactImportPreview;
}

export interface Conversation {
  id: ID;
  tenantId: ID;
  contactId: ID;
  channel?: CommunicationChannel;
  provider?: ChannelProvider;
  externalConversationId?: string;
  unreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageSender = 'USER' | 'CONTACT' | 'SYSTEM';

export interface Message {
  id: ID;
  conversationId: ID;
  sender: MessageSender;
  content: string;
  channel?: CommunicationChannel;
  provider?: ChannelProvider;
  providerMessageId?: string;
  originSurface?: MessageOriginSurface;
  contentType?: MessageContentType;
  createdAt: Date;
}

export interface PendingOutboundMessage {
  id: ID;
  conversationId: ID;
  contactId: ID;
  campaignId: ID;
  queueEntryId: ID;
  content: string;
  createdAt: Date;
}

export type FunnelStage = 
  | 'RASCUNHO' 
  | 'LEAD' 
  | 'EM ATENDIMENTO' 
  | 'PEDIDO GERADO' 
  | 'AGUARDANDO PAGAMENTO' 
  | 'PAGO' 
  | 'PRODUÇÃO' 
  | 'ENTREGUE' 
  | 'FECHADO' 
  | 'PÓS-VENDA';

export interface Opportunity {
  id: ID;
  tenantId: ID;
  contactId: ID;
  stage: FunnelStage;
  createdAt: Date;
  updatedAt: Date;
}

export interface DispatchCampaign {
  id: ID;
  tenantId: ID;
  name: string;
  template: string;
  dailyLimit: number;
  /** Absent means the legacy campaign has not received a routing policy yet. */
  routingMode?: RoutingMode;
  createdAt: Date;
  updatedAt: Date;
}

/** Commercial planning is intentionally separate from a concrete dispatch operation. */
export interface MarketingCampaign {
  id: ID;
  tenantId: ID;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DispatchQueueStatus = 'QUEUED' | 'DRAFT_PREPARED' | 'SENT' | 'REPLIED' | 'FAILED' | 'SKIPPED';

export interface DispatchQueueIdentity {
  id: ID;
  campaignId: ID;
  contactId: ID;
}

export interface DispatchQueueEntry {
  id: ID;
  campaignId: ID;
  contactId: ID;
  position: number;
  status: DispatchQueueStatus;
  attempts: number;
  createdAt: Date;
  preparedAt?: Date;
  sentAt?: Date;
  repliedAt?: Date;
}

export type OrderEntryPoint = 'DIGITAL_MENU' | 'CHAT' | 'POS' | 'TABLE_QR';
export type OrderCreationMode = 'CUSTOMER' | 'HUMAN_OPERATOR' | 'AI_ASSISTED' | 'AUTOMATION';

export type OrderStatus = 'CREATED' | 'PAID' | 'CANCELED';

export interface Order {
  id: ID;
  tenantId: ID;
  contactId: ID;
  entryPoint: OrderEntryPoint;
  channel: OrderChannel;
  creationMode: OrderCreationMode;
  total: number;
  status: OrderStatus;
  paymentMethod: string;
  createdAt: Date;
  updatedAt: Date;
  
  conversationId?: ID;
  dispatchCampaignId?: ID;
  queueEntryId?: ID;
}

export interface CustomerProfile {
  id: ID;
  contactId: ID;
  fullName: string;
  phone: string;
  email?: string;
}

export interface CustomerAddress {
  id: ID;
  contactId: ID;
  street: string;
  number: string;
  neighborhood: string;
  complement?: string;
  postalCode: string;
}

export interface OrderItem {
  id: ID;
  orderId: ID;
  productId: ID;
  productName: string;
  quantity: number;
  price: number;
  observation?: string;
}

export interface TimelineEvent {
  id: ID;
  contactId: ID;
  type: string;
  description: string;
  createdAt: Date;
}

export interface Product {
  id: ID;
  name: string;
  price: number;
  category: string;
}
