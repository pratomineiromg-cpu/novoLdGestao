import { describe, expect, it, vi } from 'vitest';
import type { NormalizedChannelEvent } from '../../services/channel-gateway/contracts';
import {
  dispatchNextInboundWorkItem,
  resolveInboundWorkReferences,
  type InboundWorkerStepInput
} from '../../services/channel-gateway/inboundWorker';
import {
  InMemoryDurableWebhookIngressStore,
  type AdmitInboundItemInput,
  type InboundWorkQueue
} from '../../services/channel-gateway/ingress';

const startedAt = new Date('2026-09-16T12:00:00.000Z');

function messageInput(workItemId: string, idempotencyKey: string): AdmitInboundItemInput {
  return {
    workItemId,
    idempotencyKey,
    admittedAt: startedAt,
    provider: 'WHATSAPP_META_OFFICIAL',
    providerEventId: `synthetic-${workItemId}`,
    rawEventKind: 'message',
    event: {
      internalEventId: `internal-${workItemId}`,
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      occurredAt: startedAt,
      eventType: 'INBOUND_MESSAGE',
      payload: {
        providerAddress: '+15555550123',
        externalConversationId: 'synthetic-thread'
      }
    }
  };
}

function statusInput(workItemId: string, idempotencyKey: string): AdmitInboundItemInput {
  const event: NormalizedChannelEvent = {
    internalEventId: `internal-${workItemId}`,
    provider: 'WHATSAPP_META_OFFICIAL',
    channel: 'WHATSAPP',
    occurredAt: startedAt,
    eventType: 'DELIVERY_STATUS',
    payload: { deliveryStatus: 'DELIVERED' }
  };
  return {
    workItemId,
    idempotencyKey,
    admittedAt: startedAt,
    provider: 'WHATSAPP_META_OFFICIAL',
    providerEventId: `synthetic-${workItemId}`,
    rawEventKind: 'status',
    event
  };
}

function workerInput(
  queue: InboundWorkQueue,
  overrides: Partial<InboundWorkerStepInput> = {}
): InboundWorkerStepInput {
  return {
    queue,
    contactIdentityResolver: {
      resolve: () => ({ status: 'RESOLVED', contactId: 'contact-1', contactIdentityId: 'identity-1' })
    },
    conversationResolver: {
      resolve: () => ({ status: 'EXISTING_CONVERSATION', conversationId: 'conversation-1' })
    },
    commandHandler: { handle: () => ({ status: 'COMPLETED' }) },
    ownerId: 'offline-worker-f1b-13',
    now: startedAt,
    leaseDurationMs: 30_000,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    ...overrides
  };
}

describe('F1B-13 worker identity, conversation and command integration offline', () => {
  describe('identity outcomes', () => {
    it('1. resolves an identity and dispatches opaque references', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('identity-resolved', 'idem-identity-resolved'));
      const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

      const result = dispatchNextInboundWorkItem(workerInput(store, { commandHandler: { handle: handler } }));

      expect(result.status).toBe('COMPLETED');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        resolvedReferences: {
          contactId: 'contact-1',
          contactIdentityId: 'identity-1',
          conversationId: 'conversation-1'
        }
      }));
    });

    it('2. treats an identity not found as retryable', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('identity-not-found', 'idem-identity-not-found'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: { resolve: () => ({ status: 'NOT_FOUND' }) }
      }));

      expect(result).toMatchObject({ status: 'FAILED_RETRYABLE', reasonCode: 'IDENTITY_NOT_FOUND' });
    });

    it('3. treats an ambiguous identity as retryable', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('identity-ambiguous', 'idem-identity-ambiguous'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: { resolve: () => ({ status: 'AMBIGUOUS' }) }
      }));

      expect(result).toMatchObject({ status: 'FAILED_RETRYABLE', reasonCode: 'IDENTITY_AMBIGUOUS' });
    });

    it('4. fails an invalid identity terminally with a safe code', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('identity-invalid', 'idem-identity-invalid'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: { resolve: () => ({ status: 'INVALID', reasonCode: 'synthetic-format-detail' }) }
      }));

      expect(result).toMatchObject({ status: 'FAILED_FINAL', reasonCode: 'IDENTITY_REJECTED' });
      expect(JSON.stringify(result)).not.toContain('synthetic-format-detail');
    });

    it('5. preserves an allow-listed retryable identity reason', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('identity-retry', 'idem-identity-retry'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: {
          resolve: () => ({ status: 'RETRYABLE_FAILURE', reasonCode: 'PROVIDER_UNAVAILABLE' })
        }
      }));

      expect(result).toMatchObject({ status: 'FAILED_RETRYABLE', reasonCode: 'PROVIDER_UNAVAILABLE' });
    });

    it('6. preserves an allow-listed final identity reason', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('identity-final', 'idem-identity-final'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: {
          resolve: () => ({ status: 'FINAL_FAILURE', reasonCode: 'IDENTITY_REJECTED' })
        }
      }));

      expect(result).toMatchObject({ status: 'FAILED_FINAL', reasonCode: 'IDENTITY_REJECTED' });
    });
  });

  describe('conversation outcomes', () => {
    it('7. uses an existing conversation', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('conversation-existing', 'idem-conversation-existing'));
      const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

      dispatchNextInboundWorkItem(workerInput(store, { commandHandler: { handle: handler } }));

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        resolvedReferences: expect.objectContaining({ conversationId: 'conversation-1' })
      }));
    });

    it('8. accepts a resolver-confirmed new conversation only with the work idempotency key', () => {
      const withoutCreationKey = resolveInboundWorkReferences(messageInput('direct-new', 'idem-direct-new').event, {
        contactIdentityResolver: {
          resolve: () => ({ status: 'RESOLVED', contactId: 'contact-1', contactIdentityId: 'identity-1' })
        },
        conversationResolver: {
          resolve: () => ({ status: 'NEW_CONVERSATION', conversationId: 'unsafe-without-key' })
        }
      });
      expect(withoutCreationKey).toEqual({ status: 'FINAL_FAILURE', reasonCode: 'CONVERSATION_REJECTED' });

      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('conversation-new', 'idem-conversation-new'));
      const conversationResolver = vi.fn((request: { creationIdempotencyKey?: string }) => {
        expect(request.creationIdempotencyKey).toBe('idem-conversation-new');
        return { status: 'NEW_CONVERSATION' as const, conversationId: 'conversation-created' };
      });
      const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        conversationResolver: { resolve: conversationResolver },
        commandHandler: { handle: handler }
      }));

      expect(result.status).toBe('COMPLETED');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        resolvedReferences: expect.objectContaining({
          conversationId: 'conversation-created',
          conversationCreated: true
        })
      }));
    });

    it('9. treats an ambiguous conversation as retryable', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('conversation-ambiguous', 'idem-conversation-ambiguous'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        conversationResolver: { resolve: () => ({ status: 'AMBIGUOUS' }) }
      }));

      expect(result).toMatchObject({ status: 'FAILED_RETRYABLE', reasonCode: 'CONVERSATION_AMBIGUOUS' });
    });

    it('10. preserves an allow-listed retryable conversation reason', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('conversation-retry', 'idem-conversation-retry'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        conversationResolver: { resolve: () => ({ status: 'RETRYABLE_FAILURE', reasonCode: 'RATE_LIMITED' }) }
      }));

      expect(result).toMatchObject({ status: 'FAILED_RETRYABLE', reasonCode: 'RATE_LIMITED' });
    });

    it('11. preserves an allow-listed final conversation reason', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('conversation-final', 'idem-conversation-final'));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        conversationResolver: {
          resolve: () => ({ status: 'FINAL_FAILURE', reasonCode: 'CONVERSATION_REJECTED' })
        }
      }));

      expect(result).toMatchObject({ status: 'FAILED_FINAL', reasonCode: 'CONVERSATION_REJECTED' });
    });
  });

  describe('integration invariants', () => {
    it('12. runs identity, conversation and command in order', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('integration-order', 'idem-integration-order'));
      const identity = vi.fn(() => ({
        status: 'RESOLVED' as const,
        contactId: 'contact-1',
        contactIdentityId: 'identity-1'
      }));
      const conversation = vi.fn(() => ({
        status: 'EXISTING_CONVERSATION' as const,
        conversationId: 'conversation-1'
      }));
      const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: { resolve: identity },
        conversationResolver: { resolve: conversation },
        commandHandler: { handle: handler }
      }));

      expect(result.commandType).toBe('InboundMessageReceived');
      expect(identity.mock.invocationCallOrder[0]).toBeLessThan(conversation.mock.invocationCallOrder[0]);
      expect(conversation.mock.invocationCallOrder[0]).toBeLessThan(handler.mock.invocationCallOrder[0]);
    });

    it('13. admits the same idempotency key once and handles one command', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      const first = store.admit(messageInput('idempotent-first', 'idem-shared'));
      const duplicate = store.admit(messageInput('idempotent-duplicate', 'idem-shared'));
      const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

      const result = dispatchNextInboundWorkItem(workerInput(store, { commandHandler: { handle: handler } }));

      expect(first.disposition).toBe('ADMITTED');
      expect(duplicate.disposition).toBe('DUPLICATE');
      expect(result).toMatchObject({ status: 'COMPLETED', workItemId: 'idempotent-first' });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('14. records a retryable resolver transition without invoking the command', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('integration-retry', 'idem-integration-retry'));
      const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: {
          resolve: () => ({ status: 'RETRYABLE_FAILURE', reasonCode: 'PROVIDER_UNAVAILABLE' })
        },
        commandHandler: { handle: handler }
      }));

      expect(result.status).toBe('FAILED_RETRYABLE');
      expect(store.get('integration-retry')).toMatchObject({ state: 'FAILED_RETRYABLE', attempt: 1 });
      expect(handler).not.toHaveBeenCalled();
    });

    it('15. records a terminal resolver transition without invoking the command', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(messageInput('integration-final', 'idem-integration-final'));
      const handler = vi.fn(() => ({ status: 'COMPLETED' as const }));

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: {
          resolve: () => ({ status: 'FINAL_FAILURE', reasonCode: 'IDENTITY_REJECTED' })
        },
        commandHandler: { handle: handler }
      }));

      expect(result.status).toBe('FAILED_FINAL');
      expect(store.get('integration-final')?.state).toBe('FAILED_FINAL');
      expect(handler).not.toHaveBeenCalled();
    });

    it('16. remains offline and bypasses resolvers for a provider-status command', () => {
      const store = new InMemoryDurableWebhookIngressStore();
      store.admit(statusInput('integration-offline', 'idem-integration-offline'));
      const identity = vi.fn();
      const conversation = vi.fn();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = dispatchNextInboundWorkItem(workerInput(store, {
        contactIdentityResolver: { resolve: identity },
        conversationResolver: { resolve: conversation }
      }));

      expect(result).toMatchObject({ status: 'COMPLETED', commandType: 'MessageDeliveryUpdated' });
      expect(identity).not.toHaveBeenCalled();
      expect(conversation).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});
