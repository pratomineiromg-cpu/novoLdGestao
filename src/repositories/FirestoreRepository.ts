import { 
  doc, 
  runTransaction, 
  writeBatch,
  serverTimestamp
} from 'firebase/firestore';
import { db } from '../firebase/firebase';
import { AppRepository, DatabaseState, OpportunityTransitionResult } from './IRepository';
import { ID, Order, OrderItem, Message, TimelineEvent, DispatchQueueEntry, PendingOutboundMessage, FunnelStage, DispatchQueueIdentity } from '../domain/types';
import { createEmptyDatabaseState } from './firestore/emptyState';
import { COLLECTIONS, dispatchQueueDocumentId } from './firestore/schema';
import { cleanForFirestore, fromFirestore } from './firestore/serializers';
import { createId } from '../utils/id';

export class FirestoreRepository implements AppRepository {
  private cache: DatabaseState;
  
  constructor() {
    this.cache = createEmptyDatabaseState();
  }

  // Realtime hydration/listeners deferred until the controlled activation phase.
  getState(): DatabaseState {
    return this.cache;
  }

  subscribe(listener: () => void): () => void {
    return () => {};
  }

  async transitionOpportunityStage(contactId: ID, tenantId: ID, newStage: FunnelStage, timestamp: Date): Promise<OpportunityTransitionResult> {
    const oppRef = doc(db, COLLECTIONS.OPPORTUNITIES, contactId);

    return await runTransaction(db, async (transaction) => {
      const oppDoc = await transaction.get(oppRef);

      if (oppDoc.exists()) {
        const existing = fromFirestore(oppDoc.data());
        const previousStage = existing.stage;
        const changed = previousStage !== newStage;
        
        if (changed) {
          const updated = {
            ...existing,
            stage: newStage,
            updatedAt: timestamp
          };
          transaction.set(oppRef, cleanForFirestore({
              ...updated,
              updatedAt: serverTimestamp() // Preferred over client timestamp for writes
          }));
          
          return {
            opportunity: updated,
            created: false,
            changed: true,
            previousStage,
            currentStage: newStage
          };
        }
        
        return {
          opportunity: existing,
          created: false,
          changed: false,
          previousStage,
          currentStage: existing.stage
        };
      } else {
        const oppId = createId('opp');
        const newOpp = {
          id: oppId,
          tenantId,
          contactId,
          stage: newStage,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        
        transaction.set(oppRef, cleanForFirestore({
            ...newOpp,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        }));
        
        return {
          opportunity: newOpp,
          created: true,
          changed: true,
          currentStage: newStage
        };
      }
    });
  }

  async addDispatchQueueEntries(entries: DispatchQueueEntry[]): Promise<void> {
    if (!entries.length) return;
    
    // Using batch for multiple adds, assuming they are new.
    // If we need existence check per entry to guarantee logic, we could use transactions.
    // Given batches don't support read-then-write on multiple docs easily without limits,
    // we will just set with merge: false (or no merge) to overwrite if they exist, or check first.
    // Let's do a runTransaction if needed, or just batch if we assume client filtered it.
    // The requirement says "Mesmo duas tentativas concorrentes não podem resultar em duas entradas lógicas... Pode utilizar transaction quando necessário para checar existência. Não sobrescrever entrada existente silenciosamente."

    // To handle multiple safely without exceeding transaction limits, we process sequentially or in smaller chunks.
    // For simplicity in this non-active phase:
    
    for (const entry of entries) {
       const docId = dispatchQueueDocumentId(entry.campaignId, entry.contactId);
       const entryRef = doc(db, COLLECTIONS.DISPATCH_QUEUE, docId);
       const campaignRef = doc(db, COLLECTIONS.DISPATCH_CAMPAIGNS, entry.campaignId);
       
       await runTransaction(db, async (transaction) => {
           const campaignDoc = await transaction.get(campaignRef);
           const existing = await transaction.get(entryRef);
           
           if (!campaignDoc.exists()) {
               throw new Error("Campaign does not exist.");
           }
           
           if (existing.exists()) {
               return;
           }
           
           const campaignData = fromFirestore(campaignDoc.data());
           const allocatedPosition = campaignData.nextQueuePosition || Math.max(1, entry.position);
           
           transaction.set(entryRef, cleanForFirestore({
               ...entry,
               position: allocatedPosition,
               createdAt: serverTimestamp(),
               updatedAt: serverTimestamp()
           }));
           
           transaction.update(campaignRef, {
               nextQueuePosition: allocatedPosition + 1,
               updatedAt: serverTimestamp()
           });
       });
    }
  }

  async prepareDrafts(updates: { id: ID; status: 'DRAFT_PREPARED'; preparedAt: Date }[], drafts: PendingOutboundMessage[]): Promise<ID[]> {
    const preparedIds: ID[] = [];
    
    // Atomic per entry
    for (const update of updates) {
      const draft = drafts.find(d => d.queueEntryId === update.id);
      if (!draft) continue;
      
      const queueDocumentId = dispatchQueueDocumentId(draft.campaignId, draft.contactId);
      const queueRef = doc(db, COLLECTIONS.DISPATCH_QUEUE, queueDocumentId);
      const pendingRef = doc(db, COLLECTIONS.PENDING_OUTBOUND_MESSAGES, update.id); // key is queueEntryId
      
      const prepared = await runTransaction(db, async (transaction) => {
         const queueDoc = await transaction.get(queueRef);
         if (!queueDoc.exists()) return false;
         
         const queueData = fromFirestore(queueDoc.data());
         if (queueData.id !== update.id) return false;
         if (queueData.campaignId !== draft.campaignId) return false;
         if (queueData.contactId !== draft.contactId) return false;
         if (queueData.status !== 'QUEUED') return false;
         
         const pendingDoc = await transaction.get(pendingRef);
         if (pendingDoc.exists()) return false;
         
         transaction.set(pendingRef, cleanForFirestore({
             ...draft,
             createdAt: serverTimestamp()
         }));
         
         transaction.update(queueRef, {
             status: 'DRAFT_PREPARED',
             preparedAt: serverTimestamp(),
             updatedAt: serverTimestamp()
         });
         
         return true;
      });
      
      if (prepared) {
         preparedIds.push(update.id);
      }
    }
    
    return preparedIds;
  }

  async sendPreparedMessage(message: Message, draftId: ID, queueEntryId: ID, sentAt: Date): Promise<boolean> {
      const pendingRef = doc(db, COLLECTIONS.PENDING_OUTBOUND_MESSAGES, queueEntryId);
      const convRef = doc(db, COLLECTIONS.CONVERSATIONS, message.conversationId);
      const msgRef = doc(db, COLLECTIONS.MESSAGES, message.id);
      
      return await runTransaction(db, async (transaction) => {
          const pendingDoc = await transaction.get(pendingRef);
          if (!pendingDoc.exists()) return false;
          
          const draftData = fromFirestore(pendingDoc.data());
          if (draftData.id !== draftId) return false;
          if (draftData.queueEntryId !== queueEntryId) return false;
          if (draftData.conversationId !== message.conversationId) return false;
          
          const queueDocumentId = dispatchQueueDocumentId(draftData.campaignId, draftData.contactId);
          const queueRef = doc(db, COLLECTIONS.DISPATCH_QUEUE, queueDocumentId);
          
          const queueDoc = await transaction.get(queueRef);
          if (!queueDoc.exists()) return false;
          
          const convDoc = await transaction.get(convRef);
          if (!convDoc.exists()) return false;
          
          const queueData = fromFirestore(queueDoc.data());
          const convData = fromFirestore(convDoc.data());
          
          if (queueData.id !== queueEntryId) return false;
          if (queueData.campaignId !== draftData.campaignId) return false;
          if (queueData.contactId !== draftData.contactId) return false;
          if (convData.contactId !== draftData.contactId) return false;
          if (queueData.status !== 'DRAFT_PREPARED') return false;
          
          transaction.set(msgRef, cleanForFirestore({
              ...message,
              createdAt: serverTimestamp()
          }));
          
          transaction.delete(pendingRef);
          
          transaction.update(queueRef, {
              status: 'SENT',
              sentAt: serverTimestamp(),
              updatedAt: serverTimestamp()
          });
          
          return true;
      });
  }

  async processClientResponse(message: Message, conversationId: ID, receivedAt: Date, queueEntryToReply?: DispatchQueueIdentity, repliedAt?: Date): Promise<void> {
      const msgRef = doc(db, COLLECTIONS.MESSAGES, message.id);
      const convRef = doc(db, COLLECTIONS.CONVERSATIONS, conversationId);
      
      let queueRef: any = null;
      if (queueEntryToReply) {
          const queueDocumentId = dispatchQueueDocumentId(queueEntryToReply.campaignId, queueEntryToReply.contactId);
          queueRef = doc(db, COLLECTIONS.DISPATCH_QUEUE, queueDocumentId);
      }
      
      await runTransaction(db, async (transaction) => {
          // READ PHASE
          const convDoc = await transaction.get(convRef);
          
          let queueDoc: any = null;
          if (queueRef) {
              queueDoc = await transaction.get(queueRef);
          }
          
          // VALIDATION PHASE
          if (!convDoc.exists()) {
              throw new Error("Conversation does not exist.");
          }
          
          const convData = fromFirestore(convDoc.data());
          
          let shouldUpdateQueue = false;
          if (queueDoc && queueDoc.exists()) {
              const qData = fromFirestore(queueDoc.data());
              if (
                  qData.id === queueEntryToReply?.id &&
                  qData.campaignId === queueEntryToReply?.campaignId &&
                  qData.contactId === queueEntryToReply?.contactId &&
                  qData.contactId === convData.contactId &&
                  qData.status === 'SENT'
              ) {
                  shouldUpdateQueue = true;
              }
          }
          
          // WRITE PHASE
          transaction.set(msgRef, cleanForFirestore({
              ...message,
              createdAt: serverTimestamp()
          }));
          
          transaction.update(convRef, {
              unreadCount: (convData.unreadCount || 0) + 1,
              updatedAt: serverTimestamp()
          });
          
          if (shouldUpdateQueue && queueRef) {
              transaction.update(queueRef, {
                  status: 'REPLIED',
                  repliedAt: serverTimestamp(),
                  updatedAt: serverTimestamp()
              });
          }
      });
  }

  async createOrderWithItems(order: Order, items: OrderItem[], systemMessage?: Message): Promise<void> {
      const batch = writeBatch(db);
      
      const orderRef = doc(db, COLLECTIONS.ORDERS, order.id);
      batch.set(orderRef, cleanForFirestore({
          ...order,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
      }));
      
      for (const item of items) {
          const itemRef = doc(db, COLLECTIONS.ORDER_ITEMS, item.id);
          batch.set(itemRef, cleanForFirestore({
              ...item,
              createdAt: serverTimestamp()
          }));
      }
      
      if (systemMessage) {
          const msgRef = doc(db, COLLECTIONS.MESSAGES, systemMessage.id);
          batch.set(msgRef, cleanForFirestore({
              ...systemMessage,
              createdAt: serverTimestamp()
          }));
      }
      
      await batch.commit();
  }

  async updateCampaignDailyLimit(campaignId: ID, dailyLimit: number): Promise<void> {
      if (dailyLimit < 1) return;
      
      const campaignRef = doc(db, COLLECTIONS.DISPATCH_CAMPAIGNS, campaignId);
      // Partial update
      const batch = writeBatch(db);
      batch.update(campaignRef, {
          dailyLimit,
          updatedAt: serverTimestamp()
      });
      await batch.commit();
  }

  async addTimelineEvent(event: TimelineEvent): Promise<void> {
      const eventRef = doc(db, COLLECTIONS.TIMELINE_EVENTS, event.id);
      const batch = writeBatch(db);
      batch.set(eventRef, cleanForFirestore({
          ...event,
          createdAt: serverTimestamp()
      }));
      await batch.commit();
  }

  async reset(): Promise<void> {
      throw new Error("Reset is not supported for FirestoreRepository.");
  }
}
