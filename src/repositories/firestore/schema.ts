// Collection names
export const COLLECTIONS = {
  USERS: 'users',
  CONTACTS: 'contacts',
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  OPPORTUNITIES: 'opportunities',
  DISPATCH_CAMPAIGNS: 'dispatchCampaigns',
  DISPATCH_QUEUE: 'dispatchQueue',
  PENDING_OUTBOUND_MESSAGES: 'pendingOutboundMessages',
  ORDERS: 'orders',
  ORDER_ITEMS: 'orderItems',
  TIMELINE_EVENTS: 'timelineEvents',
  CUSTOMER_PROFILES: 'customerProfiles',
  CUSTOMER_ADDRESSES: 'customerAddresses',
  /** Domain contract only in F1B-05B; it is not an active operational collection. */
  CONTACT_CHANNEL_IDENTITIES: 'contactChannelIdentities'
} as const;

// Path generators
export const userDocumentId = (uid: string) => uid;
export const getOpportunityPath = (contactId: string) => `${COLLECTIONS.OPPORTUNITIES}/${contactId}`;
export const getCustomerProfilePath = (contactId: string) => `${COLLECTIONS.CUSTOMER_PROFILES}/${contactId}`;

export const dispatchQueueDocumentId = (campaignId: string, contactId: string) => {
  return `${encodeURIComponent(campaignId)}::${encodeURIComponent(contactId)}`;
};

export const getDispatchQueuePath = (campaignId: string, contactId: string) => {
  return `${COLLECTIONS.DISPATCH_QUEUE}/${dispatchQueueDocumentId(campaignId, contactId)}`;
};

export const getPendingOutboundMessagePath = (queueEntryId: string) => {
  return `${COLLECTIONS.PENDING_OUTBOUND_MESSAGES}/${queueEntryId}`;
};

/**
 * Future identities use an opaque LidacomZap ID (for example createId('identity'))
 * as the document key. Never use a channel address, phone, name, or email here.
 */
export const getContactChannelIdentityPath = (identityId: string) => {
  return `${COLLECTIONS.CONTACT_CHANNEL_IDENTITIES}/${identityId}`;
};
