import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryDurableWebhookIngressStore,
  type AdmitInboundItemInput,
  type InboundWorkQueue
} from '../../services/channel-gateway/ingress';
import {
  dispatchNextInboundWorkItem,
  type InboundWorkerStepInput
} from '../../services/channel-gateway/inboundWorker';

const startedAt = new Date('2026-09-11T12:00:00.000Z');

function messageInput(
  workItemId: string,
  idempotencyKey: string,
  admittedAt = startedAt
): AdmitInboundItemInput {
  return {
    idempotencyKey,
    workItemId,
    provider: 'WHATSAPP_META_OFFICIAL',
    providerEventId: `event-${workItemId}`,
    rawEventKind: 'message',
    event: {
      internalEventId: `internal-${workItemId}`,
      occurredAt: admittedAt,
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      eventType: 'INBOUND_MESSAGE',
      payload: {
        providerAddress: '+15555550123',
        externalConversationId: 'synthetic-conversation',
        content: { contentType: 'TEXT', text: 'Sensitive worker message body' }
      }
    },
    admittedAt
  };
}

function statusInput(
  workItemId: string,
  idempotencyKey: string,
  admittedAt = startedAt
): AdmitInboundItemInput {
  return {
    idempotencyKey,
    workItemId,
    provider: 'WHATSAPP_META_OFFICIAL',
    providerEventId: `event-${workItemId}`,
    rawEventKind: 'status',
    event: {
      internalEventId: `internal-${workItemId}`,
      occurredAt: admittedAt,
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      eventType: 'DELIVERY_STATUS',
      payload: { deliveryStatus: 'DELIVERED', providerTimestamp: '1725451205' }
    },
    admittedAt
  };
}

function workerInput(
  queue: InboundWorkQueue,
  overrides: Partial<InboundWorkerStepInput> = {}
): InboundWorkerStepInput {
  return {
    queue,
    contactIdentityResolver: {
      resolve: () => ({ status: 'RESOLVED_EXISTING', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    },
    conversationResolver: {
      resolve: () => ({ status: 'RESOLVED_EXISTING', conversationId: 'conversation-1' })
    },
    commandHandler: { handle: () => ({ status: 'COMPLETED' }) },
    ownerId: 'offline-worker-a',
    now: startedAt,
    leaseDurationMs: 30_000,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    ...overrides
  };
}

describe('F1B-12 Inbound Worker Kernel Offline', () => {
  it('atomically claims the deterministic next eligible item without a batch record', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-b', 'idem-b'));
    store.admit(messageInput('work-a', 'idem-a'));

    const reserved = store.reserveNext({
      ownerId: 'offline-worker-a',
      now: startedAt,
      leaseDurationMs: 30_000
    });

    expect(reserved).toMatchObject({ status: 'RESERVED', record: { workItemId: 'work-a', state: 'RESERVED' } });
    expect(store.getAdmission('idem-a')?.state).toBe('PROCESSING');
    expect(store.getAdmission('idem-b')?.state).toBe('ADMITTED');
  });

  it('resolves existing references, invokes the command handler, then acknowledges success', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-success', 'idem-success'));
    const handler = vi.fn((execution: {
      workItemId: string;
      idempotencyKey: string;
      resolvedReferences?: unknown;
    }) => {
      expect(store.get(execution.workItemId)?.state).toBe('RESERVED');
      expect(execution.idempotencyKey).toBe('idem-success');
      expect(execution.resolvedReferences).toEqual({
        contactId: 'contact-1', contactIdentityId: 'identity-1', conversationId: 'conversation-1'
      });
      return { status: 'COMPLETED' as const };
    });

    const result = dispatchNextInboundWorkItem(workerInput(store, { commandHandler: { handle: handler } }));

    expect(result).toEqual({
      status: 'COMPLETED',
      reasonCode: 'EVENT_ACCEPTED',
      workItemId: 'work-success',
      commandType: 'InboundMessageReceived'
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(store.get('work-success')?.state).toBe('COMPLETED');
  });

  it('fails closed when a handler returns a non-contract reason code', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-invalid-handler', 'idem-invalid-handler'));

    const result = dispatchNextInboundWorkItem(workerInput(store, {
      commandHandler: {
        handle: () => ({ status: 'RETRYABLE_FAILURE', reasonCode: 'SENSITIVE_HANDLER_DETAIL' } as never)
      }
    }));

    expect(result).toEqual({
      status: 'FAILED_RETRYABLE', reasonCode: 'COMMAND_HANDLER_FAILED', workItemId: 'work-invalid-handler'
    });
    expect(store.get('work-invalid-handler')?.state).toBe('FAILED_RETRYABLE');
  });

  it('processes message and status work through the same provider-neutral kernel', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-message', 'idem-message', startedAt));
    store.admit(statusInput('work-status', 'idem-status', new Date(startedAt.getTime() + 1)));
    const contactIdentityResolver = { resolve: vi.fn(() => ({
      status: 'RESOLVED_EXISTING' as const, contactId: 'contact-1', contactIdentityId: 'identity-1'
    })) };
    const conversationResolver = { resolve: vi.fn(() => ({
      status: 'RESOLVED_EXISTING' as const, conversationId: 'conversation-1'
    })) };
    const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));
    const input = workerInput(store, { contactIdentityResolver, conversationResolver, commandHandler: { handle: handler } });

    const first = dispatchNextInboundWorkItem(input);
    const second = dispatchNextInboundWorkItem(input);

    expect([first.commandType, second.commandType]).toEqual(['InboundMessageReceived', 'MessageDeliveryUpdated']);
    expect(contactIdentityResolver.resolve).toHaveBeenCalledOnce();
    expect(conversationResolver.resolve).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('keeps an active lease exclusive and recovers the item after lease expiry', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-recovery', 'idem-recovery'));
    store.reserve('work-recovery', 'offline-worker-a', startedAt, 30_000);
    const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

    const blocked = dispatchNextInboundWorkItem(workerInput(store, {
      ownerId: 'offline-worker-b',
      now: new Date(startedAt.getTime() + 1),
      commandHandler: { handle: handler }
    }));
    const recovered = dispatchNextInboundWorkItem(workerInput(store, {
      ownerId: 'offline-worker-b',
      now: new Date(startedAt.getTime() + 30_001),
      commandHandler: { handle: handler }
    }));

    expect(blocked).toEqual({ status: 'NOT_AVAILABLE', reasonCode: 'WORK_NOT_AVAILABLE' });
    expect(recovered).toMatchObject({ status: 'COMPLETED', workItemId: 'work-recovery' });
    expect(handler).toHaveBeenCalledOnce();
    expect(store.get('work-recovery')?.attempt).toBe(2);
  });

  it('records retryable failure and permits a later explicit final failure', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-failure', 'idem-failure'));
    const retry = dispatchNextInboundWorkItem(workerInput(store, {
      commandHandler: { handle: () => ({ status: 'RETRYABLE_FAILURE', reasonCode: 'PROVIDER_UNAVAILABLE' }) }
    }));
    const final = dispatchNextInboundWorkItem(workerInput(store, {
      now: new Date(startedAt.getTime() + 101),
      commandHandler: { handle: () => ({ status: 'FINAL_FAILURE', reasonCode: 'IDENTITY_REJECTED' }) }
    }));

    expect(retry).toEqual({
      status: 'FAILED_RETRYABLE', reasonCode: 'PROVIDER_UNAVAILABLE', workItemId: 'work-failure'
    });
    expect(final).toEqual({
      status: 'FAILED_FINAL', reasonCode: 'IDENTITY_REJECTED', workItemId: 'work-failure'
    });
    expect(store.get('work-failure')?.state).toBe('FAILED_FINAL');
  });

  it('does not create or dispatch an inbound message when existing identity resolution fails', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-unresolved', 'idem-unresolved'));
    const conversationResolver = { resolve: vi.fn() };
    const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

    const result = dispatchNextInboundWorkItem(workerInput(store, {
      contactIdentityResolver: { resolve: () => ({ status: 'NOT_FOUND' }) },
      conversationResolver,
      commandHandler: { handle: handler }
    }));

    expect(result).toEqual({
      status: 'FAILED_RETRYABLE', reasonCode: 'IDENTITY_NOT_FOUND', workItemId: 'work-unresolved'
    });
    expect(conversationResolver.resolve).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(store.get('work-unresolved')?.state).toBe('FAILED_RETRYABLE');
  });

  it('leaves acknowledgement unconfirmed without leaking sensitive command data', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-ack', 'idem-ack'));
    const queue: InboundWorkQueue = {
      enqueue: store.enqueue.bind(store),
      reserve: store.reserve.bind(store),
      reserveNext: store.reserveNext.bind(store),
      ack: () => { throw new Error('SYNTHETIC_ACK_FAILURE'); },
      nack: store.nack.bind(store),
      failFinal: store.failFinal.bind(store),
      get: store.get.bind(store),
      list: store.list.bind(store)
    };

    const result = dispatchNextInboundWorkItem(workerInput(queue));

    expect(result).toMatchObject({
      status: 'ACKNOWLEDGMENT_UNCONFIRMED', reasonCode: 'ACKNOWLEDGMENT_UNCONFIRMED', workItemId: 'work-ack'
    });
    expect(store.get('work-ack')?.state).toBe('RESERVED');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Sensitive worker message body');
    expect(serialized).not.toContain('+15555550123');
    expect(serialized).not.toContain('idem-ack');
  });

  it('fails closed for invalid worker configuration before claiming work', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(messageInput('work-invalid', 'idem-invalid'));

    expect(() => dispatchNextInboundWorkItem(workerInput(store, { ownerId: ' ' })))
      .toThrow('INVALID_INBOUND_WORKER_INPUT');
    expect(store.get('work-invalid')?.state).toBe('QUEUED');
  });
});
