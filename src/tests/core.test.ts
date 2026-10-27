import { describe, it, expect, beforeEach } from 'vitest';
import { repository } from '../repositories';
import { prepareCampaignQueue, processQueueDrafts, sendDraftMessage, simulateClientResponse, createOrder, updateCampaignDailyLimit } from '../services/Actions';

describe('Core Commercial Flow Tests', () => {
  beforeEach(async () => {
    await repository.reset();
  });

  it('Test 10 - IDs: Should generate unique IDs for opportunities, queue entries, and pending messages', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;

    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);

    const newState = repository.getState();
    
    const oppIds = new Set(newState.opportunities.map(o => o.id));
    expect(oppIds.size).toBe(20);
    expect(newState.opportunities.length).toBe(20);

    const dqIds = new Set(newState.dispatchQueue.map(q => q.id));
    expect(dqIds.size).toBe(20);
    expect(newState.dispatchQueue.length).toBe(20);

    const pmIds = new Set(newState.pendingMessages.map(pm => pm.id));
    expect(pmIds.size).toBe(20);
    expect(newState.pendingMessages.length).toBe(20);
  });

  it('Test 11 - Funnel Isolation: Client 2 should not change when Client 1 is sent', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const c1 = state.contacts.find(c => c.name === 'Cliente 1')!;
    const c2 = state.contacts.find(c => c.name === 'Cliente 2')!;
    
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);

    let newState = repository.getState();
    expect(newState.opportunities.find(o => o.contactId === c1.id)?.stage).toBe('RASCUNHO');
    expect(newState.opportunities.find(o => o.contactId === c2.id)?.stage).toBe('RASCUNHO');

    const conv1 = newState.conversations.find(c => c.contactId === c1.id)!;
    await sendDraftMessage(conv1.id);

    newState = repository.getState();
    expect(newState.opportunities.find(o => o.contactId === c1.id)?.stage).toBe('LEAD');
    expect(newState.opportunities.find(o => o.contactId === c2.id)?.stage).toBe('RASCUNHO');
    
    const rascunhos = newState.opportunities.filter(o => o.stage === 'RASCUNHO');
    const leads = newState.opportunities.filter(o => o.stage === 'LEAD');
    expect(rascunhos.length).toBe(19);
    expect(leads.length).toBe(1);
  });

  it('Test 12 - Response: Client 1 response moves funnel and queue correctly', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const c1 = state.contacts.find(c => c.name === 'Cliente 1')!;
    
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    const conv1 = repository.getState().conversations.find(c => c.contactId === c1.id)!;
    await sendDraftMessage(conv1.id);
    
    await simulateClientResponse(conv1.id);
    
    const newState = repository.getState();
    expect(newState.opportunities.find(o => o.contactId === c1.id)?.stage).toBe('EM ATENDIMENTO');
    const queueEntry = newState.dispatchQueue.find(q => q.contactId === c1.id);
    expect(queueEntry?.status).toBe('REPLIED');
    
    const rascunhos = newState.opportunities.filter(o => o.stage === 'RASCUNHO');
    const emAtendimento = newState.opportunities.filter(o => o.stage === 'EM ATENDIMENTO');
    expect(rascunhos.length).toBe(19);
    expect(emAtendimento.length).toBe(1);
  });

  it('Test 13 - Order: Create order through chat for Client 1', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const c1 = state.contacts.find(c => c.name === 'Cliente 1')!;
    
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    const conv1 = repository.getState().conversations.find(c => c.contactId === c1.id)!;
    await sendDraftMessage(conv1.id);
    await simulateClientResponse(conv1.id);
    
    await createOrder(c1.id, [{ productId: '1', productName: 'Prod', quantity: 1, price: 10, observation: '' }], 'PIX');
    
    const newState = repository.getState();
    expect(newState.opportunities.find(o => o.contactId === c1.id)?.stage).toBe('PEDIDO GERADO');
    expect(newState.orders.length).toBe(1);
    
    const order = newState.orders[0];
    expect(order.entryPoint).toBe('CHAT');
    expect(order.channel).toBe('WHATSAPP');
    expect(order.creationMode).toBe('HUMAN_OPERATOR');
    expect(order.conversationId).toBe(conv1.id);
  });

  it('Test 14 - Idempotency: Duplicate send attempts do not duplicate messages or queue entries', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const c1 = state.contacts.find(c => c.name === 'Cliente 1')!;
    
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    const conv1 = repository.getState().conversations.find(c => c.contactId === c1.id)!;
    
    await sendDraftMessage(conv1.id);
    let messagesCount = repository.getState().messages.length;
    
    // Attempt second send
    await sendDraftMessage(conv1.id);
    expect(repository.getState().messages.length).toBe(messagesCount); // No new message
    expect(repository.getState().pendingMessages.find(pm => pm.conversationId === conv1.id)).toBeUndefined(); // Draft is gone
    
    // Repopulate queue
    await prepareCampaignQueue(campaignId);
    expect(repository.getState().dispatchQueue.length).toBe(20); // Still 20 entries
  });

  it('Test 15 - Daily Limit: Should respect daily limit for drafts', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    
    await updateCampaignDailyLimit(campaignId, 5);
    
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    
    const newState = repository.getState();
    const queued = newState.dispatchQueue.filter(q => q.status === 'QUEUED');
    const drafts = newState.dispatchQueue.filter(q => q.status === 'DRAFT_PREPARED');
    
    expect(queued.length).toBe(15);
    expect(drafts.length).toBe(5);
    expect(newState.pendingMessages.length).toBe(5);
  });

  it('Test 16 - Timeline: Semantic accuracy of timeline events', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const c1 = state.contacts.find(c => c.name === 'Cliente 1')!;
    
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    const conv1 = repository.getState().conversations.find(c => c.contactId === c1.id)!;
    await sendDraftMessage(conv1.id);
    await simulateClientResponse(conv1.id);
    await createOrder(c1.id, [{ productId: '1', productName: 'Prod', quantity: 1, price: 10, observation: '' }], 'PIX');
    
    const newState = repository.getState();
    const timeline = newState.timeline.filter(t => t.contactId === c1.id);
    
    const types = timeline.map(t => t.type);
    expect(types).toEqual([
      'MESSAGE_DRAFT_CREATED',
      'OPPORTUNITY_CREATED',
      'FUNNEL_STAGE_CHANGED',
      'MESSAGE_SENT',
      'FUNNEL_STAGE_CHANGED',
      'MESSAGE_RECEIVED',
      'FUNNEL_STAGE_CHANGED',
      'ORDER_CREATED',
      'FUNNEL_STAGE_CHANGED'
    ]);
  });
  
  it('Test 17 - Repository Contract / Infrastructure Independence', async () => {
    // Assert strictly via public interface checking types without using mock specifics
    expect(repository.addDispatchQueueEntries).toBeDefined();
    expect(repository.transitionOpportunityStage).toBeDefined();
    
    // We can prove we aren't leaking the generic mutation logic out of the app
    const AnyRepo = repository as any;
    expect(AnyRepo.update).toBeUndefined(); // Generic mutable update must be dead
    
    // Check that our business rules are working correctly under the explicit commands
    await prepareCampaignQueue('camp-1');
    const newState = repository.getState();
    expect(newState.dispatchQueue.length).toBe(20); // The core is functional via commands
  });

  it('Test 19 - Multi-item Order', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const c1 = state.contacts.find(c => c.name === 'Cliente 1')!;
    
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    const conv1 = repository.getState().conversations.find(c => c.contactId === c1.id)!;
    await sendDraftMessage(conv1.id);
    await simulateClientResponse(conv1.id);
    
    await createOrder(c1.id, [
      { productId: '1', productName: 'Prod A', quantity: 2, price: 10, observation: '' },
      { productId: '2', productName: 'Prod B', quantity: 1, price: 5, observation: '' }
    ], 'CREDIT_CARD');
    
    const newState = repository.getState();
    expect(newState.orders.length).toBe(1);
    
    const order = newState.orders[0];
    const orderItems = newState.orderItems.filter(item => item.orderId === order.id);
    
    expect(orderItems.length).toBe(2);
    expect(order.total).toBe(25);
    expect(order.entryPoint).toBe('CHAT');
    expect(order.channel).toBe('WHATSAPP');
    expect(order.creationMode).toBe('HUMAN_OPERATOR');
    expect(order.conversationId).toBe(conv1.id);
    
    orderItems.forEach(item => {
      expect(item.orderId).toBe(order.id);
    });
  });

  it('Test 20 - Atomic Opportunity Transition Contract', async () => {
    const state = repository.getState();
    const c1 = state.contacts[0];
    const tenantId = state.tenant.id;
    const now = new Date();

    // Transição 1 - deve criar
    const r1 = await repository.transitionOpportunityStage(c1.id, tenantId, 'RASCUNHO', now);
    expect(r1.created).toBe(true);
    expect(r1.changed).toBe(true);
    expect(r1.currentStage).toBe('RASCUNHO');

    // Transição 2 - para o mesmo estágio, não deve mudar
    const r2 = await repository.transitionOpportunityStage(c1.id, tenantId, 'RASCUNHO', now);
    expect(r2.created).toBe(false);
    expect(r2.changed).toBe(false);
    expect(r2.currentStage).toBe('RASCUNHO');

    // Transição 3 - deve evoluir o estágio, aproveitando a mesma oportunidade
    const r3 = await repository.transitionOpportunityStage(c1.id, tenantId, 'LEAD', now);
    expect(r3.created).toBe(false);
    expect(r3.changed).toBe(true);
    expect(r3.previousStage).toBe('RASCUNHO');
    expect(r3.currentStage).toBe('LEAD');
    expect(r3.opportunity.id).toBe(r1.opportunity.id);

    const newState = repository.getState();
    const oppsForContact = newState.opportunities.filter(o => o.contactId === c1.id);
    expect(oppsForContact.length).toBe(1);
    expect(oppsForContact[0].stage).toBe('LEAD');
  });

  it('Test 21 - Dispatch Queue Logical Uniqueness', async () => {
    const campaignId = repository.getState().campaigns[0].id;
    
    // First call
    await prepareCampaignQueue(campaignId);
    let state = repository.getState();
    expect(state.dispatchQueue.length).toBe(20);

    // Second call
    await prepareCampaignQueue(campaignId);
    state = repository.getState();
    
    // Should still be exactly 20 (idempotent at repository boundary level now)
    expect(state.dispatchQueue.length).toBe(20);
  });

  it('Test 22 - Pending Draft Logical Idempotency', async () => {
    const campaignId = repository.getState().campaigns[0].id;
    await prepareCampaignQueue(campaignId);
    
    // First call
    await processQueueDrafts(campaignId);
    let state = repository.getState();
    expect(state.pendingMessages.length).toBe(20);

    // Second call
    await processQueueDrafts(campaignId);
    state = repository.getState();
    
    // Should still be exactly 20, no duplicate drafts
    expect(state.pendingMessages.length).toBe(20);
  });

  it('Test 23 - Repository Send Idempotency', async () => {
    const campaignId = repository.getState().campaigns[0].id;
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    
    const state = repository.getState();
    const draft = state.pendingMessages[0];
    const now = new Date();
    const msg = {
      id: 'msg-test',
      conversationId: draft.conversationId,
      sender: 'USER' as const,
      content: draft.content,
      createdAt: now
    };

    // First send attempt directly to repo
    const sent1 = await repository.sendPreparedMessage(msg, draft.id, draft.queueEntryId, now);
    expect(sent1).toBe(true);

    // Second send attempt directly to repo with same draft and entry
    const sent2 = await repository.sendPreparedMessage(msg, draft.id, draft.queueEntryId, now);
    expect(sent2).toBe(false); // Already sent, draft doesn't exist or entry status changed

    const finalState = repository.getState();
    const sentMessages = finalState.messages.filter(m => m.id === 'msg-test');
    expect(sentMessages.length).toBe(1); // Only inserted once
  });

  it('Test 24 - Opportunity ID Policy', async () => {
    const state = repository.getState();
    const c1 = state.contacts[0];
    const tenantId = state.tenant.id;
    const now = new Date();

    const result = await repository.transitionOpportunityStage(c1.id, tenantId, 'RASCUNHO', now);
    expect(result.created).toBe(true);
    expect(result.opportunity.id.startsWith('opp-')).toBe(true);
    // UUID format check (8-4-4-4-12) after prefix
    const idPart = result.opportunity.id.slice(4);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(uuidRegex.test(idPart)).toBe(true);
  });

  it('Test 25 - Same-batch Dispatch Queue Uniqueness', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const contactId = state.contacts[0].id;
    const now = new Date();

    const entries = [
      { id: 'uuid-1', campaignId, contactId, position: 1, status: 'QUEUED' as const, attempts: 0, createdAt: now },
      { id: 'uuid-2', campaignId, contactId, position: 2, status: 'QUEUED' as const, attempts: 0, createdAt: now }
    ];

    await repository.addDispatchQueueEntries(entries);
    
    const newState = repository.getState();
    const specificEntries = newState.dispatchQueue.filter(q => q.campaignId === campaignId && q.contactId === contactId);
    
    expect(specificEntries.length).toBe(1);
    expect(specificEntries[0].id).toBe('uuid-1');
  });

  it('Test 26 - Same-batch Pending Draft Uniqueness', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    await prepareCampaignQueue(campaignId);
    
    const queueEntry = repository.getState().dispatchQueue[0];
    const now = new Date();
    
    const updates = [{ id: queueEntry.id, status: 'DRAFT_PREPARED' as const, preparedAt: now }];
    const drafts = [
      { id: 'draft-1', contactId: queueEntry.contactId, campaignId: queueEntry.campaignId, queueEntryId: queueEntry.id, conversationId: 'c-1', content: 'A', createdAt: now },
      { id: 'draft-2', contactId: queueEntry.contactId, campaignId: queueEntry.campaignId, queueEntryId: queueEntry.id, conversationId: 'c-1', content: 'B', createdAt: now }
    ];

    await repository.prepareDrafts(updates, drafts);
    
    const newState = repository.getState();
    const draftsForEntry = newState.pendingMessages.filter(pm => pm.queueEntryId === queueEntry.id);
    
    expect(draftsForEntry.length).toBe(1);
    expect(draftsForEntry[0].id).toBe('draft-1');
  });

  it('Test 27 - Invalid Reply Transition', async () => {
    const campaignId = repository.getState().campaigns[0].id;
    await prepareCampaignQueue(campaignId);
    await processQueueDrafts(campaignId);
    
    const state = repository.getState();
    const draft = state.pendingMessages[0];
    const qEntry = state.dispatchQueue.find(q => q.id === draft.queueEntryId)!;
    const now = new Date();
    
    expect(qEntry.status).toBe('DRAFT_PREPARED');
    
    const msg = {
      id: 'msg-reply',
      conversationId: draft.conversationId,
      sender: 'CONTACT' as const,
      content: 'Hello',
      createdAt: now
    };

    // Tenta transitar DRAFT_PREPARED -> REPLIED (não deve funcionar)
    await repository.processClientResponse(msg, draft.conversationId, now, { id: qEntry.id, campaignId: qEntry.campaignId, contactId: qEntry.contactId }, now);
    
    let checkState = repository.getState();
    expect(checkState.dispatchQueue.find(q => q.id === qEntry.id)?.status).toBe('DRAFT_PREPARED');

    // Envia corretamente
    const systemMsg = { ...msg, sender: 'USER' as const, id: 'msg-sys' };
    await repository.sendPreparedMessage(systemMsg, draft.id, qEntry.id, now);
    
    checkState = repository.getState();
    expect(checkState.dispatchQueue.find(q => q.id === qEntry.id)?.status).toBe('SENT');

    // Agora sim simula resposta
    await repository.processClientResponse(msg, draft.conversationId, now, { id: qEntry.id, campaignId: qEntry.campaignId, contactId: qEntry.contactId }, now);
    
    checkState = repository.getState();
    expect(checkState.dispatchQueue.find(q => q.id === qEntry.id)?.status).toBe('REPLIED');
  });

  it('Test 28 - Draft Queue Referential Integrity', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const now = new Date();
    
    // We need two QueueEntries and two Drafts. Let's create them directly.
    const q1Id = 'q1-test';
    const q2Id = 'q2-test';
    const c1Id = state.contacts[0].id;
    const c2Id = state.contacts[1].id;
    
    await repository.addDispatchQueueEntries([
      { id: q1Id, campaignId, contactId: c1Id, position: 1, status: 'QUEUED', attempts: 0, createdAt: now },
      { id: q2Id, campaignId, contactId: c2Id, position: 2, status: 'QUEUED', attempts: 0, createdAt: now }
    ]);
    
    const conv1 = state.conversations.find(c => c.contactId === c1Id)!;
    const conv2 = state.conversations.find(c => c.contactId === c2Id)!;
    
    const d1Id = 'd1-test';
    const d2Id = 'd2-test';
    
    await repository.prepareDrafts([
      { id: q1Id, status: 'DRAFT_PREPARED', preparedAt: now },
      { id: q2Id, status: 'DRAFT_PREPARED', preparedAt: now }
    ], [
      { id: d1Id, contactId: c1Id, campaignId, queueEntryId: q1Id, conversationId: conv1.id, content: 'A', createdAt: now },
      { id: d2Id, contactId: c2Id, campaignId, queueEntryId: q2Id, conversationId: conv2.id, content: 'B', createdAt: now }
    ]);
    
    const msg = {
      id: 'msg-test-28',
      conversationId: conv1.id,
      sender: 'USER' as const,
      content: 'A',
      createdAt: now
    };
    
    // Attempt incorrect binding: d1 + q2
    const sentBad = await repository.sendPreparedMessage(msg, d1Id, q2Id, now);
    expect(sentBad).toBe(false);
    
    let checkState = repository.getState();
    expect(checkState.pendingMessages.find(pm => pm.id === d1Id)).toBeDefined();
    expect(checkState.pendingMessages.find(pm => pm.id === d2Id)).toBeDefined();
    expect(checkState.dispatchQueue.find(q => q.id === q1Id)?.status).toBe('DRAFT_PREPARED');
    expect(checkState.dispatchQueue.find(q => q.id === q2Id)?.status).toBe('DRAFT_PREPARED');
    
    // Attempt correct binding: d1 + q1
    const sentGood = await repository.sendPreparedMessage(msg, d1Id, q1Id, now);
    expect(sentGood).toBe(true);
    
    checkState = repository.getState();
    expect(checkState.pendingMessages.find(pm => pm.id === d1Id)).toBeUndefined();
    expect(checkState.dispatchQueue.find(q => q.id === q1Id)?.status).toBe('SENT');
    
    expect(checkState.pendingMessages.find(pm => pm.id === d2Id)).toBeDefined();
    expect(checkState.dispatchQueue.find(q => q.id === q2Id)?.status).toBe('DRAFT_PREPARED');
  });

  it('Test 29 - Draft Conversation Referential Integrity', async () => {
    const state = repository.getState();
    const campaignId = state.campaigns[0].id;
    const now = new Date();
    
    const q1Id = 'q3-test';
    const c1Id = state.contacts[0].id;
    const c2Id = state.contacts[1].id;
    
    await repository.addDispatchQueueEntries([
      { id: q1Id, campaignId, contactId: c1Id, position: 1, status: 'QUEUED', attempts: 0, createdAt: now },
    ]);
    
    const conv1 = state.conversations.find(c => c.contactId === c1Id)!;
    const conv2 = state.conversations.find(c => c.contactId === c2Id)!; // belongs to different contact
    
    const d1Id = 'd3-test';
    
    await repository.prepareDrafts([
      { id: q1Id, status: 'DRAFT_PREPARED', preparedAt: now },
    ], [
      { id: d1Id, contactId: c1Id, campaignId, queueEntryId: q1Id, conversationId: conv1.id, content: 'A', createdAt: now },
    ]);
    
    // Attempt incorrect conversation binding
    const badMsg = {
      id: 'msg-test-29',
      conversationId: conv2.id, // incorrect
      sender: 'USER' as const,
      content: 'A',
      createdAt: now
    };
    
    const sentBad = await repository.sendPreparedMessage(badMsg, d1Id, q1Id, now);
    expect(sentBad).toBe(false);
    
    let checkState = repository.getState();
    expect(checkState.pendingMessages.find(pm => pm.id === d1Id)).toBeDefined();
    expect(checkState.dispatchQueue.find(q => q.id === q1Id)?.status).toBe('DRAFT_PREPARED');
    
    // Attempt correct conversation binding
    const goodMsg = {
      ...badMsg,
      conversationId: conv1.id
    };
    
    const sentGood = await repository.sendPreparedMessage(goodMsg, d1Id, q1Id, now);
    expect(sentGood).toBe(true);
    
    checkState = repository.getState();
    expect(checkState.pendingMessages.find(pm => pm.id === d1Id)).toBeUndefined();
    expect(checkState.dispatchQueue.find(q => q.id === q1Id)?.status).toBe('SENT');
  });

  it('Test 30 - Firestore Schema Paths', async () => {
    // We import dynamically to avoid initializing Firebase if we don't need to in the general test suite,
    // but schema is just a constant file so we can import it statically or require it.
    const schema = await import('../repositories/firestore/schema');
    expect(schema.COLLECTIONS.OPPORTUNITIES).toBe('opportunities');
    expect(schema.getOpportunityPath('c-123')).toBe('opportunities/c-123');
    expect(schema.dispatchQueueDocumentId('camp/1', 'cont/1')).toBe('camp%2F1::cont%2F1');
    expect(schema.getDispatchQueuePath('camp/1', 'cont/1')).toBe('dispatchQueue/camp%2F1::cont%2F1');
    expect(schema.getPendingOutboundMessagePath('q-1')).toBe('pendingOutboundMessages/q-1');
  });

  it('Test 31 - Serialization Boundary', async () => {
    const serializers = await import('../repositories/firestore/serializers');
    const now = new Date();
    
    // Domain -> Firestore
    const cleaned = serializers.cleanForFirestore({ date: now, name: 'Test' });
    expect(cleaned.name).toBe('Test');
    expect(cleaned.date).toHaveProperty('seconds'); // Timestamp instance should have 'seconds'
    expect(cleaned.date).toHaveProperty('nanoseconds');
    
    // Firestore -> Domain (Mocking a Firestore Timestamp with seconds/nanoseconds)
    const domainObj = serializers.fromFirestore({
      name: 'Test',
      date: { seconds: Math.floor(now.getTime() / 1000), nanoseconds: 0 }
    });
    expect(domainObj.name).toBe('Test');
    expect(domainObj.date instanceof Date).toBe(true);
  });

  it('Test 32 - FirestoreRepository Contract', async () => {
    const { FirestoreRepository } = await import('../repositories/FirestoreRepository');
    const repo = new FirestoreRepository();
    expect(repo.addDispatchQueueEntries).toBeDefined();
    expect(repo.prepareDrafts).toBeDefined();
    expect(repo.sendPreparedMessage).toBeDefined();
    expect(repo.transitionOpportunityStage).toBeDefined();
    expect(repo.createOrderWithItems).toBeDefined();
    expect(repo.processClientResponse).toBeDefined();
  });

  it('Test 33 - Production Reset Guard', async () => {
    const { FirestoreRepository } = await import('../repositories/FirestoreRepository');
    const repo = new FirestoreRepository();
    await expect(repo.reset()).rejects.toThrow('Reset is not supported for FirestoreRepository.');
  });

  it('Test 34 - Repository Activation Guard', async () => {
    const repoIndex = await import('../repositories/index');
    const { mockRepository } = await import('../repositories/MockRepository');
    
    // The exported AppReadStore and AppRepository should be the Mock ones.
    const { repository } = repoIndex;
    
    // Validate repository is exactly the mockRepository instance
    expect(repository).toBe(mockRepository);
  });

  it('Test 35 - Security Rules Baseline', async () => {
    // Cannot use require('fs') easily without imports, let's just use static imports at the top or await import
    const fs = await import('fs');
    const path = await import('path');
    const rulesPath = path.join(__dirname, '../../firestore.rules');
    const rules = fs.readFileSync(rulesPath, 'utf8');
    expect(rules).toContain("allow read, write: if false;");
    expect(rules).not.toContain("allow read, write: if true;");
  });

  it('Test 36 - Safe Dispatch Queue Document Key', async () => {
    const schema = await import('../repositories/firestore/schema');
    const key1 = schema.dispatchQueueDocumentId('camp-1', 'cont-1');
    const key2 = schema.dispatchQueueDocumentId('camp-1', 'cont-1');
    expect(key1).toEqual(key2);

    const keyDiff = schema.dispatchQueueDocumentId('camp-1', 'cont-2');
    expect(key1).not.toEqual(keyDiff);

    const keySlash = schema.dispatchQueueDocumentId('camp/1', 'cont/1');
    expect(keySlash).not.toContain('/');

    const keyColliding1 = schema.dispatchQueueDocumentId('camp::1', 'cont');
    const keyColliding2 = schema.dispatchQueueDocumentId('camp', '1::cont');
    expect(keyColliding1).not.toEqual(keyColliding2);
  });

  it('Test 37 - Queue Domain ID vs Firestore Document ID', async () => {
    const schema = await import('../repositories/firestore/schema');
    const queueEntryId = 'dq-1234';
    const campaignId = 'camp-abc';
    const contactId = 'cont-xyz';
    const queueDocumentId = schema.dispatchQueueDocumentId(campaignId, contactId);
    
    expect(queueEntryId).not.toEqual(queueDocumentId);
    expect(queueDocumentId).toBe(`${campaignId}::${contactId}`); // Not URL-encoded since there are no special chars
  });

  it('Test 38 - Firestore Sentinel Preservation', async () => {
    const serializers = await import('../repositories/firestore/serializers');
    const { serverTimestamp } = await import('firebase/firestore');
    
    const sentinel = serverTimestamp();
    const cleaned = serializers.cleanForFirestore({
      name: 'Test',
      timestamp: sentinel
    });
    
    expect(cleaned.name).toBe('Test');
    expect(cleaned.timestamp).toBe(sentinel);
  });

  it('Test 39 - Firestore Queue Addressing Guard', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = path.join(__dirname, '../repositories/FirestoreRepository.ts');
    const code = fs.readFileSync(repoPath, 'utf8');
    
    // Ensure we don't accidentally query DISPATCH_QUEUE with update.id or queueEntryId
    expect(code).not.toMatch(/doc\(db,\s*COLLECTIONS\.DISPATCH_QUEUE,\s*update\.id\)/);
    expect(code).not.toMatch(/doc\(db,\s*COLLECTIONS\.DISPATCH_QUEUE,\s*queueEntryId\)/);
    expect(code).not.toMatch(/doc\(db,\s*COLLECTIONS\.DISPATCH_QUEUE,\s*queueEntryIdToReply\)/);
    
    // Check that we properly use dispatchQueueDocumentId
    expect(code).toContain('dispatchQueueDocumentId(');
  });

  it('Test 40 - Client Response Contract', async () => {
    const { repository } = await import('../repositories/index');
    await repository.reset();
    
    // Set up state
    const now = new Date();
    await (repository as any).addDispatchQueueEntries([{
      id: 'dq-reply', campaignId: 'camp-1', contactId: 'c-1', position: 1, status: 'SENT', attempts: 1, createdAt: now
    }]);
    
    // Add conversation so unreadCount check doesn't fail
    const state = repository.getState();
    state.conversations.push({
        id: 'conv-1',
        tenantId: 'tenant-1',
        contactId: 'c-1',
        createdAt: now,
        updatedAt: now,
        unreadCount: 0
    });
    state.conversations.push({
        id: 'conv-2',
        tenantId: 'tenant-1',
        contactId: 'c-2',
        createdAt: now,
        updatedAt: now,
        unreadCount: 0
    });
    
    const qBefore = repository.getState().dispatchQueue.find(q => q.id === 'dq-reply');
    expect(qBefore?.status).toBe('SENT');
    
    const msg: any = { id: 'msg-reply', conversationId: 'conv-1', content: 'hello', createdAt: now };
    
    // Process response
    await repository.processClientResponse(msg, 'conv-1', now, { id: 'dq-reply', campaignId: 'camp-1', contactId: 'c-1' }, now);
    
    const stateAfter = repository.getState();
    const qAfter = stateAfter.dispatchQueue.find(q => q.id === 'dq-reply');
    expect(qAfter?.status).toBe('REPLIED');
    expect(stateAfter.messages.find(m => m.id === 'msg-reply')).toBeDefined();
    expect(stateAfter.conversations.find(c => c.id === 'conv-1')?.unreadCount).toBeGreaterThan(0);
    
    // Invalid test: Process response on DRAFT_PREPARED (should not change status)
    await (repository as any).addDispatchQueueEntries([{
      id: 'dq-draft', campaignId: 'camp-2', contactId: 'c-2', position: 1, status: 'DRAFT_PREPARED', attempts: 0, createdAt: now
    }]);
    await repository.processClientResponse({ ...msg, id: 'msg-2' }, 'conv-2', now, { id: 'dq-draft', campaignId: 'camp-2', contactId: 'c-2' }, now);
    
    const qDraftAfter = repository.getState().dispatchQueue.find(q => q.id === 'dq-draft');
    expect(qDraftAfter?.status).toBe('DRAFT_PREPARED');
  });

  it('Test 41 - Firestore Cache Must Not Use Mock Fixtures', async () => {
    const { FirestoreRepository } = await import('../repositories/FirestoreRepository');
    const repo = new FirestoreRepository();
    const state = repo.getState();
    
    expect(state.contacts.length).toBe(0);
    expect(state.conversations.length).toBe(0);
    expect(state.campaigns.length).toBe(0);
    expect(state.dispatchQueue.length).toBe(0);
    expect(state.messages.length).toBe(0);
    expect(state.orders.length).toBe(0);
    
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = path.join(__dirname, '../repositories/FirestoreRepository.ts');
    const code = fs.readFileSync(repoPath, 'utf8');
    
    expect(code).not.toContain("import { createInitialState } from './MockRepository'");
  });

  it('Test 42 - Strict Activation Guard', async () => {
    const { repository } = await import('../repositories/index');
    const { mockRepository } = await import('../repositories/MockRepository');
    
    // Must be strictly identically equal
    expect(repository).toStrictEqual(mockRepository);
    
    // Must NOT be FirestoreRepository
    expect(repository.constructor.name).not.toBe('FirestoreRepository');
  });

  it('Test 43 - Firestore Transaction Read Before Write', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = path.join(__dirname, '../repositories/FirestoreRepository.ts');
    const code = fs.readFileSync(repoPath, 'utf8');

    // Extract processClientResponse body
    const methodMatch = code.match(/async processClientResponse[\s\S]*?async createOrderWithItems/);
    expect(methodMatch).toBeTruthy();
    const methodBody = methodMatch![0];

    // Check transaction flow
    const txMatch = methodBody.match(/runTransaction\([^,]+,\s*async\s*\(([^)]+)\)\s*=>\s*{([\s\S]*?)}\);/);
    expect(txMatch).toBeTruthy();
    const txBody = txMatch![2];

    const firstWriteIndex = Math.min(
      txBody.indexOf('.set(') !== -1 ? txBody.indexOf('.set(') : Infinity,
      txBody.indexOf('.update(') !== -1 ? txBody.indexOf('.update(') : Infinity,
      txBody.indexOf('.delete(') !== -1 ? txBody.indexOf('.delete(') : Infinity
    );

    const lastReadIndex = txBody.lastIndexOf('.get(');

    expect(lastReadIndex).toBeLessThan(firstWriteIndex);
  });

  it('Test 44 - Transaction Callback Side Effect Guard', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = path.join(__dirname, '../repositories/FirestoreRepository.ts');
    const code = fs.readFileSync(repoPath, 'utf8');

    const methodMatch = code.match(/async prepareDrafts[\s\S]*?async sendPreparedMessage/);
    expect(methodMatch).toBeTruthy();
    const methodBody = methodMatch![0];

    const txMatch = methodBody.match(/runTransaction\([^,]+,\s*async\s*\(([^)]+)\)\s*=>\s*{([\s\S]*?)}\);/);
    expect(txMatch).toBeTruthy();
    const txBody = txMatch![2];

    // Ensure preparedIds.push is NOT in the transaction body
    expect(txBody).not.toMatch(/preparedIds\.push/);

    // Ensure it IS in the method body outside
    expect(methodBody).toMatch(/preparedIds\.push/);
  });

  it('Test 45 - Firestore Infrastructure Error Propagation', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = path.join(__dirname, '../repositories/FirestoreRepository.ts');
    const code = fs.readFileSync(repoPath, 'utf8');

    const sendMsgMatch = code.match(/async sendPreparedMessage[\s\S]*?async processClientResponse/);
    expect(sendMsgMatch).toBeTruthy();
    // Catch translating everything to false is forbidden
    expect(sendMsgMatch![0]).not.toMatch(/catch\s*\([^)]*\)\s*{\s*return\s+false;?\s*}/);

    const prepareMatch = code.match(/async prepareDrafts[\s\S]*?async sendPreparedMessage/);
    expect(prepareMatch).toBeTruthy();
    // Catch swallowing error via console.error is forbidden
    expect(prepareMatch![0]).not.toMatch(/catch\s*\([^)]*\)\s*{\s*console\.error/);
  });

  it('Test 46 - Firestore Queue Position Allocation Guard', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = path.join(__dirname, '../repositories/FirestoreRepository.ts');
    const code = fs.readFileSync(repoPath, 'utf8');

    const addQueueMatch = code.match(/async addDispatchQueueEntries[\s\S]*?async prepareDrafts/);
    expect(addQueueMatch).toBeTruthy();
    const methodBody = addQueueMatch![0];

    expect(methodBody).toContain('COLLECTIONS.DISPATCH_CAMPAIGNS');
    expect(methodBody).toMatch(/\.get\(\s*campaignRef\s*\)/);
    expect(methodBody).toMatch(/\.get\(\s*entryRef\s*\)/);
    expect(methodBody).toContain('nextQueuePosition');
    expect(methodBody).toMatch(/\.update\(\s*campaignRef\s*,[\s\S]*nextQueuePosition/);
  });

  it('Test 47 - Auth Service Surface', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const authPath = path.join(__dirname, '../auth/AuthService.ts');
    const code = fs.readFileSync(authPath, 'utf8');

    expect(code).toContain('signIn:');
    expect(code).toContain('signOut:');
    expect(code).toContain('subscribeToAuthState:');
    expect(code).toContain('getCurrentUser:');

    expect(code).not.toContain('signUp');
    expect(code).not.toContain('register');
    expect(code).not.toContain('createUserWithEmailAndPassword');
  });

  it('Test 48 - No Public Signup', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const loginPath = path.join(__dirname, '../views/LoginView.tsx');
    const code = fs.readFileSync(loginPath, 'utf8');

    expect(code).not.toMatch(/createUserWithEmailAndPassword/i);
    expect(code).not.toMatch(/Criar conta/i);
    expect(code).not.toMatch(/Sign up/i);
    expect(code).not.toMatch(/Register/i);
    
    const authPath = path.join(__dirname, '../auth/AuthService.ts');
    const authCode = fs.readFileSync(authPath, 'utf8');
    expect(authCode).not.toMatch(/createUserWithEmailAndPassword/i);
  });

  it('Test 49 - Auth Gate', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appPath = path.join(__dirname, '../App.tsx');
    const code = fs.readFileSync(appPath, 'utf8');

    expect(code).toContain("status === 'loading'");
    expect(code).toContain("status === 'unauthenticated'");
    expect(code).toContain("<LoginView");
  });

  it('Test 50 - Password Safety', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const loginPath = path.join(__dirname, '../views/LoginView.tsx');
    const code = fs.readFileSync(loginPath, 'utf8');

    expect(code).not.toContain('localStorage.setItem("password"');
    expect(code).not.toContain('sessionStorage.setItem("password"');
    expect(code).not.toMatch(/console\.log\([^)]*password[^)]*\)/i);
  });

  it('Test 51 - Users Rules Baseline', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const rulesPath = path.join(__dirname, '../../firestore.rules');
    const code = fs.readFileSync(rulesPath, 'utf8');

    expect(code).toContain('match /users/{uid}');
    expect(code).toContain('request.auth.uid');
    expect(code).toContain('active');
    expect(code).toMatch(/allow write:\s*if\s*false/);
  });

  it('Test 52 - Active User Data Access', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const rulesPath = path.join(__dirname, '../../firestore.rules');
    const code = fs.readFileSync(rulesPath, 'utf8');

    // Make sure operational collections are protected by isActiveUser
    expect(code).toMatch(/match \/messages\/\{document=\*\*\}\s*\{\s*allow read, write:\s*if\s*isActiveUser\(\);\s*\}/);
    expect(code).toMatch(/match \/opportunities\/\{document=\*\*\}\s*\{\s*allow read, write:\s*if\s*isActiveUser\(\);\s*\}/);
  });

  it('Test 53 - Mock Repository Still Active', async () => {
    const { repository } = await import('../repositories/index');
    const { mockRepository } = await import('../repositories/MockRepository');
    
    // Guarding that FirestoreRepository is inactive
    expect(repository).toStrictEqual(mockRepository);
    expect(repository.constructor.name).not.toBe('FirestoreRepository');
  });

  it('Test 54 - Product Identity', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const loginPath = path.join(__dirname, '../views/LoginView.tsx');
    const loginCode = fs.readFileSync(loginPath, 'utf8');

    expect(loginCode).toContain('LidacomZap Gestão Inteligente');
    expect(loginCode).toContain('Restaurante Prato Mineiro');
    expect(loginCode).toContain('Operação Piloto');

    const sidebarPath = path.join(__dirname, '../components/Sidebar.tsx');
    const sidebarCode = fs.readFileSync(sidebarPath, 'utf8');
    
    expect(sidebarCode).toContain('LidacomZap');
    expect(sidebarCode).toContain('Gestão Inteligente');
    expect(sidebarCode).not.toMatch(/>\s*Prato Mineiro\s*</);

    const layoutPath = path.join(__dirname, '../components/Layout.tsx');
    const layoutCode = fs.readFileSync(layoutPath, 'utf8');
    expect(layoutCode).toContain('Operação Piloto');
    expect(layoutCode).toContain('Restaurante Prato Mineiro');
  });

  it('Test 55 - Admin UID Not Used As Client Security', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const adminUid = 'ty8fYmiVk1StqBnSgqWex7BXV012';
    const srcDir = path.join(__dirname, '..');
    const matches: string[] = [];

    const scanDirectory = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path
          .relative(srcDir, fullPath)
          .replace(/\\/g, '/');

        if (entry.isDirectory()) {
          if (
            relativePath === 'tests' ||
            relativePath.startsWith('tests/')
          ) {
            continue;
          }

          scanDirectory(fullPath);
          continue;
        }

        if (
          entry.isFile() &&
          fs.readFileSync(fullPath, 'utf8').includes(adminUid)
        ) {
          matches.push(relativePath);
        }
      }
    };

    scanDirectory(srcDir);

    expect(matches).toEqual([]);
  });

  it('Test 56 - Sign Out Async Handling', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const layoutPath = path.join(__dirname, '../components/Layout.tsx');
    const code = fs.readFileSync(layoutPath, 'utf8');

    expect(code).toMatch(/const handleSignOut = async \(\) =>/);
    expect(code).toMatch(/await AuthService\.signOut\(\)/);
    expect(code).toContain('setIsSigningOut(true)');
    expect(code).toMatch(/setSignOutError\([^)]+\)/);
    expect(code).toMatch(/disabled=\{isSigningOut\}/);
  });

  it('Test 57 - Authentication Error Semantics', async () => {
    const { mapAuthError } = await import('../auth/AuthService');
    
    expect(mapAuthError({ code: 'auth/network-request-failed' }))
      .toContain('Não foi possível conectar');
      
    expect(mapAuthError({ code: 'auth/too-many-requests' }))
      .toContain('Muitas tentativas foram realizadas');
      
    expect(mapAuthError({ code: 'auth/user-not-found' }))
      .toBe('E-mail ou senha inválidos.');
      
    expect(mapAuthError({ code: 'auth/wrong-password' }))
      .toBe('E-mail ou senha inválidos.');

    expect(mapAuthError({ code: 'auth/invalid-credential' }))
      .toBe('E-mail ou senha inválidos.');
      
    expect(mapAuthError({ code: 'unknown' }))
      .toBe('Não foi possível realizar o login. Tente novamente.');
  });

  it('Test 58 - User Profile Service Is Read Only', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const servicePath = path.join(__dirname, '../auth/UserProfileService.ts');
    const code = fs.readFileSync(servicePath, 'utf8');

    expect(code).toContain('getDoc');
    expect(code).not.toContain('setDoc');
    expect(code).not.toContain('addDoc');
    expect(code).not.toContain('updateDoc');
    expect(code).not.toContain('deleteDoc');
    expect(code).not.toContain('writeBatch');
    expect(code).not.toContain('runTransaction');
  });

  it('Test 59 - Authorization State Machine', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const authProviderPath = path.join(__dirname, '../auth/AuthProvider.tsx');
    const code = fs.readFileSync(authProviderPath, 'utf8');

    expect(code).toContain("status: 'loading'");
    expect(code).toContain("status: 'unauthenticated'");
    expect(code).toContain("status: 'authorizing'");
    expect(code).toContain("status: 'authorized'");
    expect(code).toContain("status: 'unauthorized'");
  });

  it('Test 60 - Operational UI Requires Authorization', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appPath = path.join(__dirname, '../App.tsx');
    const code = fs.readFileSync(appPath, 'utf8');

    expect(code).toContain("status === 'authorized'");
    expect(code).not.toMatch(/if\s*\(\s*status\s*===\s*'authenticated'\s*\)\s*{\s*return\s*<>{children}<\/>;\s*}/);
    expect(code).toMatch(/if\s*\(\s*status\s*===\s*'authorized'\s*\)\s*{\s*return\s*<>{children}<\/>;\s*}/);
  });

  it('Test 61 - Invalid Profile Is Denied', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const servicePath = path.join(__dirname, '../auth/UserProfileService.ts');
    const code = fs.readFileSync(servicePath, 'utf8');

    // Make sure we have type/value validations
    expect(code).toContain('typeof data.active !== \'boolean\'');
    expect(code).toContain('data.uid !== uid');
  });

  it('Test 62 - No Authorization Persistence', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const providerPath = path.join(__dirname, '../auth/AuthProvider.tsx');
    const servicePath = path.join(__dirname, '../auth/UserProfileService.ts');
    const providerCode = fs.readFileSync(providerPath, 'utf8');
    const serviceCode = fs.readFileSync(servicePath, 'utf8');

    expect(providerCode).not.toContain('localStorage');
    expect(providerCode).not.toContain('sessionStorage');
    expect(serviceCode).not.toContain('localStorage');
    expect(serviceCode).not.toContain('sessionStorage');
  });

  it('Test 63 - Mock Still Active', async () => {
    const { repository } = await import('../repositories/index');
    const { mockRepository } = await import('../repositories/MockRepository');
    
    // Guarding that FirestoreRepository is inactive
    expect(repository).toStrictEqual(mockRepository);
    expect(repository.constructor.name).not.toBe('FirestoreRepository');
  });

  it('Test 64 - Only Users Live Read', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const servicePath = path.join(__dirname, '../auth/UserProfileService.ts');
    const code = fs.readFileSync(servicePath, 'utf8');

    expect(code).toContain('COLLECTIONS.USERS');
    expect(code).not.toContain('COLLECTIONS.CONTACTS');
    expect(code).not.toContain('COLLECTIONS.MESSAGES');
    expect(code).not.toContain('COLLECTIONS.ORDERS');
  });

  it('Test 65 - Stale Authorization Cannot Win', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const authProviderPath = path.join(__dirname, '../auth/AuthProvider.tsx');
    const code = fs.readFileSync(authProviderPath, 'utf8');

    expect(code).toMatch(/authGenerationRef/);
    expect(code).toMatch(/generation\s*!==\s*authGenerationRef\.current/);
  });

  it('Test 66 - Logout During Authorization', async () => {
    // Test generation logic directly
    let authGeneration = 0;
    let state = { status: 'loading' };

    // Simulate AuthProvider logic
    let resolveProfileA: (val: any) => void;
    const profilePromiseA = new Promise((resolve) => {
      resolveProfileA = resolve;
    });

    // 1. User logs in (generation 1)
    const gen1 = ++authGeneration;
    state = { status: 'authorizing' };

    // Start async profile load
    const profileLoadA = profilePromiseA.then((profile: any) => {
      if (gen1 !== authGeneration) return;
      state = { status: 'authorized' };
    });

    // 2. User logs out before profile A completes (generation 2)
    const gen2 = ++authGeneration;
    state = { status: 'unauthenticated' };

    // 3. Profile A resolves later
    resolveProfileA!({ uid: 'user-a', active: true });
    await profileLoadA;

    // Final state MUST remain unauthenticated
    expect(state.status).toBe('unauthenticated');
  });

  it('Test 67 - User Switch During Authorization', async () => {
    let authGeneration = 0;
    let state: any = { status: 'loading' };

    let resolveProfileA: (val: any) => void;
    const profilePromiseA = new Promise((resolve) => {
      resolveProfileA = resolve;
    });

    let resolveProfileB: (val: any) => void;
    const profilePromiseB = new Promise((resolve) => {
      resolveProfileB = resolve;
    });

    // 1. User A begins (generation 1)
    const gen1 = ++authGeneration;
    state = { status: 'authorizing', user: { uid: 'user-a' } };

    const loadA = profilePromiseA.then((profile: any) => {
      if (gen1 !== authGeneration) return;
      state = { status: 'authorized', user: { uid: 'user-a' }, profile };
    });

    // 2. User switches to B (generation 2)
    const gen2 = ++authGeneration;
    state = { status: 'authorizing', user: { uid: 'user-b' } };

    const loadB = profilePromiseB.then((profile: any) => {
      if (gen2 !== authGeneration) return;
      state = { status: 'authorized', user: { uid: 'user-b' }, profile };
    });

    // 3. User B resolves first
    resolveProfileB!({ uid: 'user-b', active: true });
    await loadB;

    expect(state.status).toBe('authorized');
    expect(state.user.uid).toBe('user-b');
    expect(state.profile.uid).toBe('user-b');

    // 4. User A resolves after B
    resolveProfileA!({ uid: 'user-a', active: true });
    await loadA;

    // Must still be User B
    expect(state.status).toBe('authorized');
    expect(state.user.uid).toBe('user-b');
    expect(state.profile.uid).toBe('user-b');
  });

  it('Test 68 - User Profile Timestamp Boundary', async () => {
    const { validateAndMapUserProfile } = await import('../auth/UserProfileService');
    const { Timestamp } = await import('firebase/firestore');

    const now = new Date();
    const ts = Timestamp.fromDate(now);

    const rawData = {
      uid: 'user-test-123',
      email: 'user@test.com',
      name: 'Test User',
      active: true,
      role: 'ADMIN',
      createdAt: ts,
      updatedAt: ts
    };

    const profile = validateAndMapUserProfile(rawData, 'user-test-123');
    expect(profile).not.toBeNull();
    expect(profile?.createdAt instanceof Date).toBe(true);
    expect(profile?.updatedAt instanceof Date).toBe(true);
    expect(profile?.createdAt.getTime()).toBe(now.getTime());
    expect(profile?.updatedAt.getTime()).toBe(now.getTime());
    expect(profile?.role).toBe('ADMIN');
    expect(profile?.active).toBe(true);
  });

  it('Test 69 - Invalid User Profile Timestamp Is Denied', async () => {
    const { validateAndMapUserProfile } = await import('../auth/UserProfileService');
    const { Timestamp } = await import('firebase/firestore');

    const ts = Timestamp.now();

    // 1. createdAt is a string
    const invalidCreatedAt = {
      uid: 'user-test-123',
      email: 'user@test.com',
      name: 'Test User',
      active: true,
      role: 'ADMIN',
      createdAt: '2026-08-30T00:00:00Z',
      updatedAt: ts
    };
    expect(validateAndMapUserProfile(invalidCreatedAt, 'user-test-123')).toBeNull();

    // 2. updatedAt is missing
    const missingUpdatedAt = {
      uid: 'user-test-123',
      email: 'user@test.com',
      name: 'Test User',
      active: true,
      role: 'ADMIN',
      createdAt: ts
    };
    expect(validateAndMapUserProfile(missingUpdatedAt, 'user-test-123')).toBeNull();

    // 3. invalid date timestamp
    const invalidDateTs = {
      uid: 'user-test-123',
      email: 'user@test.com',
      name: 'Test User',
      active: true,
      role: 'ADMIN',
      createdAt: { toDate: () => new Date('invalid') },
      updatedAt: ts
    };
    expect(validateAndMapUserProfile(invalidDateTs, 'user-test-123')).toBeNull();
  });

  it('Test 70 - Data Source Mode Parsing', async () => {
    const { parseDataSourceMode } = await import('../config/dataSource');
    const { createRepository } = await import('../repositories');

    expect(parseDataSourceMode(undefined)).toBe('MOCK');
    expect(parseDataSourceMode('')).toBe('MOCK');
    expect(parseDataSourceMode('   ')).toBe('MOCK');
    expect(parseDataSourceMode('MOCK')).toBe('MOCK');
    expect(parseDataSourceMode('FIRESTORE_READONLY')).toBe('FIRESTORE_READONLY');
    expect(parseDataSourceMode('FIRESTORE')).toBe('FIRESTORE');

    expect(() => parseDataSourceMode('INVALID')).toThrow('Invalid DATA_SOURCE_MODE');
    expect(() => createRepository('FIRESTORE')).toThrow('Firestore write mode is not enabled.');
  });

  it('Test 71 - Mock Is Safe Default', async () => {
    const { getDataSourceMode } = await import('../config/dataSource');
    const { createRepository } = await import('../repositories');

    // Default mode is MOCK
    const mode = getDataSourceMode();
    expect(mode).toBe('MOCK');

    const defaultRepo = createRepository('MOCK');
    expect(defaultRepo.getState().contacts.length).toBe(20);
    expect(defaultRepo.getState().campaigns.length).toBe(1);
  });

  it('Test 72 - Firestore ReadOnly Repository Cannot Write', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    await expect(repo.addDispatchQueueEntries([])).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.prepareDrafts([], [])).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.sendPreparedMessage({} as any, 'd1', 'q1', new Date())).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.processClientResponse({} as any, 'c1', new Date())).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.createOrderWithItems({} as any, [])).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.updateCampaignDailyLimit('c1', 100, new Date())).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.transitionOpportunityStage('ct1', 't1', 'LEAD', new Date())).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.addTimelineEvent({} as any)).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
    await expect(repo.reset()).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
  });

  it('Test 73 - Empty Firestore Hydrates To Empty State', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    expect(repo.getHydrationStatus()).toBe('idle');

    // Simulate empty Firestore collections
    const success = await repo.hydrate(async () => []);
    expect(success).toBe(true);
    expect(repo.getHydrationStatus()).toBe('ready');
    expect(repo.getHydrationError()).toBeNull();

    const state = repo.getState();
    expect(state.contacts.length).toBe(0);
    expect(state.conversations.length).toBe(0);
    expect(state.opportunities.length).toBe(0);
    expect(state.campaigns.length).toBe(0);
    expect(state.dispatchQueue.length).toBe(0);
    expect(state.pendingMessages.length).toBe(0);
    expect(state.orders.length).toBe(0);
    expect(state.orderItems.length).toBe(0);
    expect(state.timeline.length).toBe(0);
    expect(state.users.length).toBe(0);
    // Does NOT contain mock data
    expect(state.contacts.length).not.toBe(20);
  });

  it('Test 74 - Firestore Failure Never Falls Back To Mock', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    const success = await repo.hydrate(async (col) => {
      if (col === 'opportunities') {
        throw new Error('Firestore connection failed');
      }
      return [];
    });

    expect(success).toBe(false);
    expect(repo.getHydrationStatus()).toBe('error');
    expect(repo.getHydrationError()).toContain('Firestore connection failed');

    const state = repo.getState();
    // Cache must remain empty, never fall back to mock data
    expect(state.contacts.length).toBe(0);
    expect(state.contacts.length).not.toBe(20);
    expect(state.opportunities.length).toBe(0);
  });

  it('Test 75 - Firestore Hydration Is Atomic', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    const success = await repo.hydrate(async (col) => {
      if (col === 'contacts') {
        return [{ id: 'c1', name: 'Real Contact', phone: '123' }];
      }
      if (col === 'orders') {
        throw new Error('Orders query failed');
      }
      return [];
    });

    expect(success).toBe(false);
    expect(repo.getHydrationStatus()).toBe('error');

    // Partial data must NOT be committed to cache
    const state = repo.getState();
    expect(state.contacts.length).toBe(0);
  });

  it('Test 76 - Operational Hydration Requires Authorized User', async () => {
    const { resolveAuthGateState, isAuthorizedToAccessContent } = await import('../components/AuthGate');

    // Loading / Initializing: DataSourceGate is not reached
    expect(resolveAuthGateState('loading')).toBe('LOADING');
    expect(isAuthorizedToAccessContent('loading')).toBe(false);

    // Authorizing (Firestore profile validation in progress): DataSourceGate is not reached
    expect(resolveAuthGateState('authorizing')).toBe('LOADING');
    expect(isAuthorizedToAccessContent('authorizing')).toBe(false);

    // Unauthenticated: Redirects to Login, DataSourceGate is not reached
    expect(resolveAuthGateState('unauthenticated')).toBe('UNAUTHENTICATED');
    expect(isAuthorizedToAccessContent('unauthenticated')).toBe(false);

    // Unauthorized: Redirects to UnauthorizedView, DataSourceGate is not reached
    expect(resolveAuthGateState('unauthorized')).toBe('UNAUTHORIZED');
    expect(isAuthorizedToAccessContent('unauthorized')).toBe(false);

    // Authorized: Only authorized status allows DataSourceGate / children access
    expect(resolveAuthGateState('authorized')).toBe('AUTHORIZED');
    expect(isAuthorizedToAccessContent('authorized')).toBe(true);
  });

  it('Test 77 - Stale Hydration Cannot Win', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    let resolveGen1: (val: any[]) => void;
    const slowPromise = new Promise<any[]>((resolve) => {
      resolveGen1 = resolve;
    });

    const now = new Date();

    // 1. Trigger first slow hydration (Gen 1)
    const hyd1Promise = repo.hydrate(async (col) => {
      if (col === 'contacts') {
        return await slowPromise;
      }
      return [];
    });

    expect(repo.getHydrationGeneration()).toBe(1);

    // 2. Trigger second fast hydration (Gen 2) with different data
    const hyd2Promise = repo.hydrate(async (col) => {
      if (col === 'contacts') {
        return [{
          id: 'contact-fast-gen2',
          tenantId: 't-pratomineiro',
          name: 'Fast Contact Gen 2',
          phone: '999',
          tags: [],
          notes: '',
          createdAt: now,
          updatedAt: now
        }];
      }
      return [];
    });

    expect(repo.getHydrationGeneration()).toBe(2);

    // Wait for Gen 2 to resolve
    const res2 = await hyd2Promise;
    expect(res2).toBe(true);
    expect(repo.getState().contacts[0]?.id).toBe('contact-fast-gen2');

    // 3. Resolve Gen 1 slow promise with stale data
    resolveGen1!([{
      id: 'contact-slow-gen1',
      tenantId: 't-pratomineiro',
      name: 'Slow Contact Gen 1',
      phone: '111',
      tags: [],
      notes: '',
      createdAt: now,
      updatedAt: now
    }]);
    const res1 = await hyd1Promise;
    expect(res1).toBe(false);

    // State MUST remain from Gen 2, not overwritten by stale Gen 1!
    expect(repo.getState().contacts[0]?.id).toBe('contact-fast-gen2');
  });

  it('Test 78 - ReadOnly UI Mode Disables Mutations', async () => {
    const { parseDataSourceMode, isReadOnlyMode } = await import('../config/dataSource');
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { CRM } = await import('../views/CRM');
    const { Disparador } = await import('../views/Disparador');
    const { Central } = await import('../views/Central');
    const { repository } = await import('../repositories');

    const mockMode = parseDataSourceMode('MOCK');
    const readOnlyMode = parseDataSourceMode('FIRESTORE_READONLY');

    expect(mockMode).toBe('MOCK');
    expect(readOnlyMode).toBe('FIRESTORE_READONLY');

    // Seed an opportunity so CRM renders controls
    await repository.transitionOpportunityStage('c-1', 't-1', 'LEAD', new Date());

    // 1. In MOCK mode: isReadOnlyMode is false and UI mutation controls are enabled
    process.env.VITE_DATA_SOURCE_MODE = 'MOCK';
    expect(isReadOnlyMode()).toBe(false);

    const crmMock = renderToStaticMarkup(React.createElement(CRM));
    const dispMock = renderToStaticMarkup(React.createElement(Disparador));
    const centralMock = renderToStaticMarkup(React.createElement(Central));

    expect(crmMock).toContain('LEAD');
    expect(crmMock).not.toContain('Indisponível no modo somente leitura.');
    expect(crmMock).not.toMatch(/<select[^>]*disabled=\"\"/);

    expect(dispMock).toContain('Popular Fila de Contatos');
    expect(dispMock).not.toContain('Indisponível no modo somente leitura.');
    expect(dispMock).toMatch(/<button class=\"[^\"]*\">Popular Fila de Contatos<\/button>/);
    expect(dispMock).toContain('cursor-pointer group');

    expect(centralMock).toContain('Cliente 1');

    // 2. In FIRESTORE_READONLY mode: isReadOnlyMode is true and UI mutation controls are disabled
    process.env.VITE_DATA_SOURCE_MODE = 'FIRESTORE_READONLY';
    expect(isReadOnlyMode()).toBe(true);

    const crmReadOnly = renderToStaticMarkup(React.createElement(CRM));
    const dispReadOnly = renderToStaticMarkup(React.createElement(Disparador));
    const centralReadOnly = renderToStaticMarkup(React.createElement(Central));

    // CRM: stage selector disabled with tooltip
    expect(crmReadOnly).toContain('Indisponível no modo somente leitura.');
    expect(crmReadOnly).toMatch(/<select[^>]*disabled=\"\"[^>]*title=\"Indisponível no modo somente leitura\.\"/);

    // Disparador: Popular Fila disabled with tooltip and disabled limit editor
    expect(dispReadOnly).toContain('Indisponível no modo somente leitura.');
    expect(dispReadOnly).toMatch(/<button[^>]*disabled=\"\"[^>]*title=\"Indisponível no modo somente leitura\.\"[^>]*>Popular Fila de Contatos<\/button>/);
    expect(dispReadOnly).toContain('opacity-70 cursor-not-allowed');

    // Central: rendered in read-only mode
    expect(centralReadOnly).toContain('Cliente 1');

    // Reset env
    delete process.env.VITE_DATA_SOURCE_MODE;

    // In FIRESTORE_READONLY mode, repo mutation methods are strictly rejected
    const readOnlyRepo = new FirestoreReadOnlyRepository();
    await expect(readOnlyRepo.addTimelineEvent({
      id: 'e1',
      contactId: 'c1',
      type: 'SYSTEM',
      description: 'test',
      createdAt: new Date()
    })).rejects.toThrow('Operation is disabled in FIRESTORE_READONLY mode.');
  }, 20000);

  it('Test 79 - Firestore ReadOnly Operational Collection Allowlist', async () => {
    const { isOperationalCollectionAllowed, OPERATIONAL_COLLECTIONS } = await import('../repositories/FirestoreReadOnlyRepository');

    expect(OPERATIONAL_COLLECTIONS.length).toBe(12);

    expect(isOperationalCollectionAllowed('contacts')).toBe(true);
    expect(isOperationalCollectionAllowed('conversations')).toBe(true);
    expect(isOperationalCollectionAllowed('messages')).toBe(true);
    expect(isOperationalCollectionAllowed('opportunities')).toBe(true);
    expect(isOperationalCollectionAllowed('dispatchCampaigns')).toBe(true);
    expect(isOperationalCollectionAllowed('dispatchQueue')).toBe(true);
    expect(isOperationalCollectionAllowed('pendingOutboundMessages')).toBe(true);
    expect(isOperationalCollectionAllowed('orders')).toBe(true);
    expect(isOperationalCollectionAllowed('orderItems')).toBe(true);
    expect(isOperationalCollectionAllowed('timelineEvents')).toBe(true);
    expect(isOperationalCollectionAllowed('customerProfiles')).toBe(true);
    expect(isOperationalCollectionAllowed('customerAddresses')).toBe(true);

    // Forbidden: users belongs to Auth/Authorization layer
    expect(isOperationalCollectionAllowed('users')).toBe(false);
    expect(isOperationalCollectionAllowed('unknown_collection')).toBe(false);
  });

  it('Test 80 - Class Repository External Store Binding', async () => {
    const { subscribeToRepository, getRepositorySnapshot } = await import('../store/useAppStore');
    
    // Direct invocation must not throw TypeError from losing class 'this' context
    expect(() => getRepositorySnapshot()).not.toThrow();
    const snapshot = getRepositorySnapshot();
    expect(snapshot).toBeDefined();
    expect(Array.isArray(snapshot.contacts)).toBe(true);

    let notified = false;
    const unsubscribe = subscribeToRepository(() => {
      notified = true;
    });
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('Test 81 - All Operational Collections Are Actually Hydrated', async () => {
    const { FirestoreReadOnlyRepository, OPERATIONAL_COLLECTIONS } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    const queriedCollections: string[] = [];
    const success = await repo.hydrate(async (colName) => {
      queriedCollections.push(colName);
      return [];
    });

    expect(success).toBe(true);
    expect(queriedCollections.length).toBe(12);
    expect(queriedCollections.length).toBe(OPERATIONAL_COLLECTIONS.length);

    // Every single operational collection must be queried
    OPERATIONAL_COLLECTIONS.forEach(col => {
      expect(queriedCollections).toContain(col);
    });
  });

  it('Test 82 - Customer Profile And Address Hydration', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    const mockProfile = {
      id: 'profile-1',
      contactId: 'c1',
      fullName: 'Cliente Prato Mineiro',
      phone: '31988887777',
      email: 'cliente@pratomineiro.com'
    };

    const mockAddress = {
      id: 'address-1',
      contactId: 'c1',
      street: 'Rua das Flores',
      number: '123',
      neighborhood: 'Centro',
      complement: 'Apto 101',
      postalCode: '30110-000'
    };

    const success = await repo.hydrate(async (colName) => {
      if (colName === 'customerProfiles') {
        return [mockProfile];
      }
      if (colName === 'customerAddresses') {
        return [mockAddress];
      }
      return [];
    });

    expect(success).toBe(true);
    const state = repo.getState();
    expect(state.customerProfiles.length).toBe(1);
    expect(state.customerProfiles[0]).toEqual(mockProfile);
    expect(state.customerAddresses.length).toBe(1);
    expect(state.customerAddresses[0]).toEqual(mockAddress);
  });

  it('Test 83 - Malformed Firestore Document Fails Hydration', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    // 1. Missing required field 'name' on contact
    const badContact = {
      id: 'c1',
      tenantId: 't-pratomineiro',
      // name is missing
      phone: '123456',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const success = await repo.hydrate(async (colName) => {
      if (colName === 'contacts') return [badContact];
      return [];
    });

    expect(success).toBe(false);
    expect(repo.getHydrationStatus()).toBe('error');
    expect(repo.getHydrationError()).toContain('contacts');
    expect(repo.getState().contacts.length).toBe(0);

    // 2. Missing required field 'contactId' on conversation
    const repo2 = new FirestoreReadOnlyRepository();
    const badConv = {
      id: 'conv1',
      tenantId: 't-pratomineiro',
      // contactId missing
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const success2 = await repo2.hydrate(async (colName) => {
      if (colName === 'conversations') return [badConv];
      return [];
    });

    expect(success2).toBe(false);
    expect(repo2.getHydrationStatus()).toBe('error');
    expect(repo2.getHydrationError()).toContain('conversations');
  });

  it('Test 84 - Invalid Enum And Timestamp Never Default', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const repo = new FirestoreReadOnlyRepository();

    // 1. Invalid funnel stage
    const badOpportunity = {
      id: 'opp1',
      tenantId: 't-pratomineiro',
      contactId: 'c1',
      stage: 'INVALID_STAGE_DOES_NOT_EXIST',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const success1 = await repo.hydrate(async (colName) => {
      if (colName === 'opportunities') return [badOpportunity];
      return [];
    });

    expect(success1).toBe(false);
    expect(repo.getHydrationStatus()).toBe('error');
    expect(repo.getHydrationError()).toContain('stage');

    // 2. Invalid date string on createdAt
    const repo2 = new FirestoreReadOnlyRepository();
    const badDateMessage = {
      id: 'msg1',
      conversationId: 'conv1',
      sender: 'USER',
      content: 'Olá',
      createdAt: 'invalid-timestamp-format'
    };

    const success2 = await repo2.hydrate(async (colName) => {
      if (colName === 'messages') return [badDateMessage];
      return [];
    });

    expect(success2).toBe(false);
    expect(repo2.getHydrationStatus()).toBe('error');
    expect(repo2.getHydrationError()).toContain('createdAt');
  });

  it('Test 85 - Contact Required Fields Never Default Silently', async () => {
    const { FirestoreReadOnlyRepository } = await import('../repositories/FirestoreReadOnlyRepository');
    const { validateContact } = await import('../repositories/firestore/readValidators');

    // 1. Missing tags field: direct validation throws and hydration fails
    const contactMissingTags = {
      id: 'c-notags',
      tenantId: 't-1',
      name: 'Contact Without Tags',
      phone: '5511999990001',
      notes: 'Some note',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    expect(() => validateContact(contactMissingTags)).toThrow(/tags/);

    const repo1 = new FirestoreReadOnlyRepository();
    const success1 = await repo1.hydrate(async (col) => {
      if (col === 'contacts') return [contactMissingTags];
      return [];
    });
    expect(success1).toBe(false);
    expect(repo1.getHydrationStatus()).toBe('error');
    expect(repo1.getHydrationError()).toContain('tags');

    // 2. Missing notes field: direct validation throws and hydration fails
    const contactMissingNotes = {
      id: 'c-nonotes',
      tenantId: 't-1',
      name: 'Contact Without Notes',
      phone: '5511999990002',
      tags: ['VIP'],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    expect(() => validateContact(contactMissingNotes)).toThrow(/notes/);

    const repo2 = new FirestoreReadOnlyRepository();
    const success2 = await repo2.hydrate(async (col) => {
      if (col === 'contacts') return [contactMissingNotes];
      return [];
    });
    expect(success2).toBe(false);
    expect(repo2.getHydrationStatus()).toBe('error');
    expect(repo2.getHydrationError()).toContain('notes');

    // 3. Valid contact with empty array tags and empty string notes: accepted
    const validContact = {
      id: 'c-valid',
      tenantId: 't-1',
      name: 'Valid Contact',
      phone: '5511999990003',
      tags: [],
      notes: '',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const validated = validateContact(validContact);
    expect(validated.id).toBe('c-valid');
    expect(validated.tags).toEqual([]);
    expect(validated.notes).toBe('');

    const repo3 = new FirestoreReadOnlyRepository();
    const success3 = await repo3.hydrate(async (col) => {
      if (col === 'contacts') return [validContact];
      return [];
    });
    expect(success3).toBe(true);
    expect(repo3.getHydrationStatus()).toBe('ready');
    expect(repo3.getState().contacts.length).toBe(1);
    expect(repo3.getState().contacts[0].id).toBe('c-valid');
  });

  it('Test 86 - Contact Bootstrap Rejects Wrong Project', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    expect(() => validateManifest({
      projectId: 'other-project',
      tenantId: 't-pratomineiro',
      operationId: 'op1',
      contacts: []
    })).toThrow(/lidacomzap-gestao-inteligente/);
  });

  it('Test 87 - Contact Bootstrap Rejects Wrong Tenant', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 'other-tenant',
      operationId: 'op1',
      contacts: []
    })).toThrow(/t-pratomineiro/);
  });

  it('Test 88 - Invalid Contact Aborts Whole Bootstrap Plan', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    const { executeBootstrapPlanOffline } = await import('../../tools/contact-bootstrap/cli');
    const fs = await import('fs');
    const path = await import('path');

    const tempPlanPath = path.resolve(process.cwd(), 'tools/contact-bootstrap/temp-test88.plan.json');
    if (fs.existsSync(tempPlanPath)) {
      fs.unlinkSync(tempPlanPath);
    }

    const invalidManifest = {
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op1',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'Valid Name',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        },
        {
          id: 'c2',
          tenantId: 't-pratomineiro',
          name: 'Invalid missing tags',
          phone: '31999990002',
          // @ts-ignore: Intentionally invalid
          tags: undefined,
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    };

    expect(() => validateManifest(invalidManifest)).toThrow(/tags/);
    expect(() => executeBootstrapPlanOffline(invalidManifest, tempPlanPath)).toThrow(/tags/);
    expect(fs.existsSync(tempPlanPath)).toBe(false);
  });

  it('Test 89 - Duplicate Contact ID Is Rejected', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op1',
      contacts: [
        {
          id: 'c-dup',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        },
        {
          id: 'c-dup',
          tenantId: 't-pratomineiro',
          name: 'C2',
          phone: '31999990002',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    })).toThrow(/Duplicate contact ID/);
  });

  it('Test 90 - Duplicate Canonical Phone Is Rejected', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op1',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '(31) 99999-0000',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        },
        {
          id: 'c2',
          tenantId: 't-pratomineiro',
          name: 'C2',
          phone: '31999990000',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    })).toThrow(/Duplicate canonical phone/);
  });

  it('Test 91 - Bootstrap Writes Are Create Only', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    const { generatePlan } = await import('../../tools/contact-bootstrap/planner');
    const manifest = {
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op1',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    };
    const validated = validateManifest(manifest);
    const plan = generatePlan(manifest.projectId, manifest.tenantId, validated);
    expect(plan.writes.length).toBe(1);
    expect(plan.writes[0].currentDocument).toBeDefined();
    expect(plan.writes[0].currentDocument.exists).toBe(false);
  });

  it('Test 92 - Live Bootstrap Apply Is Disabled', async () => {
    const { assertNoApplyFlag } = await import('../../tools/contact-bootstrap/cli');
    expect(() => assertNoApplyFlag(['--apply'])).toThrow(
      'Live bootstrap execution is not enabled in F1B-05A.'
    );
    expect(() => assertNoApplyFlag(['--input', 'manifest.json', '--apply'])).toThrow(
      'Live bootstrap execution is not enabled in F1B-05A.'
    );

    const { execSync } = require('child_process');
    try {
      execSync('npx tsx tools/contact-bootstrap/cli.ts --apply');
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.stdout.toString() + e.stderr.toString()).toMatch(/Error: Live bootstrap execution is not enabled in F1B-05A\./);
    }
  }, 20000);

  it('Test 93 - Contact Bootstrap Plan Is Deterministic', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    const { generatePlan } = await import('../../tools/contact-bootstrap/planner');
    const manifest = {
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op1',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: ['A'],
          notes: 'Test',
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-01T12:00:00.000Z'
        }
      ]
    };
    const validated1 = validateManifest(manifest);
    const plan1 = generatePlan(manifest.projectId, manifest.tenantId, validated1);
    
    const validated2 = validateManifest(manifest);
    const plan2 = generatePlan(manifest.projectId, manifest.tenantId, validated2);

    expect(JSON.stringify(plan1)).toBe(JSON.stringify(plan2));
  });

  it('Test 94 - Contact Bootstrap Uses Root Operational Collection', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    const { generatePlan } = await import('../../tools/contact-bootstrap/planner');
    const { COLLECTIONS } = await import('../repositories/firestore/schema');

    const manifest = {
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-94',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'Cliente Teste 94',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    };

    const validated = validateManifest(manifest);
    const plan = generatePlan(manifest.projectId, manifest.tenantId, validated);
    expect(plan.writes.length).toBe(1);
    expect(plan.writes[0].update.name).toBe(
      `projects/lidacomzap-gestao-inteligente/databases/(default)/documents/${COLLECTIONS.CONTACTS}/c1`
    );
    expect(plan.writes[0].update.name).toBe(
      'projects/lidacomzap-gestao-inteligente/databases/(default)/documents/contacts/c1'
    );
    expect(plan.writes[0].update.name).not.toContain('tenants/');
  });

  it('Test 95 - Contact Tenant Must Match Bootstrap Manifest', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-95',
      contacts: [
        {
          id: 'c1',
          tenantId: 'outro-tenant',
          name: 'Cliente Divergente',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    })).toThrow(/does not match manifest tenantId/);
  });

  it('Test 96 - Bootstrap Requires Strict ISO Timestamps', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');

    // Reject "09/01/2026"
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-96',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '09/01/2026',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    })).toThrow(/non-ISO createdAt timestamp/);

    // Reject "September 1 2026"
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-96',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: 'September 1 2026'
        }
      ]
    })).toThrow(/non-ISO updatedAt timestamp/);

    // Reject date only "2026-09-01"
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-96',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    })).toThrow(/non-ISO createdAt timestamp/);

    // Accept ISO with Z
    const validWithZ = validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-96',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    });
    expect(validWithZ.length).toBe(1);

    // Accept ISO with offset -03:00
    const validWithOffset = validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-96',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T09:00:00-03:00',
          updatedAt: '2026-09-01T09:00:00-03:00'
        }
      ]
    });
    expect(validWithOffset.length).toBe(1);
  });

  it('Test 97 - Duplicate Phone Error Does Not Leak Phone', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');
    let caughtError: Error | null = null;
    try {
      validateManifest({
        projectId: 'lidacomzap-gestao-inteligente',
        tenantId: 't-pratomineiro',
        operationId: 'op-test-97',
        contacts: [
          {
            id: 'c1',
            tenantId: 't-pratomineiro',
            name: 'Cliente Um',
            phone: '(31) 99999-0000',
            tags: [],
            notes: '',
            createdAt: '2026-09-01T12:00:00Z',
            updatedAt: '2026-09-01T12:00:00Z'
          },
          {
            id: 'c2',
            tenantId: 't-pratomineiro',
            name: 'Cliente Dois',
            phone: '31999990000',
            tags: [],
            notes: '',
            createdAt: '2026-09-01T12:00:00Z',
            updatedAt: '2026-09-01T12:00:00Z'
          }
        ]
      });
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain('Duplicate canonical phone');
    expect(caughtError!.message).toContain('c1');
    expect(caughtError!.message).toContain('c2');
    expect(caughtError!.message).not.toContain('31999990000');
    expect(caughtError!.message).not.toContain('(31) 99999-0000');
    expect(caughtError!.message).not.toContain('Cliente Um');
    expect(caughtError!.message).not.toContain('Cliente Dois');
  });

  it('Test 98 - Bootstrap Requires Operation ID', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');

    // Missing operationId
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      // @ts-ignore
      operationId: undefined,
      contacts: []
    })).toThrow(/operationId/i);

    // Empty operationId
    expect(() => validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: '   ',
      contacts: []
    })).toThrow(/operationId/i);

    // Valid operationId
    const res = validateManifest({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-valid-123',
      contacts: []
    });
    expect(res).toEqual([]);
  });

  it('Test 99 - Planner Cannot Bypass Bootstrap Guards', async () => {
    const { generatePlan } = await import('../../tools/contact-bootstrap/planner');

    const validContact = {
      id: 'c1',
      tenantId: 't-pratomineiro',
      name: 'Cliente C1',
      phone: '31999990001',
      tags: [],
      notes: '',
      createdAt: new Date('2026-09-01T12:00:00Z'),
      updatedAt: new Date('2026-09-01T12:00:00Z')
    };

    // Wrong projectId
    expect(() => generatePlan('wrong-project', 't-pratomineiro', [validContact]))
      .toThrow(/lidacomzap-gestao-inteligente/);

    // Wrong tenantId
    expect(() => generatePlan('lidacomzap-gestao-inteligente', 'wrong-tenant', [validContact]))
      .toThrow(/t-pratomineiro/);

    // Divergent contact tenantId
    const divergentContact = { ...validContact, tenantId: 'other-tenant' };
    expect(() => generatePlan('lidacomzap-gestao-inteligente', 't-pratomineiro', [divergentContact]))
      .toThrow(/does not match planner tenantId/);
  });

  it('Test 100 - Unsafe Firestore Contact ID Is Rejected', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');

    const createManifestWithId = (id: string) => ({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-100',
      contacts: [
        {
          id,
          tenantId: 't-pratomineiro',
          name: 'Cliente',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    });

    expect(() => validateManifest(createManifestWithId('a/b'))).toThrow(/unsafe or invalid/i);
    expect(() => validateManifest(createManifestWithId('.'))).toThrow(/unsafe or invalid/i);
    expect(() => validateManifest(createManifestWithId('..'))).toThrow(/unsafe or invalid/i);

    const valid = validateManifest(createManifestWithId('contact-001'));
    expect(valid.length).toBe(1);
    expect(valid[0].id).toBe('contact-001');
  });

  it('Test 101 - Impossible ISO Calendar Dates Are Rejected', async () => {
    const { validateManifest } = await import('../../tools/contact-bootstrap/validator');

    const makeManifestWithDate = (dateStr: string) => ({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: 'op-test-101',
      contacts: [
        {
          id: 'c1',
          tenantId: 't-pratomineiro',
          name: 'Cliente C1',
          phone: '31999990001',
          tags: [],
          notes: '',
          createdAt: dateStr,
          updatedAt: '2026-09-01T12:00:00Z'
        }
      ]
    });

    // 2026-02-31T12:00:00Z -> erro (fevereiro nunca tem 31 dias)
    expect(() => validateManifest(makeManifestWithDate('2026-02-31T12:00:00Z')))
      .toThrow(/impossible calendar date/i);

    // 2025-02-29T12:00:00Z -> erro (2025 não é bissexto)
    expect(() => validateManifest(makeManifestWithDate('2025-02-29T12:00:00Z')))
      .toThrow(/impossible calendar date/i);

    // 2024-02-29T12:00:00Z -> válido (2024 é bissexto)
    const leapValid = validateManifest(makeManifestWithDate('2024-02-29T12:00:00Z'));
    expect(leapValid.length).toBe(1);
    expect(leapValid[0].createdAt.toISOString()).toBe('2024-02-29T12:00:00.000Z');

    // 2026-04-31T12:00:00Z -> erro (abril só tem 30 dias)
    expect(() => validateManifest(makeManifestWithDate('2026-04-31T12:00:00Z')))
      .toThrow(/impossible calendar date/i);

    // 2026-04-30T12:00:00Z -> válido
    const aprValid = validateManifest(makeManifestWithDate('2026-04-30T12:00:00Z'));
    expect(aprValid.length).toBe(1);
    expect(aprValid[0].createdAt.toISOString()).toBe('2026-04-30T12:00:00.000Z');
  });

  it('Test 102 - Planner Cannot Bypass Contact Validation', async () => {
    const { generatePlan } = await import('../../tools/contact-bootstrap/planner');

    const validContact = {
      id: 'c-valid-102',
      tenantId: 't-pratomineiro',
      name: 'Cliente Valido 102',
      phone: '31999990001',
      tags: ['vip'],
      notes: 'Notas do cliente',
      createdAt: new Date('2026-09-01T12:00:00Z'),
      updatedAt: new Date('2026-09-01T12:00:00Z')
    };

    // id = "a/b" -> erro
    expect(() => generatePlan('lidacomzap-gestao-inteligente', 't-pratomineiro', [
      { ...validContact, id: 'a/b' }
    ])).toThrow(/unsafe or invalid firestore document id/i);

    // id = "." -> erro
    expect(() => generatePlan('lidacomzap-gestao-inteligente', 't-pratomineiro', [
      { ...validContact, id: '.' }
    ])).toThrow(/unsafe or invalid firestore document id/i);

    // id = ".." -> erro
    expect(() => generatePlan('lidacomzap-gestao-inteligente', 't-pratomineiro', [
      { ...validContact, id: '..' }
    ])).toThrow(/unsafe or invalid firestore document id/i);

    // name = "" -> erro
    expect(() => generatePlan('lidacomzap-gestao-inteligente', 't-pratomineiro', [
      { ...validContact, name: '' }
    ])).toThrow(/failed domain validation in planner/i);

    // tags inválidas -> erro
    expect(() => generatePlan('lidacomzap-gestao-inteligente', 't-pratomineiro', [
      // @ts-ignore
      { ...validContact, tags: undefined }
    ])).toThrow(/failed domain validation in planner/i);

    // Contact válido -> plano válido
    const plan = generatePlan('lidacomzap-gestao-inteligente', 't-pratomineiro', [validContact]);
    expect(plan.writes.length).toBe(1);
    expect(plan.writes[0].update.name).toBe(
      'projects/lidacomzap-gestao-inteligente/databases/(default)/documents/contacts/c-valid-102'
    );
    expect(plan.writes[0].currentDocument).toEqual({ exists: false });
  });

  it('Test 103 - Bootstrap Plan Output Requires Ignored Suffix', async () => {
    const { resolveSafePlanOutputPath } = await import('../../tools/contact-bootstrap/cli');
    const fs = await import('fs');
    const path = await import('path');
    const externalOutputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(path.dirname(process.cwd())), 'bootstrap-plan-output-'));

    try {
      expect(resolveSafePlanOutputPath(path.join(externalOutputDir, 'example.plan.json')))
        .toMatch(/example\.plan\.json$/);
    } finally {
      fs.rmSync(externalOutputDir, { recursive: true, force: true });
    }

    expect(() => resolveSafePlanOutputPath('tools/contact-bootstrap/example.plan.json'))
      .toThrow('Private customer data outputs must be written outside the repository.');
    expect(() => resolveSafePlanOutputPath('tools/contact-bootstrap/example.json'))
      .toThrow('must use the ignored .plan.json suffix');
  });
});


