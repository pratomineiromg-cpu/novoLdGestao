import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryDurableWebhookIngressStore,
  decideWebhookAck,
  summarizeWebhookBatch
} from '../../services/channel-gateway/ingress';
import { MetaOfficialBatchWebhookDecoder } from '../../services/channel-gateway/providers/metaOfficialProtocol';
import {
  dispatchStagedBatchItems,
  handleMetaWebhookRequest,
  mapWebhookAckDecisionToHttp,
  type InboundWorkerDependencies,
  type MetaWebhookRuntimeDependencies
} from '../../services/channel-gateway/providers/metaWebhookHandler';
import { createLiveWebhookRequest, type CreateLiveWebhookRequestInput } from '../../services/channel-gateway/rawWebhook';
import {
  signSyntheticBody,
  syntheticMetaDependencies,
  syntheticVerifyToken
} from '../../services/channel-gateway/simulator/metaSecurity';

const now = new Date('2026-09-04T12:00:00.000Z');

function createBatchBody(
  messages: Array<{ id: string; from: string; body?: string; type?: string }>,
  statuses: Array<{ id: string; status: string; timestamp: string }> = []
): Uint8Array {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '001234',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+15555550123',
                phone_number_id: '10001'
              },
              ...(messages.length > 0
                ? {
                    messages: messages.map((m) => ({
                      id: m.id,
                      from: m.from,
                      timestamp: '1725451200',
                      type: m.type ?? 'text',
                      ...(m.type && m.type !== 'text' ? {} : { text: m.body === undefined ? undefined : { body: m.body } })
                    }))
                  }
                : {}),
              ...(statuses.length > 0
                ? {
                    statuses: statuses.map((s) => ({
                      id: s.id,
                      status: s.status,
                      timestamp: s.timestamp
                    }))
                  }
                : {})
            }
          }
        ]
      }
    ]
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

function post(rawBody: Uint8Array, overrides: Partial<CreateLiveWebhookRequestInput> = {}) {
  return createLiveWebhookRequest({
    method: 'POST',
    rawBody,
    receivedAt: now,
    requestId: 'untrusted-request-id',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signSyntheticBody(rawBody)
    },
    ...overrides
  });
}

function workerDependencies(
  overrides: Partial<InboundWorkerDependencies> = {}
): InboundWorkerDependencies {
  const synthetic = syntheticMetaDependencies();
  return {
    contactIdentityResolver: synthetic.contactIdentityResolver,
    conversationResolver: synthetic.conversationResolver,
    ownerId: 'offline-worker-1',
    now,
    leaseDurationMs: 30_000,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    ...overrides
  };
}

afterEach(() => vi.restoreAllMocks());

describe('F1B-10 Batch Webhook Ingress + Durable Admission & ACK Semantics Offline', () => {
  it('atomically admits 2 independent messages and stages 2 queued work items before ACK', () => {
    const body = createBatchBody([
      { id: 'wamid.batch.1', from: '+15555550123', body: 'First batch message' },
      { id: 'wamid.batch.2', from: '+15555550123', body: 'Second batch message' }
    ]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const dependencies: MetaWebhookRuntimeDependencies = { ...syntheticMetaDependencies(), ingressStore };

    const response = handleMetaWebhookRequest(post(body), dependencies);

    expect(response.statusCode).toBe(200);
    expect(response.ackDecision).toBe('ACKNOWLEDGE');
    expect(response.batchResult).toMatchObject({ totalItemCount: 2, admittedCount: 2, retryableFailureCount: 0 });
    expect(response.ingressBatchRecord).toBeDefined();
    expect(ingressStore.list('QUEUED')).toHaveLength(2);
  });

  it('admits mixed messages and statuses in one request without treating array order as chronology', () => {
    const body = createBatchBody(
      [{ id: 'wamid.msg.1', from: '+15555550123', body: 'Inbound customer text' }],
      [{ id: 'wamid.outbound.sent', status: 'delivered', timestamp: '1725451205' }]
    );
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const response = handleMetaWebhookRequest(post(body), { ...syntheticMetaDependencies(), ingressStore });

    expect(response.statusCode).toBe(200);
    expect(response.batchResult?.items.map((item) => item.rawEventKind)).toEqual(['message', 'status']);
    const queued = ingressStore.list('QUEUED');
    expect(queued).toHaveLength(2);
    expect(queued[0].event.eventType).toBe('INBOUND_MESSAGE');
    expect(queued[1].event.eventType).toBe('DELIVERY_STATUS');
    expect(queued[1].event.payload.providerTimestamp).toBe('1725451205');
  });

  it('dedupes one replayed item while independently admitting a fresh item', () => {
    const firstBody = createBatchBody([{ id: 'wamid.repeat.1', from: '+15555550123', body: 'Original message' }]);
    const secondBody = createBatchBody([
      { id: 'wamid.repeat.1', from: '+15555550123', body: 'Original message' },
      { id: 'wamid.fresh.2', from: '+15555550123', body: 'Fresh new message' }
    ]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const dependencies: MetaWebhookRuntimeDependencies = { ...syntheticMetaDependencies(), ingressStore };

    expect(handleMetaWebhookRequest(post(firstBody), dependencies).batchResult?.admittedCount).toBe(1);
    const replay = handleMetaWebhookRequest(post(secondBody), dependencies);

    expect(replay.statusCode).toBe(200);
    expect(replay.ackDecision).toBe('ACKNOWLEDGE');
    expect(replay.batchResult).toMatchObject({ admittedCount: 1, duplicateCount: 1 });
    expect(ingressStore.list()).toHaveLength(2);
  });

  it('moves identity and conversation resolution behind durable admission/HTTP ACK', () => {
    const body = createBatchBody([
      { id: 'wamid.unknown.1', from: '+19999999999', body: 'Message from unknown' },
      { id: 'wamid.known.2', from: '+15555550123', body: 'Message from known' }
    ]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const contactIdentityResolver = {
      resolve: vi.fn((input: { externalAddress: string }) => input.externalAddress === '+19999999999'
        ? ({ status: 'NOT_FOUND' as const })
        : ({ status: 'RESOLVED_EXISTING' as const, contactId: 'c1', contactIdentityId: 'ci1' }))
    };
    const conversationResolver = {
      resolve: vi.fn(() => ({ status: 'RESOLVED_EXISTING' as const, conversationId: 'conv1' }))
    };
    const dependencies: MetaWebhookRuntimeDependencies = {
      ...syntheticMetaDependencies(),
      ingressStore,
      contactIdentityResolver,
      conversationResolver
    };

    const response = handleMetaWebhookRequest(post(body), dependencies);
    expect(response.statusCode).toBe(200);
    expect(response.batchResult?.admittedCount).toBe(2);
    expect(contactIdentityResolver.resolve).not.toHaveBeenCalled();
    expect(conversationResolver.resolve).not.toHaveBeenCalled();

    const dispatched = dispatchStagedBatchItems(response.ingressBatchRecord!, ingressStore, workerDependencies({
      contactIdentityResolver,
      conversationResolver
    }));
    expect(dispatched.map((item) => item.status)).toEqual(['FAILED_RETRYABLE', 'COMPLETED']);
    expect(contactIdentityResolver.resolve).toHaveBeenCalledTimes(2);
    expect(conversationResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON/root structure as a request-level error without admission', () => {
    const body = new TextEncoder().encode('{"object":"invalid_object","entry":[]}');
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const response = handleMetaWebhookRequest(post(body), { ...syntheticMetaDependencies(), ingressStore });

    expect(response.statusCode).toBe(400);
    expect(response.ackDecision).toBe('REJECT_REQUEST');
    expect(response.batchResult).toBeUndefined();
    expect(ingressStore.list()).toHaveLength(0);
  });

  it('enforces maxDecodedItemsPerRequest as a local request policy', () => {
    const body = createBatchBody([
      { id: 'wamid.limit.1', from: '+15555550123', body: 'one' },
      { id: 'wamid.limit.2', from: '+15555550123', body: 'two' }
    ]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const response = handleMetaWebhookRequest(post(body), {
      ...syntheticMetaDependencies(), ingressStore, maxDecodedItemsPerRequest: 1
    });

    expect(response.statusCode).toBe(413);
    expect(response.ackDecision).toBe('REJECT_REQUEST');
    expect(response.audit.at(-1)?.reason).toBe('DECODED_ITEM_LIMIT_EXCEEDED');
    expect(ingressStore.list()).toHaveLength(0);
  });

  it('returns RETRY_REQUEST for a mixed partial admission failure and replay dedupes committed work', () => {
    const body = createBatchBody([
      { id: 'wamid.partial.ok', from: '+15555550123', body: 'commits' },
      { id: 'wamid.partial.fail', from: '+15555550123', body: 'fails first attempt' }
    ]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const original = ingressStore.admit.bind(ingressStore);
    const spy = vi.spyOn(ingressStore, 'admit').mockImplementation((input) => {
      if (input.providerEventId?.includes('wamid.partial.fail')) throw new Error('SYNTHETIC_TRANSIENT');
      return original(input);
    });
    const dependencies: MetaWebhookRuntimeDependencies = { ...syntheticMetaDependencies(), ingressStore };

    const first = handleMetaWebhookRequest(post(body), dependencies);
    expect(first.statusCode).toBe(503);
    expect(first.ackDecision).toBe('RETRY_REQUEST');
    expect(first.batchResult).toMatchObject({ admittedCount: 1, retryableFailureCount: 1 });
    expect(ingressStore.list()).toHaveLength(1);

    spy.mockRestore();
    const replay = handleMetaWebhookRequest(post(body), dependencies);
    expect(replay.statusCode).toBe(200);
    expect(replay.batchResult).toMatchObject({ admittedCount: 1, duplicateCount: 1, retryableFailureCount: 0 });
    expect(ingressStore.list()).toHaveLength(2);
  });

  it('crash-before-commit leaves no dedupe/work state and replay can admit', () => {
    const body = createBatchBody([{ id: 'wamid.crash.before', from: '+15555550123', body: 'before commit' }]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const spy = vi.spyOn(ingressStore, 'admit').mockImplementationOnce(() => {
      throw new Error('SYNTHETIC_CRASH_BEFORE_COMMIT');
    });
    const dependencies: MetaWebhookRuntimeDependencies = { ...syntheticMetaDependencies(), ingressStore };

    const failed = handleMetaWebhookRequest(post(body), dependencies);
    expect(failed.ackDecision).toBe('RETRY_REQUEST');
    expect(ingressStore.list()).toHaveLength(0);

    spy.mockRestore();
    const replay = handleMetaWebhookRequest(post(body), dependencies);
    expect(replay.ackDecision).toBe('ACKNOWLEDGE');
    expect(replay.batchResult?.admittedCount).toBe(1);
    expect(ingressStore.list()).toHaveLength(1);
  });

  it('crash-after-commit can return RETRY but replay dedupes the already-staged work', () => {
    const body = createBatchBody([{ id: 'wamid.crash.after', from: '+15555550123', body: 'after commit' }]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const original = ingressStore.admit.bind(ingressStore);
    const spy = vi.spyOn(ingressStore, 'admit').mockImplementationOnce((input) => {
      original(input);
      throw new Error('SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT');
    });
    const dependencies: MetaWebhookRuntimeDependencies = { ...syntheticMetaDependencies(), ingressStore };

    const failed = handleMetaWebhookRequest(post(body), dependencies);
    expect(failed.ackDecision).toBe('RETRY_REQUEST');
    expect(ingressStore.list()).toHaveLength(1);

    spy.mockRestore();
    const replay = handleMetaWebhookRequest(post(body), dependencies);
    expect(replay.ackDecision).toBe('ACKNOWLEDGE');
    expect(replay.batchResult).toMatchObject({ admittedCount: 0, duplicateCount: 1 });
    expect(ingressStore.list()).toHaveLength(1);
  });

  it('replay storm never creates a second work item for the same provider event', () => {
    const body = createBatchBody([{ id: 'wamid.storm.1', from: '+15555550123', body: 'storm' }]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const dependencies: MetaWebhookRuntimeDependencies = { ...syntheticMetaDependencies(), ingressStore };
    const responses = Array.from({ length: 20 }, () => handleMetaWebhookRequest(post(body), dependencies));

    expect(responses[0].batchResult?.admittedCount).toBe(1);
    for (const replay of responses.slice(1)) expect(replay.batchResult?.duplicateCount).toBe(1);
    expect(ingressStore.list()).toHaveLength(1);
  });

  it('isolates unsupported and invalid items from valid items in the same envelope', () => {
    const unsupported = createBatchBody([
      { id: 'wamid.good.1', from: '+15555550123', body: 'good' },
      { id: 'wamid.unsupported.2', from: '+15555550123', type: 'image' }
    ]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const first = handleMetaWebhookRequest(post(unsupported), { ...syntheticMetaDependencies(), ingressStore });
    expect(first.statusCode).toBe(200);
    expect(first.batchResult).toMatchObject({ admittedCount: 1, unsupportedCount: 1 });

    const invalid = createBatchBody([
      { id: 'wamid.good.3', from: '+15555550123', body: 'good' },
      { id: 'wamid.invalid.4', from: '+15555550123' }
    ]);
    const second = handleMetaWebhookRequest(post(invalid), { ...syntheticMetaDependencies(), ingressStore });
    expect(second.statusCode).toBe(200);
    expect(second.batchResult).toMatchObject({ admittedCount: 1, finalRejectedCount: 1 });
  });

  it('keeps source coordinates diagnostic-only and makes message/status indexes unique within one change', () => {
    const body = createBatchBody(
      [{ id: 'wamid.coords.message', from: '+15555550123', body: 'message' }],
      [{ id: 'wamid.coords.status', status: 'delivered', timestamp: '1725451205' }]
    );
    const decoder = new MetaOfficialBatchWebhookDecoder();
    let id = 0;
    const decoded = decoder.decodeBatchEnvelope(post(body), { createInternalEventId: () => `opaque-${++id}` });

    expect(decoded.items).toHaveLength(2);
    expect(decoded.items[0].sourceCoordinates).toEqual({ entryIndex: 0, changeIndex: 0, itemIndex: 0 });
    expect(decoded.items[1].sourceCoordinates).toEqual({ entryIndex: 0, changeIndex: 0, itemIndex: 1 });
    expect(decoded.items[0].itemId).not.toBe(decoded.items[1].itemId);
    expect(decoded.items[0].itemId).not.toContain('wamid.coords');
  });

  it('decoupled worker reserves, resolves and acknowledges queued work only after HTTP ACK', () => {
    const body = createBatchBody([
      { id: 'wamid.dispatch.1', from: '+15555550123', body: 'Item to dispatch 1' },
      { id: 'wamid.dispatch.2', from: '+15555550123', body: 'Item to dispatch 2' }
    ]);
    const ingressStore = new InMemoryDurableWebhookIngressStore();
    const response = handleMetaWebhookRequest(post(body), { ...syntheticMetaDependencies(), ingressStore });
    expect(response.statusCode).toBe(200);
    expect(ingressStore.list('QUEUED')).toHaveLength(2);

    const dispatched = dispatchStagedBatchItems(response.ingressBatchRecord!, ingressStore, workerDependencies());
    expect(dispatched).toHaveLength(2);
    expect(dispatched.every((item) => item.status === 'COMPLETED')).toBe(true);
    expect(dispatched[0].command?.type).toBe('InboundMessageReceived');
    expect(ingressStore.list('COMPLETED')).toHaveLength(2);
  });

  it('keeps ACK decision provider-neutral and HTTP mapping separate', () => {
    const result = summarizeWebhookBatch('request-x', 'batch-x', 'WHATSAPP_META_OFFICIAL', now, [{
      itemId: 'opaque-item', rawEventKind: 'message', disposition: 'RETRYABLE_FAILURE', reasonCode: 'STORE_DOWN'
    }]);
    const decision = decideWebhookAck(result);
    expect(decision).toBe('RETRY_REQUEST');
    expect(mapWebhookAckDecisionToHttp(decision, 'RETRYABLE_ADMISSION_FAILURE')).toBe(503);
    expect(mapWebhookAckDecisionToHttp('REJECT_REQUEST', 'INVALID_EVENT')).toBe(400);
  });

  it('sanitizes audits and never leaks payload, address, signature or verify token', () => {
    const body = createBatchBody([{ id: 'wamid.audit.1', from: '+15555550123', body: 'Sensitive message text' }]);
    const response = handleMetaWebhookRequest(post(body), syntheticMetaDependencies());
    const serializedAudit = JSON.stringify(response.audit);

    expect(serializedAudit).not.toContain(syntheticVerifyToken);
    expect(serializedAudit).not.toContain(signSyntheticBody(body));
    expect(serializedAudit).not.toContain('Sensitive message text');
    expect(serializedAudit).not.toContain('+15555550123');
  });
});
