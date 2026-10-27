import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDurableWebhookIngressStore } from '../../services/channel-gateway/ingress';
import type { AdmitInboundItemInput, InboundWorkItem } from '../../services/channel-gateway/ingress';

describe('F1B-11 Persistence Design Offline Contracts', () => {
  let store: InMemoryDurableWebhookIngressStore;

  beforeEach(() => {
    store = new InMemoryDurableWebhookIngressStore();
  });

  const baseInput: AdmitInboundItemInput = {
    idempotencyKey: 'idem-1',
    workItemId: 'work-1',
    provider: 'WHATSAPP_META_OFFICIAL',
    providerEventId: 'meta:message:entry-1:msg-1',
    rawEventKind: 'message',
    event: {
      internalEventId: 'event-1',
      occurredAt: new Date(),
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      eventType: 'INBOUND_MESSAGE',
      payload: {
        content: { contentType: 'TEXT', text: 'Sensitive message body' }
      }
    },
    admittedAt: new Date()
  };

  it('1. admission + work atomicity contract', () => {
    const result = store.admit(baseInput);
    expect(result.disposition).toBe('ADMITTED');
    expect(result.admission).toBeDefined();
    expect(result.workItem).toBeDefined();
    expect(result.workItem?.state).toBe('QUEUED');
    
    // Both admission and work item are available together
    expect(store.getAdmission('idem-1')).toBeDefined();
    expect(store.get('work-1')).toBeDefined();
  });

  it('2. duplicate admission', () => {
    store.admit(baseInput);
    const result2 = store.admit(baseInput);
    expect(result2.disposition).toBe('DUPLICATE');
    expect(result2.admission).toBeDefined();
  });

  it('3. already processing', () => {
    store.admit(baseInput);
    store.reserve('work-1', 'owner-A', new Date(), 30000);
    const result2 = store.admit(baseInput);
    expect(result2.disposition).toBe('ALREADY_PROCESSING');
  });

  it('4. lease ownership', () => {
    store.admit(baseInput);
    const reserve1 = store.reserve('work-1', 'owner-A', new Date(), 30000);
    expect(reserve1.status).toBe('RESERVED');
    expect(reserve1.record?.ownerId).toBe('owner-A');

    // A second worker should not be able to reserve it
    const reserve2 = store.reserve('work-1', 'owner-B', new Date(), 30000);
    expect(reserve2.status).toBe('NOT_AVAILABLE');
  });

  it('5. lease expiry recovery', () => {
    store.admit(baseInput);
    const now = new Date();
    store.reserve('work-1', 'owner-A', now, 30000);
    
    // Time advances past lease
    const future = new Date(now.getTime() + 30001);
    const reserve2 = store.reserve('work-1', 'owner-B', future, 30000);
    expect(reserve2.status).toBe('RESERVED');
    expect(reserve2.record?.ownerId).toBe('owner-B');
  });

  it('6. ack ownership', () => {
    store.admit(baseInput);
    store.reserve('work-1', 'owner-A', new Date(), 30000);
    
    expect(() => store.ack('work-1', 'owner-B', new Date())).toThrow('INBOUND_WORK_OWNER_MISMATCH');
    
    const ackResult = store.ack('work-1', 'owner-A', new Date());
    expect(ackResult.state).toBe('COMPLETED');
  });

  it('7. nack retry scheduling', () => {
    store.admit(baseInput);
    const now = new Date();
    store.reserve('work-1', 'owner-A', now, 30000);
    
    const nackResult = store.nack('work-1', 'owner-A', now, 'TRANSIENT_ERROR', {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 5000
    });
    
    expect(nackResult.state).toBe('FAILED_RETRYABLE');
    expect(nackResult.nextAttemptAt).toBeDefined();
    expect(nackResult.attempt).toBe(1);
    
    // Ensure it cannot be reserved immediately
    expect(store.reserve('work-1', 'owner-B', now, 30000).status).toBe('NOT_AVAILABLE');
    
    // Ensure it can be reserved after nextAttemptAt
    const future = new Date(nackResult.nextAttemptAt!.getTime() + 1);
    expect(store.reserve('work-1', 'owner-B', future, 30000).status).toBe('RESERVED');
  });

  it('8. final failure', () => {
    store.admit(baseInput);
    store.reserve('work-1', 'owner-A', new Date(), 30000);
    
    const failResult = store.failFinal('work-1', 'owner-A', new Date(), 'PERMANENT_ERROR');
    expect(failResult.state).toBe('FAILED_FINAL');
    
    const result2 = store.admit(baseInput);
    expect(result2.disposition).toBe('FINAL_REJECTED');
  });

  it('9. worker crash recovery semantics', () => {
    store.admit(baseInput);
    const now = new Date();
    store.reserve('work-1', 'owner-A', now, 30000);
    
    // Worker A crashes before ack. Time advances.
    const future = new Date(now.getTime() + 40000);
    // Worker B recovers it.
    const reserve2 = store.reserve('work-1', 'owner-B', future, 30000);
    expect(reserve2.status).toBe('RESERVED');
    expect(reserve2.record?.attempt).toBe(2);
  });

  it('10. replay after admission', () => {
    store.admit(baseInput);
    // Crash happens. Replay the same input:
    const replay = store.admit(baseInput);
    expect(replay.disposition).toBe('DUPLICATE');
  });

  it('11. replay after completion', () => {
    store.admit(baseInput);
    store.reserve('work-1', 'owner-A', new Date(), 30000);
    store.ack('work-1', 'owner-A', new Date());
    
    const replay = store.admit(baseInput);
    expect(replay.disposition).toBe('DUPLICATE');
  });

  it('12. no duplicate business processing contract', () => {
    store.admit(baseInput);
    store.reserve('work-1', 'owner-A', new Date(), 30000);
    
    // Replay occurs while processing
    const replay = store.admit(baseInput);
    expect(replay.disposition).toBe('ALREADY_PROCESSING');
    
    // Replay occurs after ack
    store.ack('work-1', 'owner-A', new Date());
    const replayAfterAck = store.admit(baseInput);
    expect(replayAfterAck.disposition).toBe('DUPLICATE');
  });

  it('13. batch record consistency', () => {
    const batchResult = store.recordBatch({
      ingressBatchId: 'batch-1',
      correlationId: 'corr-1',
      result: {
        requestId: 'req-1',
        batchId: 'batch-1',
        provider: 'WHATSAPP_META_OFFICIAL',
        receivedAt: new Date(),
        totalItemCount: 1,
        admittedCount: 1,
        duplicateCount: 0,
        alreadyProcessingCount: 0,
        finalRejectedCount: 0,
        unsupportedCount: 0,
        retryableFailureCount: 0,
        items: [
          {
            itemId: 'item-1',
            disposition: 'ADMITTED',
            reasonCode: 'OK',
            rawEventKind: 'message'
          }
        ]
      }
    });
    expect(batchResult.correlationId).toBe('corr-1');
    expect(store.getBatch('batch-1')).toBeDefined();
  });

  it('14. sensitive payload observability boundary', () => {
    const batchResult = store.recordBatch({
      ingressBatchId: 'batch-2',
      correlationId: 'corr-2',
      result: {
        requestId: 'req-2',
        batchId: 'batch-2',
        provider: 'WHATSAPP_META_OFFICIAL',
        receivedAt: new Date(),
        totalItemCount: 1,
        admittedCount: 1,
        duplicateCount: 0,
        alreadyProcessingCount: 0,
        finalRejectedCount: 0,
        unsupportedCount: 0,
        retryableFailureCount: 0,
        items: [
          {
            itemId: 'item-1',
            disposition: 'ADMITTED',
            reasonCode: 'OK',
            rawEventKind: 'message'
            // NOTE: event payload is NOT included in the batch record
          }
        ]
      }
    });
    
    // Sensitive payload is kept in the work queue, not in the batch result
    expect((batchResult.items[0] as any).event).toBeUndefined();
  });

  it('15. Firebase independence of gateway', () => {
    // Assert that the channel gateway modules do not expose Firebase
    expect(store).not.toHaveProperty('firestore');
    expect(store).not.toHaveProperty('firebaseApp');
  });

});
