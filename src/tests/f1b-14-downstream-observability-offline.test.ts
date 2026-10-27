import { describe, expect, it, vi } from 'vitest';
import { createGatewayCommand } from '../../services/channel-gateway/command';
import type { GatewayEventType, NormalizedChannelEvent } from '../../services/channel-gateway/contracts';
import {
  InMemoryDownstreamExecutionJournal,
  OfflineIdempotentCommandHandler
} from '../../services/channel-gateway/downstream';
import { dispatchNextInboundWorkItem } from '../../services/channel-gateway/inboundWorker';
import {
  InMemoryDurableWebhookIngressStore,
  type AdmitInboundItemInput,
  type InboundWorkQueue
} from '../../services/channel-gateway/ingress';
import {
  InMemoryGatewayOperationalEventSink,
  type GatewayOperationalEventSink
} from '../../services/channel-gateway/operability';

const now = new Date('2026-09-17T12:00:00.000Z');

function event(eventType: GatewayEventType, suffix: string): NormalizedChannelEvent {
  return {
    internalEventId: `internal-${suffix}`,
    provider: 'WHATSAPP_META_OFFICIAL',
    channel: 'WHATSAPP',
    occurredAt: now,
    eventType,
    payload: eventType === 'INBOUND_MESSAGE'
      ? {
          providerAddress: '+15555550123',
          externalConversationId: 'synthetic-conversation',
          content: { contentType: 'TEXT', text: 'Sensitive synthetic message' }
        }
      : {}
  };
}

function execution(eventType: GatewayEventType, suffix: string) {
  return {
    workItemId: `work-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    attempt: 1,
    command: createGatewayCommand(event(eventType, suffix))
  };
}

function admittedMessage(suffix: string): AdmitInboundItemInput {
  return {
    workItemId: `work-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    admittedAt: now,
    provider: 'WHATSAPP_META_OFFICIAL',
    providerEventId: `provider-${suffix}`,
    rawEventKind: 'message',
    event: event('INBOUND_MESSAGE', suffix)
  };
}

function runWorker(
  store: InMemoryDurableWebhookIngressStore,
  handler: OfflineIdempotentCommandHandler,
  overrides: { queue?: InboundWorkQueue; sink?: GatewayOperationalEventSink } = {}
) {
  return dispatchNextInboundWorkItem({
    queue: overrides.queue ?? store,
    contactIdentityResolver: {
      resolve: () => ({ status: 'RESOLVED', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    },
    conversationResolver: {
      resolve: () => ({ status: 'EXISTING_CONVERSATION', conversationId: 'conversation-1' })
    },
    commandHandler: handler,
    ownerId: 'offline-worker-f1b-14',
    now,
    leaseDurationMs: 30_000,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    ...(overrides.sink ? { operationalEventSink: overrides.sink } : {})
  });
}

describe('F1B-14 downstream pipeline and safe observability offline', () => {
  it('routes all seven provider-neutral command variants through one boundary', () => {
    const journal = new InMemoryDownstreamExecutionJournal();
    const observedTypes: string[] = [];
    const processor = vi.fn((input: ReturnType<typeof execution>) => {
      observedTypes.push(input.command.type);
      return { status: 'COMPLETED' as const };
    });
    const handler = new OfflineIdempotentCommandHandler({ journal, processor: { process: processor }, now: () => now });
    const eventTypes: GatewayEventType[] = [
      'INBOUND_MESSAGE', 'OUTBOUND_MESSAGE_OBSERVED', 'DELIVERY_STATUS', 'READ_STATUS',
      'CAPABILITY_UPDATE', 'SUBSCRIPTION_UPDATE', 'PROVIDER_STATUS'
    ];

    const results = eventTypes.map((eventType, index) => handler.handle(execution(eventType, String(index))));

    expect(results).toEqual(eventTypes.map(() => ({ status: 'COMPLETED' })));
    expect(processor).toHaveBeenCalledTimes(7);
    expect(observedTypes).toEqual([
      'InboundMessageReceived', 'OutboundMessageObserved', 'MessageDeliveryUpdated',
      'MessageReadUpdated', 'ChannelCapabilityUpdated', 'ChannelSubscriptionUpdated',
      'ProviderStatusObserved'
    ]);
  });

  it('does not invoke the processor again after a completed idempotency key', () => {
    const journal = new InMemoryDownstreamExecutionJournal();
    const processor = vi.fn(() => ({ status: 'COMPLETED' as const }));
    const sink = new InMemoryGatewayOperationalEventSink();
    const handler = new OfflineIdempotentCommandHandler({
      journal,
      processor: { process: processor },
      now: () => now,
      operationalEventSink: sink
    });
    const input = execution('INBOUND_MESSAGE', 'replay');

    expect(handler.handle(input)).toEqual({ status: 'COMPLETED' });
    expect(handler.handle({ ...input, attempt: 2 })).toEqual({ status: 'COMPLETED' });
    expect(processor).toHaveBeenCalledOnce();
    expect(journal.get(input.idempotencyKey)).toMatchObject({ state: 'COMPLETED', attempt: 1 });
    expect(JSON.stringify(journal.get(input.idempotencyKey))).not.toContain('Sensitive synthetic message');
    expect(JSON.stringify(journal.get(input.idempotencyKey))).not.toContain('+15555550123');
    expect(sink.list()).toHaveLength(2);
    expect(sink.list()[1]).toMatchObject({
      stage: 'DOWNSTREAM_IDEMPOTENCY', outcome: 'SUCCESS',
      reasonCode: 'DOWNSTREAM_DUPLICATE', duplicate: true
    });
  });

  it('reprocesses retryable failures and then completes', () => {
    const journal = new InMemoryDownstreamExecutionJournal();
    const processor = vi.fn()
      .mockReturnValueOnce({ status: 'RETRYABLE_FAILURE', reasonCode: 'PROVIDER_UNAVAILABLE' })
      .mockReturnValueOnce({ status: 'COMPLETED' });
    const handler = new OfflineIdempotentCommandHandler({ journal, processor: { process: processor }, now: () => now });
    const input = execution('DELIVERY_STATUS', 'retry');

    expect(handler.handle(input)).toEqual({ status: 'RETRYABLE_FAILURE', reasonCode: 'PROVIDER_UNAVAILABLE' });
    expect(journal.get(input.idempotencyKey)?.state).toBe('FAILED_RETRYABLE');
    expect(handler.handle({ ...input, attempt: 2 })).toEqual({ status: 'COMPLETED' });
    expect(journal.get(input.idempotencyKey)).toMatchObject({ state: 'COMPLETED', attempt: 2 });
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it('preserves final failure and rejects a key collision without reprocessing', () => {
    const journal = new InMemoryDownstreamExecutionJournal();
    const processor = vi.fn(() => ({ status: 'FINAL_FAILURE' as const, reasonCode: 'NON_RETRYABLE' as const }));
    const handler = new OfflineIdempotentCommandHandler({ journal, processor: { process: processor }, now: () => now });
    const input = execution('PROVIDER_STATUS', 'final');

    expect(handler.handle(input)).toEqual({ status: 'FINAL_FAILURE', reasonCode: 'NON_RETRYABLE' });
    expect(handler.handle({ ...input, attempt: 2 })).toEqual({ status: 'FINAL_FAILURE', reasonCode: 'NON_RETRYABLE' });
    expect(handler.handle({ ...input, workItemId: 'different-work', attempt: 3 }))
      .toEqual({ status: 'FINAL_FAILURE', reasonCode: 'NON_RETRYABLE' });
    expect(processor).toHaveBeenCalledOnce();
  });

  it('converts exceptions and invalid results to a safe retryable failure', () => {
    const journal = new InMemoryDownstreamExecutionJournal();
    const throwing = new OfflineIdempotentCommandHandler({
      journal,
      processor: { process: () => { throw new Error('sensitive internal detail'); } },
      now: () => now
    });
    const first = execution('READ_STATUS', 'unsafe');

    expect(throwing.handle(first)).toEqual({
      status: 'RETRYABLE_FAILURE', reasonCode: 'UNKNOWN_PROVIDER_ERROR'
    });
    expect(journal.get(first.idempotencyKey)).toMatchObject({
      state: 'FAILED_RETRYABLE', reasonCode: 'UNKNOWN_PROVIDER_ERROR'
    });

    const invalid = new OfflineIdempotentCommandHandler({
      journal: new InMemoryDownstreamExecutionJournal(),
      processor: { process: () => ({ status: 'unexpected' }) as never },
      now: () => now
    });
    expect(invalid.handle(execution('READ_STATUS', 'invalid'))).toEqual({
      status: 'RETRYABLE_FAILURE', reasonCode: 'UNKNOWN_PROVIDER_ERROR'
    });
  });

  it('runs resolution, downstream processing and acknowledgement in order', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(admittedMessage('order'));
    const order: string[] = [];
    const queue: InboundWorkQueue = {
      enqueue: store.enqueue.bind(store),
      reserve: store.reserve.bind(store),
      reserveNext: store.reserveNext.bind(store),
      ack: (...args) => { order.push('ack'); return store.ack(...args); },
      nack: store.nack.bind(store),
      failFinal: store.failFinal.bind(store),
      get: store.get.bind(store),
      list: store.list.bind(store)
    };
    const handler = new OfflineIdempotentCommandHandler({
      journal: new InMemoryDownstreamExecutionJournal(),
      processor: { process: () => { order.push('downstream'); return { status: 'COMPLETED' }; } },
      now: () => now
    });
    const result = dispatchNextInboundWorkItem({
      queue,
      contactIdentityResolver: {
        resolve: () => {
          order.push('identity');
          return { status: 'RESOLVED', contactId: 'contact-1', contactIdentityId: 'identity-1' };
        }
      },
      conversationResolver: {
        resolve: () => {
          order.push('conversation');
          return { status: 'EXISTING_CONVERSATION', conversationId: 'conversation-1' };
        }
      },
      commandHandler: handler,
      ownerId: 'offline-worker-f1b-14',
      now,
      leaseDurationMs: 30_000,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }
    });

    expect(result).toMatchObject({ status: 'COMPLETED', commandType: 'InboundMessageReceived' });
    expect(order).toEqual(['identity', 'conversation', 'downstream', 'ack']);
  });

  it('emits an ordered, payload-free operational trace', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(admittedMessage('observed'));
    const sink = new InMemoryGatewayOperationalEventSink();
    const handler = new OfflineIdempotentCommandHandler({
      journal: new InMemoryDownstreamExecutionJournal(),
      processor: { process: () => ({ status: 'COMPLETED' }) },
      now: () => now,
      operationalEventSink: sink
    });

    expect(runWorker(store, handler, { sink }).status).toBe('COMPLETED');
    expect(sink.list().map((item) => item.stage)).toEqual([
      'QUEUE', 'IDENTITY_RESOLUTION', 'CONVERSATION_RESOLUTION',
      'DOWNSTREAM_IDEMPOTENCY', 'COMMAND_HANDLING', 'ACKNOWLEDGMENT'
    ]);
    for (const item of sink.list()) {
      expect(Object.keys(item).sort()).toEqual([
        'channel', 'correlationId', 'duplicate', 'healthImpact', 'outcome', 'provider',
        'reasonCode', 'retryCount', 'stage', 'timestamp'
      ]);
    }
    const serialized = JSON.stringify(sink.list());
    expect(serialized).not.toContain('Sensitive synthetic message');
    expect(serialized).not.toContain('+15555550123');
    expect(serialized).not.toContain('idem-observed');
    expect(serialized).not.toMatch(/payload|content|token|secret/i);
  });

  it('keeps processing offline and successful when the operational sink throws', () => {
    const store = new InMemoryDurableWebhookIngressStore();
    store.admit(admittedMessage('sink-failure'));
    const throwingSink: GatewayOperationalEventSink = {
      emit: () => { throw new Error('SYNTHETIC_EXPORTER_FAILURE'); }
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const handler = new OfflineIdempotentCommandHandler({
      journal: new InMemoryDownstreamExecutionJournal(),
      processor: { process: () => ({ status: 'COMPLETED' }) },
      now: () => now,
      operationalEventSink: throwingSink
    });

    expect(runWorker(store, handler, { sink: throwingSink }).status).toBe('COMPLETED');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
