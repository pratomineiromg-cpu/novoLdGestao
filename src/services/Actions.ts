import { repository } from '../repositories';
import { emitEvent, AppEvent } from '../events/EventEngine';
import { FunnelStage, DispatchQueueEntry, PendingOutboundMessage, ID } from '../domain/types';
import { createId } from '../utils/id';

export const prepareCampaignQueue = async (campaignId: string) => {
  const state = repository.getState();
  const campaign = state.campaigns.find(c => c.id === campaignId);
  if (!campaign) return;

  const existingContactIds = new Set(state.dispatchQueue.filter(q => q.campaignId === campaignId).map(q => q.contactId));
  
  let maxPosition = state.dispatchQueue
    .filter(q => q.campaignId === campaignId)
    .reduce((max, q) => Math.max(max, q.position), 0);
    
  const now = new Date();
  
  const newEntries: DispatchQueueEntry[] = [];

  state.contacts.forEach(contact => {
    if (!existingContactIds.has(contact.id)) {
      maxPosition++;
      newEntries.push({
        id: createId('dq'),
        campaignId,
        contactId: contact.id,
        position: maxPosition,
        status: 'QUEUED',
        attempts: 0,
        createdAt: now
      });
    }
  });

  if (newEntries.length > 0) {
    await repository.addDispatchQueueEntries(newEntries);
  }
};

export const processQueueDrafts = async (campaignId: string) => {
  const state = repository.getState();
  const campaign = state.campaigns.find(c => c.id === campaignId);
  if (!campaign) return;
  const now = new Date();

  const queued = state.dispatchQueue
    .filter(q => q.campaignId === campaignId && q.status === 'QUEUED')
    .sort((a, b) => a.position - b.position)
    .slice(0, campaign.dailyLimit);
  
  const queueUpdates: { id: ID; status: 'DRAFT_PREPARED'; preparedAt: Date }[] = [];
  const newDrafts: PendingOutboundMessage[] = [];
  const eventsToEmit: AppEvent[] = [];

  queued.forEach(q => {
    const contact = state.contacts.find(c => c.id === q.contactId);
    if (!contact) return;
    const conversation = state.conversations.find(c => c.contactId === contact.id);
    if (!conversation) return;
    const messageContent = campaign.template.replace('{{nome}}', contact.name.split(' ')[0]);

    newDrafts.push({
      id: createId('pm'),
      conversationId: conversation.id,
      contactId: contact.id,
      campaignId: campaign.id,
      queueEntryId: q.id,
      content: messageContent,
      createdAt: now
    });

    queueUpdates.push({ id: q.id, status: 'DRAFT_PREPARED', preparedAt: now });
    eventsToEmit.push({ type: 'MESSAGE_DRAFT_CREATED', conversationId: conversation.id, contactId: contact.id });
  });

  if (newDrafts.length > 0) {
    const preparedIds = await repository.prepareDrafts(queueUpdates, newDrafts);
    
    // Only emit events for drafts that were actually prepared by the repository contract
    const actuallyPreparedEvents = eventsToEmit.filter((_, index) => preparedIds.includes(queueUpdates[index].id));
    for (const event of actuallyPreparedEvents) {
      await emitEvent(event);
    }
  }
};

export const sendDraftMessage = async (conversationId: string) => {
  const state = repository.getState();
  const draftIndex = state.pendingMessages.findIndex(pm => pm.conversationId === conversationId);
  if (draftIndex === -1) return;

  const draft = state.pendingMessages[draftIndex];
  const conversation = state.conversations.find(c => c.id === conversationId);
  if (!conversation) return;

  const now = new Date();
  const newMessage = {
    id: createId('msg'),
    conversationId: conversation.id,
    sender: 'USER' as const,
    content: draft.content,
    createdAt: now
  };

  const sent = await repository.sendPreparedMessage(newMessage, draft.id, draft.queueEntryId, now);
  if (sent) {
    await emitEvent({ type: 'MESSAGE_SENT', message: newMessage, contactId: conversation.contactId });
  }
};

export const simulateClientResponse = async (conversationId: string, content: string = 'Olá, tenho interesse!') => {
  const state = repository.getState();
  const conversation = state.conversations.find(c => c.id === conversationId);
  if (!conversation) return;

  const now = new Date();
  const newMessage = {
    id: createId('msg'),
    conversationId: conversation.id,
    sender: 'CONTACT' as const,
    content,
    createdAt: now
  };

  const contactSentEntries = state.dispatchQueue
    .filter(q => q.contactId === conversation.contactId && q.status === 'SENT')
    .sort((a, b) => (b.sentAt?.getTime() || 0) - (a.sentAt?.getTime() || 0));
    
  const queueEntryToReply = contactSentEntries.length > 0 ? {
    id: contactSentEntries[0].id,
    campaignId: contactSentEntries[0].campaignId,
    contactId: contactSentEntries[0].contactId
  } : undefined;

  await repository.processClientResponse(newMessage, conversation.id, now, queueEntryToReply, now);
  await emitEvent({ type: 'MESSAGE_RECEIVED', message: newMessage, contactId: conversation.contactId });
};

export interface CreateOrderItemInput {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  observation: string;
}

export const createOrder = async (contactId: string, items: CreateOrderItemInput[], paymentMethod: string) => {
  const state = repository.getState();
  const now = new Date();
  const orderId = createId('ord');
  const conversation = state.conversations.find(c => c.contactId === contactId);
  
  const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  
  const order = {
    id: orderId,
    tenantId: state.tenant.id,
    contactId,
    entryPoint: 'CHAT' as const,
    channel: 'WHATSAPP' as const,
    creationMode: 'HUMAN_OPERATOR' as const,
    conversationId: conversation?.id,
    total,
    status: 'CREATED' as const,
    paymentMethod,
    createdAt: now,
    updatedAt: now,
  };
  
  const orderItems = items.map(item => ({
    id: createId('oi'),
    orderId: order.id,
    ...item
  }));

  let systemMessage;
  if (conversation) {
    systemMessage = {
      id: createId('msg'),
      conversationId: conversation.id,
      sender: 'SYSTEM' as const,
      content: `Pedido #${order.id.split('-')[1] || order.id} gerado com sucesso. Valor total: R$ ${order.total.toFixed(2)}`,
      createdAt: now
    };
  }

  await repository.createOrderWithItems(order, orderItems, systemMessage);
  await emitEvent({ type: 'ORDER_CREATED', order, contactId });
};

export const changeOpportunityStage = async (contactId: string, newStage: FunnelStage) => {
  const state = repository.getState();
  const opp = state.opportunities.find(o => o.contactId === contactId);
  if (opp) {
    await emitEvent({ type: 'FUNNEL_STAGE_CHANGED', opportunityId: opp.id, newStage, contactId });
  } else {
    await emitEvent({ type: 'FUNNEL_STAGE_CHANGED', opportunityId: createId('opp'), newStage, contactId });
  }
};

export const updateCampaignDailyLimit = async (campaignId: string, limit: number) => {
  await repository.updateCampaignDailyLimit(campaignId, limit, new Date());
};
