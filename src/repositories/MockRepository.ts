import {
  Tenant, User, Contact, Conversation, Message, PendingOutboundMessage,
  Opportunity, DispatchCampaign, DispatchQueueEntry, Order, OrderItem, TimelineEvent, Product, ID
} from '../domain/types';
import { DatabaseState, AppRepository } from './IRepository';
import { createId } from '../utils/id';

export const createInitialState = (): DatabaseState => {
  const tenantId = 't-1';
  const now = new Date();

  const contacts: Contact[] = Array.from({ length: 20 }).map((_, i) => ({
    id: `c-${i + 1}`,
    tenantId,
    name: `Cliente ${i + 1}`,
    phone: `55119999900${i.toString().padStart(2, '0')}`,
    tags: i % 3 === 0 ? ['VIP'] : [],
    notes: '',
    createdAt: new Date(now.getTime() - i * 10000000),
    updatedAt: new Date(now.getTime() - i * 100000),
  }));

  const conversations: Conversation[] = contacts.map(c => ({
    id: `conv-${c.id}`,
    tenantId,
    contactId: c.id,
    unreadCount: 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));

  const products: Product[] = [
    { id: 'p-1', name: 'X-Burger', price: 25.00, category: 'Lanches' },
    { id: 'p-2', name: 'X-Bacon', price: 32.00, category: 'Lanches' },
    { id: 'p-3', name: 'Batata Frita', price: 15.00, category: 'Porções' },
    { id: 'p-4', name: 'Refrigerante Cola Lata', price: 6.00, category: 'Bebidas' },
  ];

  return {
    tenant: { id: tenantId, name: 'Restaurante Prato Mineiro', createdAt: now, updatedAt: now },
    users: [{ id: 'u-1', tenantId, name: 'Atendente', email: 'atendimento@demo.com', createdAt: now, updatedAt: now }],
    contacts,
    conversations,
    messages: [],
    pendingMessages: [],
    opportunities: [], // Let event engine or manual actions populate these
    campaigns: [{
      id: 'camp-1',
      tenantId,
      name: 'Promoção de Terça',
      template: 'Olá {{nome}}! Veja nosso cardápio de hoje com descontos especiais.',
      dailyLimit: 250,
      createdAt: now,
      updatedAt: now
    }],
    dispatchQueue: [],
    orders: [],
    orderItems: [],
    timeline: [],
    products,
    customerProfiles: [],
    customerAddresses: [],
  };
};

// Singleton in-memory store for demonstration purposes
let state: DatabaseState = createInitialState();
type Listener = () => void;
const listeners = new Set<Listener>();

const updateState = (updater: (draft: DatabaseState) => void) => {
  const nextState = { ...state };
  updater(nextState);
  state = nextState;
  listeners.forEach(l => l());
};

export const mockRepository: AppRepository = {
  getState: () => state,
  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  addDispatchQueueEntries: async (entries) => {
    updateState(draft => {
      const existingPairs = new Set(draft.dispatchQueue.map(q => `${q.campaignId}_${q.contactId}`));
      const toAdd = [];
      for (const e of entries) {
        const key = `${e.campaignId}_${e.contactId}`;
        if (!existingPairs.has(key)) {
          existingPairs.add(key);
          toAdd.push(e);
        }
      }
      draft.dispatchQueue = [...draft.dispatchQueue, ...toAdd];
    });
  },

  prepareDrafts: async (queueUpdates, newDrafts) => {
    let preparedIds: ID[] = [];
    updateState(draft => {
      const actuallyPrepared = new Set<ID>();
      draft.dispatchQueue = draft.dispatchQueue.map(q => {
        const update = queueUpdates.find(u => u.id === q.id);
        if (update && q.status === 'QUEUED') {
          actuallyPrepared.add(q.id);
          return { ...q, ...update };
        }
        return q;
      });
      const draftsToAdd = [];
      const seenQueueEntryIds = new Set<ID>();
      for (const d of newDrafts) {
        if (actuallyPrepared.has(d.queueEntryId) && !seenQueueEntryIds.has(d.queueEntryId)) {
          seenQueueEntryIds.add(d.queueEntryId);
          draftsToAdd.push(d);
        }
      }
      draft.pendingMessages = [...draft.pendingMessages, ...draftsToAdd];
      preparedIds = Array.from(actuallyPrepared);
    });
    return preparedIds;
  },

  sendPreparedMessage: async (message, draftId, queueEntryId, sentAt) => {
    let success = false;
    updateState(draft => {
      const pendingDraft = draft.pendingMessages.find(pm => pm.id === draftId);
      const qEntry = draft.dispatchQueue.find(q => q.id === queueEntryId);
      
      if (!pendingDraft || !qEntry) return;

      const conv = draft.conversations.find(c => c.id === message.conversationId);
      if (!conv) return;

      if (
        pendingDraft.queueEntryId === qEntry.id &&
        pendingDraft.campaignId === qEntry.campaignId &&
        pendingDraft.contactId === qEntry.contactId &&
        pendingDraft.conversationId === message.conversationId &&
        conv.contactId === pendingDraft.contactId &&
        qEntry.status === 'DRAFT_PREPARED'
      ) {
        draft.messages = [...draft.messages, message];
        draft.pendingMessages = draft.pendingMessages.filter(pm => pm.id !== draftId);
        draft.dispatchQueue = draft.dispatchQueue.map(q => 
          q.id === queueEntryId ? { ...q, status: 'SENT', sentAt } : q
        );
        success = true;
      }
    });
    return success;
  },

  processClientResponse: async (message, conversationId, updatedAt, queueEntryToReply, repliedAt) => {
    updateState(draft => {
      draft.messages = [...draft.messages, message];
      draft.conversations = draft.conversations.map(c => 
        c.id === conversationId ? { ...c, unreadCount: c.unreadCount + 1, updatedAt } : c
      );
      if (queueEntryToReply) {
        draft.dispatchQueue = draft.dispatchQueue.map(q => 
          (q.id === queueEntryToReply.id && q.status === 'SENT') ? { ...q, status: 'REPLIED', repliedAt } : q
        );
      }
    });
  },

  createOrderWithItems: async (order, orderItems, systemMessage) => {
    updateState(draft => {
      draft.orders = [...draft.orders, order];
      draft.orderItems = [...draft.orderItems, ...orderItems];
      if (systemMessage) {
        draft.messages = [...draft.messages, systemMessage];
      }
    });
  },

  updateCampaignDailyLimit: async (campaignId, limit, updatedAt) => {
    updateState(draft => {
      draft.campaigns = draft.campaigns.map(c => 
        c.id === campaignId ? { ...c, dailyLimit: limit, updatedAt } : c
      );
    });
  },

  transitionOpportunityStage: async (contactId, tenantId, newStage, timestamp) => {
    let result: any;
    updateState(draft => {
      const existing = draft.opportunities.find(o => o.contactId === contactId);
      if (existing) {
        const changed = existing.stage !== newStage;
        const previousStage = existing.stage;
        if (changed) {
          existing.stage = newStage;
          existing.updatedAt = timestamp;
        }
        result = { opportunity: { ...existing }, created: false, changed, previousStage, currentStage: existing.stage };
      } else {
        const oppId = createId('opp');
        const opp = {
          id: oppId,
          tenantId,
          contactId,
          stage: newStage,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        draft.opportunities = [...draft.opportunities, opp];
        result = { opportunity: { ...opp }, created: true, changed: true, currentStage: opp.stage };
      }
    });
    return result;
  },

  addTimelineEvent: async (event) => {
    updateState(draft => {
      draft.timeline = [...draft.timeline, event];
    });
  },

  reset: async () => {
    updateState(draft => {
      Object.assign(draft, createInitialState());
    });
  }
};
