import type {
  DecodedProviderBatch,
  DecodedProviderBatchItem,
  GatewayCommand,
  GatewayProcessResult
} from '../contracts';
import { createGatewayCommand } from '../command';
import type { DurableIdempotencyStore } from '../idempotency';
import {
  resolveInboundWorkReferences,
  type InboundWorkReferenceResolvers
} from '../inboundWorker';
import {
  decideWebhookAck,
  type DurableIngressBatchRecord,
  type DurableWebhookIngressStore,
  InMemoryDurableWebhookIngressStore,
  summarizeWebhookBatch,
  type WebhookAckDecision,
  type WebhookBatchItemResult,
  type WebhookBatchResult
} from '../ingress';
import { createOpaqueGatewayId } from '../normalization';
import { createLiveWebhookRequest, type RawWebhookRequest } from '../rawWebhook';
import type { ContactIdentityResolver, ConversationResolver } from '../resolution';
import type { RetryPolicyInput } from '../retryPolicy';
import { createSanitizedAuditEvent } from '../sanitizer';
import { isSecretRef, type SecretResolver } from '../secrets';
import { GatewayError } from '../errors';
import { MetaOfficialBatchWebhookDecoder } from './metaOfficialProtocol';
import {
  evaluateMetaHandshake,
  MetaWebhookAuthenticator,
  MetaWebhookHandshakeVerifier,
  type MetaWebhookSecurityConfig
} from './metaWebhookSecurity';
import { WhatsAppMetaOfflineAdapter } from './whatsapp-meta';

export const META_ACK_RETRY_SEMANTICS_CURRENT_RECONFIRMATION_REQUIRED =
  'META_ACK_RETRY_SEMANTICS_CURRENT_RECONFIRMATION_REQUIRED' as const;

export const DEFAULT_MAX_DECODED_ITEMS_PER_REQUEST = 100;

export interface MetaWebhookRuntimeDependencies {
  config: MetaWebhookSecurityConfig;
  secretResolver?: SecretResolver;
  /** F1B-09 legacy port retained for compatibility; F1B-10 admission owns its own dedupe boundary. */
  idempotencyStore: DurableIdempotencyStore;
  /** Process-local reference in this phase. Production durable implementation remains NOT_CONFIGURED. */
  ingressStore?: DurableWebhookIngressStore;
  contactIdentityResolver: ContactIdentityResolver;
  conversationResolver: ConversationResolver;
  /** Local worker lease policy; not a provider timeout. */
  leaseDurationMs: number;
  /** LOCAL PROCESSING POLICY, not a Meta limit. */
  maxDecodedItemsPerRequest?: number;
  clock?: () => number;
}

export interface MetaWebhookAudit {
  event: 'META_WEBHOOK_REQUEST' | 'META_WEBHOOK_HANDSHAKE' | 'META_WEBHOOK_SIGNATURE' | 'META_WEBHOOK_BATCH_ADMISSION';
  requestId: string;
  correlationId: string;
  provider: 'WHATSAPP_META_OFFICIAL';
  method: 'GET' | 'POST' | 'OTHER';
  result: string;
  reason: string;
  timestamp: string;
  durationMs: number;
  duplicate: boolean;
}

export interface MetaWebhookHttpResult {
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: string;
  /** LOCAL processing-policy decision. It is not a claim about current Meta retry behavior. */
  ackDecision?: WebhookAckDecision;
  /** Transient F1B-09 compatibility projection; no downstream business processing occurs here. */
  processingResult?: GatewayProcessResult;
  batchResult?: WebhookBatchResult;
  ingressBatchRecord?: DurableIngressBatchRecord;
  audit: readonly MetaWebhookAudit[];
}

export interface InboundWorkerDependencies extends InboundWorkReferenceResolvers {
  ownerId: string;
  now: Date;
  leaseDurationMs: number;
  retryPolicy: Omit<RetryPolicyInput, 'attempt' | 'retryability'>;
}

const offlineIngressStores = new WeakMap<object, InMemoryDurableWebhookIngressStore>();

function ingressStoreFor(dependencies: MetaWebhookRuntimeDependencies): DurableWebhookIngressStore {
  if (dependencies.ingressStore) return dependencies.ingressStore;
  const key = dependencies as object;
  const existing = offlineIngressStores.get(key);
  if (existing) return existing;
  const created = new InMemoryDurableWebhookIngressStore();
  offlineIngressStores.set(key, created);
  return created;
}

function validConfig(config: MetaWebhookSecurityConfig): boolean {
  return (
    !!config &&
    Object.keys(config).every((key) =>
      ['appSecretRef', 'verifyTokenRef', 'maxWebhookBodyBytes'].includes(key)
    ) &&
    Number.isSafeInteger(config.maxWebhookBodyBytes) &&
    config.maxWebhookBodyBytes > 0 &&
    (config.appSecretRef === undefined || isSecretRef(config.appSecretRef)) &&
    (config.verifyTokenRef === undefined || isSecretRef(config.verifyTokenRef))
  );
}

function maxDecodedItemsFor(dependencies: MetaWebhookRuntimeDependencies): number | undefined {
  const value = dependencies.maxDecodedItemsPerRequest ?? DEFAULT_MAX_DECODED_ITEMS_PER_REQUEST;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** HTTP mapping is intentionally separate from the provider-neutral ACK decision. */
export function mapWebhookAckDecisionToHttp(decision: WebhookAckDecision, reason: string): number {
  if (decision === 'ACKNOWLEDGE') return 200;
  if (decision === 'RETRY_REQUEST') return 503;
  if (reason === 'METHOD_NOT_ALLOWED') return 405;
  if (reason === 'PAYLOAD_TOO_LARGE' || reason === 'DECODED_ITEM_LIMIT_EXCEEDED') return 413;
  if (reason === 'UNSUPPORTED_CONTENT_TYPE') return 415;
  if (
    reason === 'INVALID_TRUST_MODE' ||
    reason === 'SIGNATURE_MISSING' ||
    reason === 'SIGNATURE_MALFORMED' ||
    reason === 'SIGNATURE_MISMATCH' ||
    reason === 'WEBHOOK_AUTH_REJECTED'
  ) return 403;
  return 400;
}

function compatibilityProjection(
  decoded: DecodedProviderBatchItem | undefined,
  item: WebhookBatchItemResult | undefined,
  now: Date
): GatewayProcessResult | undefined {
  const event = decoded?.event;
  if (!event || !item) return undefined;
  if (item.disposition === 'ADMITTED') {
    return {
      outcome: 'ACCEPTED',
      event,
      command: createGatewayCommand(event),
      audit: createSanitizedAuditEvent({
        event,
        internalEventId: event.internalEventId,
        provider: event.provider,
        channel: event.channel,
        outcome: 'ACCEPTED',
        reasonCode: 'EVENT_ACCEPTED',
        duplicate: false,
        auditedAt: now
      })
    };
  }
  if (item.disposition === 'DUPLICATE' || item.disposition === 'ALREADY_PROCESSING') {
    return {
      outcome: 'DUPLICATE',
      event,
      audit: createSanitizedAuditEvent({
        event,
        internalEventId: event.internalEventId,
        provider: event.provider,
        channel: event.channel,
        outcome: 'DUPLICATE',
        reasonCode: 'DUPLICATE_EVENT',
        duplicate: true,
        auditedAt: now
      })
    };
  }
  return {
    outcome: 'REJECTED',
    audit: createSanitizedAuditEvent({
      event,
      internalEventId: event.internalEventId,
      provider: event.provider,
      channel: event.channel,
      outcome: 'REJECTED',
      reasonCode: item.disposition === 'UNSUPPORTED' ? 'UNSUPPORTED_EVENT' :
        item.disposition === 'FINAL_REJECTED' ? 'NON_RETRYABLE' : 'PROVIDER_UNAVAILABLE',
      duplicate: false,
      auditedAt: now
    })
  };
}

/**
 * Offline HTTP-shaped boundary. POST authenticates exactly once, decodes the
 * complete batch, performs atomic item admission/work staging, decides a LOCAL
 * ACK policy, then maps that decision to an HTTP-shaped result.
 */
export function handleMetaWebhookRequest(
  input: RawWebhookRequest,
  dependencies: MetaWebhookRuntimeDependencies
): MetaWebhookHttpResult {
  const clock = dependencies.clock ?? Date.now;
  const startedAt = clock();
  const now = new Date(startedAt);
  const requestId = createOpaqueGatewayId('request');
  const correlationId = createOpaqueGatewayId('correlation');
  const method = input.method === 'GET' || input.method === 'POST' ? input.method : 'OTHER';
  const timestamp = now.toISOString();
  const audits: MetaWebhookAudit[] = [];
  const audit = (
    event: MetaWebhookAudit['event'],
    result: string,
    reason: string,
    duplicate = false
  ) => {
    audits.push({
      event,
      requestId,
      correlationId,
      provider: 'WHATSAPP_META_OFFICIAL',
      method,
      result,
      reason,
      timestamp,
      durationMs: Math.max(0, clock() - startedAt),
      duplicate
    });
  };

  const finish = (
    statusCode: number,
    result: string,
    reason: string,
    body = '',
    ackDecision?: WebhookAckDecision,
    processingResult?: GatewayProcessResult,
    batchResult?: WebhookBatchResult,
    ingressBatchRecord?: DurableIngressBatchRecord
  ): MetaWebhookHttpResult => {
    audit('META_WEBHOOK_REQUEST', result, reason, processingResult?.outcome === 'DUPLICATE');
    return {
      statusCode,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        ...(statusCode === 405 ? { allow: 'GET, POST' } : {})
      },
      body,
      ackDecision,
      processingResult,
      batchResult,
      ingressBatchRecord,
      audit: audits
    };
  };

  const finishPost = (
    decision: WebhookAckDecision,
    result: string,
    reason: string,
    processingResult?: GatewayProcessResult,
    batchResult?: WebhookBatchResult,
    ingressBatchRecord?: DurableIngressBatchRecord
  ) => finish(
    mapWebhookAckDecisionToHttp(decision, reason),
    result,
    reason,
    '',
    decision,
    processingResult,
    batchResult,
    ingressBatchRecord
  );

  if (method === 'OTHER') return finishPost('REJECT_REQUEST', 'REJECTED', 'METHOD_NOT_ALLOWED');
  const maxDecodedItems = maxDecodedItemsFor(dependencies);
  if (
    !validConfig(dependencies.config) ||
    !Number.isFinite(dependencies.leaseDurationMs) ||
    dependencies.leaseDurationMs <= 0 ||
    maxDecodedItems === undefined
  ) {
    return finishPost('RETRY_REQUEST', 'NOT_CONFIGURED', 'SECURITY_POLICY_NOT_CONFIGURED');
  }
  if (input.trustMode !== 'LIVE_UNTRUSTED') {
    return finishPost('REJECT_REQUEST', 'REJECTED', 'INVALID_TRUST_MODE');
  }
  if (method === 'POST' && input.rawBody.byteLength > dependencies.config.maxWebhookBodyBytes) {
    return finishPost('REJECT_REQUEST', 'REJECTED', 'PAYLOAD_TOO_LARGE');
  }

  try {
    const request = createLiveWebhookRequest({
      ...input,
      requestId,
      rawBody: method === 'GET' ? new Uint8Array() : input.rawBody
    });

    if (method === 'GET') {
      const handshake = evaluateMetaHandshake(
        request,
        new MetaWebhookHandshakeVerifier(dependencies.config.verifyTokenRef, dependencies.secretResolver)
      );
      audit('META_WEBHOOK_HANDSHAKE', handshake.status, handshake.reason);
      return finish(handshake.statusCode, handshake.status, handshake.reason, handshake.body);
    }

    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)
    ) {
      return finishPost('REJECT_REQUEST', 'REJECTED', 'UNSUPPORTED_CONTENT_TYPE');
    }

    const authenticator = new MetaWebhookAuthenticator(
      dependencies.config.appSecretRef,
      dependencies.secretResolver
    );
    const authentication = authenticator.verify(request);
    audit('META_WEBHOOK_SIGNATURE', authentication.status, authentication.reasonCode);
    if (authentication.status === 'NOT_CONFIGURED') {
      return finishPost('RETRY_REQUEST', 'NOT_CONFIGURED', authentication.reasonCode);
    }
    if (authentication.status !== 'VERIFIED') {
      return finishPost('REJECT_REQUEST', 'REJECTED', authentication.reasonCode);
    }

    const batchDecoder = new MetaOfficialBatchWebhookDecoder();
    let decodedBatch: DecodedProviderBatch;
    try {
      decodedBatch = batchDecoder.decodeBatch(request, {
        createInternalEventId: () => createOpaqueGatewayId('gateway-event')
      });
    } catch (error) {
      const reason = error instanceof GatewayError ? error.code : 'MALFORMED_REQUEST';
      return finishPost('REJECT_REQUEST', 'REJECTED', reason);
    }

    if (decodedBatch.items.length > maxDecodedItems) {
      return finishPost('REJECT_REQUEST', 'REJECTED', 'DECODED_ITEM_LIMIT_EXCEEDED');
    }

    const adapter = new WhatsAppMetaOfflineAdapter();
    const ingressStore = ingressStoreFor(dependencies);
    const itemResults: WebhookBatchItemResult[] = [];

    for (const decoded of decodedBatch.items) {
      if (!decoded.event) {
        const unsupported = decoded.errorReason === 'UNSUPPORTED_EVENT';
        itemResults.push({
          itemId: decoded.itemId,
          providerEventId: decoded.providerEventId,
          rawEventKind: decoded.rawEventKind,
          sourceCoordinates: decoded.sourceCoordinates,
          disposition: unsupported ? 'UNSUPPORTED' : 'FINAL_REJECTED',
          reasonCode: decoded.errorReason ?? (unsupported ? 'UNSUPPORTED_EVENT' : 'INVALID_EVENT')
        });
        continue;
      }

      const event = decoded.event;
      const idempotencyKey = adapter.createIdempotencyKey(event);
      const workItemId = createOpaqueGatewayId('inbound-work');
      try {
        const admitted = ingressStore.admit({
          idempotencyKey,
          workItemId,
          provider: event.provider,
          providerEventId: event.providerEventId,
          rawEventKind: decoded.rawEventKind === 'status' ? 'status' : 'message',
          event,
          admittedAt: now
        });
        const reasonCode = admitted.disposition === 'ADMITTED' ? 'EVENT_ADMITTED' :
          admitted.disposition === 'DUPLICATE' ? 'DUPLICATE_EVENT' :
            admitted.disposition === 'ALREADY_PROCESSING' ? 'ALREADY_PROCESSING' : 'NON_RETRYABLE';
        itemResults.push({
          itemId: decoded.itemId,
          providerEventId: decoded.providerEventId,
          rawEventKind: decoded.rawEventKind,
          sourceCoordinates: decoded.sourceCoordinates,
          disposition: admitted.disposition,
          reasonCode,
          workItemId: admitted.admission.workItemId
        });
      } catch {
        itemResults.push({
          itemId: decoded.itemId,
          providerEventId: decoded.providerEventId,
          rawEventKind: decoded.rawEventKind,
          sourceCoordinates: decoded.sourceCoordinates,
          disposition: 'RETRYABLE_FAILURE',
          reasonCode: 'ADMISSION_STORE_UNAVAILABLE'
        });
      }
    }

    const batchResult = summarizeWebhookBatch(
      requestId,
      decodedBatch.batchId,
      decodedBatch.provider,
      decodedBatch.receivedAt,
      itemResults
    );
    const localDecision = decideWebhookAck(batchResult);
    let batchRecord: DurableIngressBatchRecord | undefined;
    try {
      batchRecord = ingressStore.recordBatch({
        ingressBatchId: decodedBatch.batchId,
        correlationId,
        result: batchResult
      });
    } catch {
      const processingResult = decodedBatch.items.length === 1
        ? compatibilityProjection(decodedBatch.items[0], batchResult.items[0], now)
        : undefined;
      return finishPost(
        'RETRY_REQUEST',
        'REJECTED',
        'INGRESS_BATCH_RECORD_FAILED',
        processingResult,
        batchResult
      );
    }

    audit(
      'META_WEBHOOK_BATCH_ADMISSION',
      localDecision === 'ACKNOWLEDGE' ? 'ADMITTED' : 'RETRY_REQUIRED',
      localDecision === 'ACKNOWLEDGE' ? 'BATCH_ADMISSION_COMMITTED' : 'BATCH_PARTIAL_RETRYABLE_FAILURE',
      batchResult.admittedCount === 0 &&
        (batchResult.duplicateCount + batchResult.alreadyProcessingCount) > 0
    );

    const processingResult = decodedBatch.items.length === 1
      ? compatibilityProjection(decodedBatch.items[0], batchResult.items[0], now)
      : undefined;
    const overallOutcome = batchResult.admittedCount > 0 ? 'ACCEPTED' :
      (batchResult.duplicateCount + batchResult.alreadyProcessingCount) > 0 ? 'DUPLICATE' : 'REJECTED';
    const reason = localDecision === 'RETRY_REQUEST' ? 'RETRYABLE_ADMISSION_FAILURE' :
      overallOutcome === 'ACCEPTED' ? 'EVENT_ADMITTED' :
        overallOutcome === 'DUPLICATE' ? 'DUPLICATE_EVENT' :
          batchResult.items[0]?.reasonCode ?? 'REJECTED';

    return finishPost(
      localDecision,
      overallOutcome,
      reason,
      processingResult,
      batchResult,
      batchRecord
    );
  } catch {
    return finishPost('RETRY_REQUEST', 'REJECTED', 'REQUEST_PROCESSING_FAILED');
  }
}

export interface DispatchedItemResult {
  workItemId: string;
  command?: GatewayCommand;
  status: 'COMPLETED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'NOT_AVAILABLE';
  reasonCode: string;
}

/** Reference worker step. It runs only after HTTP admission/ACK decision has completed. */
export function dispatchStagedBatchItems(
  batchRecord: DurableIngressBatchRecord,
  ingressStore: DurableWebhookIngressStore,
  dependencies: InboundWorkerDependencies
): readonly DispatchedItemResult[] {
  const results: DispatchedItemResult[] = [];
  for (const item of batchRecord.items) {
    if (item.disposition !== 'ADMITTED' || !item.workItemId) continue;
    const reserved = ingressStore.reserve(
      item.workItemId,
      dependencies.ownerId,
      dependencies.now,
      dependencies.leaseDurationMs
    );
    if (reserved.status !== 'RESERVED') {
      results.push({
        workItemId: item.workItemId,
        status: 'NOT_AVAILABLE',
        reasonCode: 'WORK_NOT_AVAILABLE'
      });
      continue;
    }
    try {
      const resolution = resolveInboundWorkReferences(reserved.record.event, dependencies, {
        creationIdempotencyKey: reserved.record.idempotencyKey
      });
      if (resolution.status === 'RETRYABLE_FAILURE') {
        const work = ingressStore.nack(
          item.workItemId,
          dependencies.ownerId,
          dependencies.now,
          resolution.reasonCode,
          dependencies.retryPolicy
        );
        results.push({
          workItemId: item.workItemId,
          status: work.state === 'FAILED_RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
          reasonCode: resolution.reasonCode
        });
        continue;
      }
      if (resolution.status === 'FINAL_FAILURE') {
        ingressStore.failFinal(
          item.workItemId,
          dependencies.ownerId,
          dependencies.now,
          resolution.reasonCode
        );
        results.push({
          workItemId: item.workItemId,
          status: 'FAILED_FINAL',
          reasonCode: resolution.reasonCode
        });
        continue;
      }
      const command = createGatewayCommand(reserved.record.event);
      ingressStore.ack(item.workItemId, dependencies.ownerId, dependencies.now);
      results.push({
        workItemId: item.workItemId,
        command,
        status: 'COMPLETED',
        reasonCode: 'EVENT_PROCESSED'
      });
    } catch (error) {
      const reasonCode = error instanceof GatewayError ? error.code : 'PROCESSING_FAILED';
      const work = ingressStore.nack(
        item.workItemId,
        dependencies.ownerId,
        dependencies.now,
        reasonCode,
        dependencies.retryPolicy
      );
      results.push({
        workItemId: item.workItemId,
        status: work.state === 'FAILED_RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
        reasonCode
      });
    }
  }
  return results;
}
