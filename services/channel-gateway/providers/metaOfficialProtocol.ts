import type {
  DecodedProviderBatch,
  DecodedProviderBatchItem,
  GatewayNormalizationContext,
  NormalizedChannelEvent,
  ProviderBatchDecoder,
  SourceCoordinates
} from '../contracts';
import { GatewayError } from '../errors';
import {
  decodeRawWebhookJson,
  type ProviderRawDecoder,
  type RawWebhookRequest
} from '../rawWebhook';
import type { SecretRef } from '../operability';
import { META_SECURITY_EVIDENCE } from './metaWebhookSecurity';

export const META_OFFICIAL_WEBHOOK_OBJECT = 'whatsapp_business_account' as const;
export const META_OFFICIAL_MESSAGES_FIELD = 'messages' as const;
export const META_OFFICIAL_MESSAGING_PRODUCT = 'whatsapp' as const;

export type MetaOfficialMessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface MetaWebhookMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface MetaWebhookTextMessage {
  id: string;
  from: string;
  timestamp: string;
  type: 'text';
  text: {
    body: string;
  };
}

export interface MetaWebhookUnsupportedMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
}

export type MetaWebhookMessage = MetaWebhookTextMessage | MetaWebhookUnsupportedMessage;

export interface MetaWebhookStatus {
  id: string;
  status: MetaOfficialMessageStatus | string;
  timestamp: string;
}

export interface MetaWebhookValue {
  messaging_product: typeof META_OFFICIAL_MESSAGING_PRODUCT;
  metadata: MetaWebhookMetadata;
  messages?: readonly MetaWebhookMessage[];
  statuses?: readonly MetaWebhookStatus[];
}

export interface MetaWebhookChange {
  field: typeof META_OFFICIAL_MESSAGES_FIELD;
  value: MetaWebhookValue;
}

export interface MetaWebhookEntry {
  id: string;
  changes: readonly MetaWebhookChange[];
}

export interface MetaWebhookEnvelope {
  object: typeof META_OFFICIAL_WEBHOOK_OBJECT;
  entry: readonly MetaWebhookEntry[];
}

export type MetaOfficialUnsupportedReason =
  | 'UNSUPPORTED_MESSAGE_TYPE'
  | 'UNSUPPORTED_STATUS'
  | 'UNSUPPORTED_EMPTY_CHANGE'
  | 'INVALID_ITEM';

export type MetaOfficialProviderEvent =
  | {
      kind: 'message';
      providerEventId: string;
      providerMessageId: string;
      providerAddress: string;
      providerTimestamp: string;
      occurredAt: Date;
      text: string;
      externalConversationId: string;
      sourceCoordinates?: SourceCoordinates;
    }
  | {
      kind: 'status';
      providerEventId: string;
      providerMessageId: string;
      providerTimestamp: string;
      occurredAt: Date;
      status: MetaOfficialMessageStatus;
      sourceCoordinates?: SourceCoordinates;
    }
  | {
      kind: 'unsupported_event';
      providerEventId: string;
      reason: MetaOfficialUnsupportedReason;
      sourceCoordinates?: SourceCoordinates;
    };

export interface MetaWabaSubscriptionContract {
  provider: 'WHATSAPP_META_OFFICIAL';
  required: true;
  configured: boolean;
  managementAuthentication: 'NOT_CONFIGURED';
}

export interface MetaWebhookVerifyTokenBoundary {
  provider: 'WHATSAPP_META_OFFICIAL';
  verifyTokenRef?: SecretRef;
  challengeProtocol: 'PENDING_OFFICIAL_SPEC_VERIFICATION';
}

export interface MetaOfficialProtocolReadinessContract {
  offlineSecurity: typeof META_SECURITY_EVIDENCE;
  wabaSubscription: MetaWabaSubscriptionContract;
  webhookVerifyToken: MetaWebhookVerifyTokenBoundary;
  genericCryptoPrimitive: 'READY';
  metaPostSignatureProtocol: 'PENDING_OFFICIAL_SPEC_VERIFICATION';
}

const SUPPORTED_STATUSES: readonly MetaOfficialMessageStatus[] = [
  'sent',
  'delivered',
  'read',
  'failed'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayError('INVALID_EVENT');
  }
  return value.trim();
}

function requiredRecord(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (!isRecord(value)) {
    throw new GatewayError('INVALID_EVENT');
  }
  return value;
}

function optionalArray(record: Record<string, unknown>, field: string): readonly unknown[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new GatewayError('INVALID_EVENT');
  }
  return value;
}

function requiredArray(record: Record<string, unknown>, field: string): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new GatewayError('INVALID_EVENT');
  }
  return value;
}

function parseProviderTimestamp(timestamp: string): Date {
  const trimmed = timestamp.trim();
  if (/^\d+$/.test(trimmed)) {
    const epochSeconds = Number(trimmed);
    if (!Number.isSafeInteger(epochSeconds)) {
      throw new GatewayError('INVALID_EVENT');
    }
    return new Date(epochSeconds * 1_000);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new GatewayError('INVALID_EVENT');
  }
  return parsed;
}

function decodeMetadata(input: unknown): MetaWebhookMetadata {
  if (!isRecord(input)) {
    throw new GatewayError('INVALID_EVENT');
  }
  return {
    display_phone_number: requiredString(input, 'display_phone_number'),
    phone_number_id: requiredString(input, 'phone_number_id')
  };
}

function decodeMessage(input: unknown): MetaWebhookMessage {
  if (!isRecord(input)) {
    throw new GatewayError('INVALID_EVENT');
  }

  const type = requiredString(input, 'type');
  const base = {
    id: requiredString(input, 'id'),
    from: requiredString(input, 'from'),
    timestamp: requiredString(input, 'timestamp'),
    type
  };

  if (type !== 'text') {
    return base;
  }

  const text = requiredRecord(input, 'text');
  return {
    ...base,
    type: 'text',
    text: {
      body: requiredString(text, 'body')
    }
  };
}

function decodeStatus(input: unknown): MetaWebhookStatus {
  if (!isRecord(input)) {
    throw new GatewayError('INVALID_EVENT');
  }

  return {
    id: requiredString(input, 'id'),
    status: requiredString(input, 'status'),
    timestamp: requiredString(input, 'timestamp')
  };
}

function decodeValue(input: unknown): MetaWebhookValue {
  if (!isRecord(input)) {
    throw new GatewayError('INVALID_EVENT');
  }
  if (requiredString(input, 'messaging_product') !== META_OFFICIAL_MESSAGING_PRODUCT) {
    throw new GatewayError('INVALID_EVENT');
  }

  const messages = optionalArray(input, 'messages')?.map(decodeMessage);
  const statuses = optionalArray(input, 'statuses')?.map(decodeStatus);

  return {
    messaging_product: META_OFFICIAL_MESSAGING_PRODUCT,
    metadata: decodeMetadata(input.metadata),
    ...(messages ? { messages } : {}),
    ...(statuses ? { statuses } : {})
  };
}

function decodeChange(input: unknown): MetaWebhookChange {
  if (!isRecord(input)) {
    throw new GatewayError('INVALID_EVENT');
  }
  if (requiredString(input, 'field') !== META_OFFICIAL_MESSAGES_FIELD) {
    throw new GatewayError('INVALID_EVENT');
  }
  return {
    field: META_OFFICIAL_MESSAGES_FIELD,
    value: decodeValue(input.value)
  };
}

function decodeEntry(input: unknown): MetaWebhookEntry {
  if (!isRecord(input)) {
    throw new GatewayError('INVALID_EVENT');
  }
  return {
    id: requiredString(input, 'id'),
    changes: requiredArray(input, 'changes').map(decodeChange)
  };
}

export function decodeMetaWebhookEnvelope(input: unknown): MetaWebhookEnvelope {
  if (!isRecord(input)) {
    throw new GatewayError('INVALID_EVENT');
  }
  if (requiredString(input, 'object') !== META_OFFICIAL_WEBHOOK_OBJECT) {
    throw new GatewayError('INVALID_EVENT');
  }
  return {
    object: META_OFFICIAL_WEBHOOK_OBJECT,
    entry: requiredArray(input, 'entry').map(decodeEntry)
  };
}

function messageEventId(entryId: string, providerMessageId: string): string {
  return `meta:message:${entryId}:${providerMessageId}`;
}

function statusEventId(
  entryId: string,
  providerMessageId: string,
  status: string,
  timestamp: string
): string {
  return `meta:status:${entryId}:${status}:${providerMessageId}:${timestamp}`;
}

export function decodeMetaOfficialWebhookEvents(input: unknown): readonly MetaOfficialProviderEvent[] {
  const envelope = decodeMetaWebhookEnvelope(input);
  const events: MetaOfficialProviderEvent[] = [];

  envelope.entry.forEach((entry, entryIndex) => {
    entry.changes.forEach((change, changeIndex) => {
      const externalConversationId = `${entry.id}:${change.value.metadata.phone_number_id}`;

      if (change.value.messages) {
        change.value.messages.forEach((message, itemIndex) => {
          const sourceCoordinates = { entryIndex, changeIndex, itemIndex };
          const providerEventId = messageEventId(entry.id, message.id);
          if (message.type !== 'text') {
            events.push({
              kind: 'unsupported_event',
              providerEventId,
              reason: 'UNSUPPORTED_MESSAGE_TYPE',
              sourceCoordinates
            });
            return;
          }
          const textMessage = message as MetaWebhookTextMessage;

          events.push({
            kind: 'message',
            providerEventId,
            providerMessageId: textMessage.id,
            providerAddress: textMessage.from,
            providerTimestamp: textMessage.timestamp,
            occurredAt: parseProviderTimestamp(textMessage.timestamp),
            text: textMessage.text.body,
            externalConversationId,
            sourceCoordinates
          });
        });
      }

      if (change.value.statuses) {
        change.value.statuses.forEach((status, itemIndex) => {
          const sourceCoordinates = { entryIndex, changeIndex, itemIndex };
          const providerEventId = statusEventId(entry.id, status.id, status.status, status.timestamp);
          if (!SUPPORTED_STATUSES.includes(status.status as MetaOfficialMessageStatus)) {
            events.push({
              kind: 'unsupported_event',
              providerEventId,
              reason: 'UNSUPPORTED_STATUS',
              sourceCoordinates
            });
            return;
          }

          events.push({
            kind: 'status',
            providerEventId,
            providerMessageId: status.id,
            providerTimestamp: status.timestamp,
            occurredAt: parseProviderTimestamp(status.timestamp),
            status: status.status as MetaOfficialMessageStatus,
            sourceCoordinates
          });
        });
      }

      if (!change.value.messages && !change.value.statuses) {
        events.push({
          kind: 'unsupported_event',
          providerEventId: `meta:unsupported:${entry.id}:${changeIndex}`,
          reason: 'UNSUPPORTED_EMPTY_CHANGE',
          sourceCoordinates: { entryIndex, changeIndex, itemIndex: 0 }
        });
      }
    });
  });

  return events;
}

export function normalizeMetaOfficialProviderEvent(
  event: MetaOfficialProviderEvent,
  context: GatewayNormalizationContext
): NormalizedChannelEvent {
  if (event.kind === 'unsupported_event') {
    throw new GatewayError('UNSUPPORTED_EVENT');
  }

  if (event.kind === 'message') {
    return {
      internalEventId: context.createInternalEventId(),
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      occurredAt: new Date(event.occurredAt.getTime()),
      eventType: 'INBOUND_MESSAGE',
      originSurface: 'CUSTOMER',
      payload: {
        providerAddress: event.providerAddress,
        externalConversationId: event.externalConversationId,
        providerTimestamp: event.providerTimestamp,
        content: {
          contentType: 'TEXT',
          text: event.text
        }
      }
    };
  }

  if (event.status === 'read') {
    return {
      internalEventId: context.createInternalEventId(),
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      occurredAt: new Date(event.occurredAt.getTime()),
      eventType: 'READ_STATUS',
      originSurface: 'PROVIDER',
      payload: {
        readStatus: 'READ',
        providerTimestamp: event.providerTimestamp
      }
    };
  }

  return {
    internalEventId: context.createInternalEventId(),
    provider: 'WHATSAPP_META_OFFICIAL',
    channel: 'WHATSAPP',
    providerEventId: event.providerEventId,
    providerMessageId: event.providerMessageId,
    occurredAt: new Date(event.occurredAt.getTime()),
    eventType: 'DELIVERY_STATUS',
    originSurface: 'PROVIDER',
    payload: {
      deliveryStatus: event.status === 'sent'
        ? 'SENT'
        : event.status === 'delivered'
          ? 'DELIVERED'
          : 'FAILED',
      providerTimestamp: event.providerTimestamp
    }
  };
}

export function createMetaOfficialProtocolReadinessContract(
  verifyTokenRef?: SecretRef
): MetaOfficialProtocolReadinessContract {
  return {
    offlineSecurity: META_SECURITY_EVIDENCE,
    wabaSubscription: {
      provider: 'WHATSAPP_META_OFFICIAL',
      required: true,
      configured: false,
      managementAuthentication: 'NOT_CONFIGURED'
    },
    webhookVerifyToken: {
      provider: 'WHATSAPP_META_OFFICIAL',
      verifyTokenRef,
      challengeProtocol: 'PENDING_OFFICIAL_SPEC_VERIFICATION'
    },
    genericCryptoPrimitive: 'READY',
    metaPostSignatureProtocol: 'PENDING_OFFICIAL_SPEC_VERIFICATION'
  };
}

export class WhatsAppMetaOfficialWebhookDecoder implements ProviderRawDecoder {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;

  decode(
    request: RawWebhookRequest,
    context: GatewayNormalizationContext
  ): NormalizedChannelEvent {
    const parsed = decodeRawWebhookJson(request, this.provider);
    const events = decodeMetaOfficialWebhookEvents(parsed.value);

    if (events.length !== 1) {
      throw new GatewayError('UNSUPPORTED_EVENT');
    }

    return normalizeMetaOfficialProviderEvent(events[0], context);
  }
}

export interface MetaBatchExtractedItem {
  rawEvent: MetaOfficialProviderEvent;
  rawEventKind: 'message' | 'status' | 'unsupported_event';
  event?: NormalizedChannelEvent;
  errorReason?: string;
}

function batchInvalidEvent(
  entryId: string,
  entryIndex: number,
  changeIndex: number,
  itemIndex: number,
  rawEventKind: 'message' | 'status'
): MetaBatchExtractedItem {
  return {
    rawEvent: {
      kind: 'unsupported_event',
      providerEventId: `meta:invalid:${entryId}:${changeIndex}:${rawEventKind}:${itemIndex}`,
      reason: 'INVALID_ITEM',
      sourceCoordinates: { entryIndex, changeIndex, itemIndex }
    },
    rawEventKind,
    errorReason: 'INVALID_EVENT'
  };
}

function decodeMetaOfficialBatchItems(
  input: unknown,
  context: GatewayNormalizationContext
): readonly MetaBatchExtractedItem[] {
  if (!isRecord(input)) throw new GatewayError('INVALID_EVENT');
  if (requiredString(input, 'object') !== META_OFFICIAL_WEBHOOK_OBJECT) {
    throw new GatewayError('INVALID_EVENT');
  }
  const entries = requiredArray(input, 'entry');
  const extracted: MetaBatchExtractedItem[] = [];

  entries.forEach((entryInput, entryIndex) => {
    if (!isRecord(entryInput)) throw new GatewayError('INVALID_EVENT');
    const entryId = requiredString(entryInput, 'id');
    const changes = requiredArray(entryInput, 'changes');

    changes.forEach((changeInput, changeIndex) => {
      if (!isRecord(changeInput)) throw new GatewayError('INVALID_EVENT');
      if (requiredString(changeInput, 'field') !== META_OFFICIAL_MESSAGES_FIELD) {
        throw new GatewayError('INVALID_EVENT');
      }
      const value = requiredRecord(changeInput, 'value');
      if (requiredString(value, 'messaging_product') !== META_OFFICIAL_MESSAGING_PRODUCT) {
        throw new GatewayError('INVALID_EVENT');
      }
      const metadata = decodeMetadata(value.metadata);
      const messages = optionalArray(value, 'messages');
      const statuses = optionalArray(value, 'statuses');
      const externalConversationId = `${entryId}:${metadata.phone_number_id}`;
      let itemIndex = 0;

      for (const messageInput of messages ?? []) {
        const sourceCoordinates = { entryIndex, changeIndex, itemIndex: itemIndex++ };
        try {
          const message = decodeMessage(messageInput);
          const providerEventId = messageEventId(entryId, message.id);
          if (message.type !== 'text') {
            const rawEvent: MetaOfficialProviderEvent = {
              kind: 'unsupported_event',
              providerEventId,
              reason: 'UNSUPPORTED_MESSAGE_TYPE',
              sourceCoordinates
            };
            extracted.push({ rawEvent, rawEventKind: 'unsupported_event', errorReason: 'UNSUPPORTED_EVENT' });
            continue;
          }
          const textMessage = message as MetaWebhookTextMessage;
          const rawEvent: MetaOfficialProviderEvent = {
            kind: 'message',
            providerEventId,
            providerMessageId: textMessage.id,
            providerAddress: textMessage.from,
            providerTimestamp: textMessage.timestamp,
            occurredAt: parseProviderTimestamp(textMessage.timestamp),
            text: textMessage.text.body,
            externalConversationId,
            sourceCoordinates
          };
          extracted.push({
            rawEvent,
            rawEventKind: 'message',
            event: normalizeMetaOfficialProviderEvent(rawEvent, context)
          });
        } catch {
          extracted.push(batchInvalidEvent(entryId, entryIndex, changeIndex, sourceCoordinates.itemIndex, 'message'));
        }
      }

      for (const statusInput of statuses ?? []) {
        const sourceCoordinates = { entryIndex, changeIndex, itemIndex: itemIndex++ };
        try {
          const status = decodeStatus(statusInput);
          const providerEventId = statusEventId(entryId, status.id, status.status, status.timestamp);
          if (!SUPPORTED_STATUSES.includes(status.status as MetaOfficialMessageStatus)) {
            const rawEvent: MetaOfficialProviderEvent = {
              kind: 'unsupported_event',
              providerEventId,
              reason: 'UNSUPPORTED_STATUS',
              sourceCoordinates
            };
            extracted.push({ rawEvent, rawEventKind: 'unsupported_event', errorReason: 'UNSUPPORTED_EVENT' });
            continue;
          }
          const rawEvent: MetaOfficialProviderEvent = {
            kind: 'status',
            providerEventId,
            providerMessageId: status.id,
            providerTimestamp: status.timestamp,
            occurredAt: parseProviderTimestamp(status.timestamp),
            status: status.status as MetaOfficialMessageStatus,
            sourceCoordinates
          };
          extracted.push({
            rawEvent,
            rawEventKind: 'status',
            event: normalizeMetaOfficialProviderEvent(rawEvent, context)
          });
        } catch {
          extracted.push(batchInvalidEvent(entryId, entryIndex, changeIndex, sourceCoordinates.itemIndex, 'status'));
        }
      }

      if (!messages && !statuses) {
        const rawEvent: MetaOfficialProviderEvent = {
          kind: 'unsupported_event',
          providerEventId: `meta:unsupported:${entryId}:${changeIndex}`,
          reason: 'UNSUPPORTED_EMPTY_CHANGE',
          sourceCoordinates: { entryIndex, changeIndex, itemIndex: 0 }
        };
        extracted.push({ rawEvent, rawEventKind: 'unsupported_event', errorReason: 'UNSUPPORTED_EVENT' });
      }
    });
  });

  if (extracted.length === 0) throw new GatewayError('INVALID_EVENT');
  return extracted;
}

export class MetaOfficialBatchWebhookDecoder implements ProviderBatchDecoder {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;
  readonly channel = 'WHATSAPP' as const;

  decodeItems(
    request: RawWebhookRequest,
    context: GatewayNormalizationContext
  ): readonly MetaBatchExtractedItem[] {
    const parsed = decodeRawWebhookJson(request, this.provider);
    return decodeMetaOfficialBatchItems(parsed.value, context);
  }

  decodeBatch(
    request: RawWebhookRequest,
    context: GatewayNormalizationContext
  ): DecodedProviderBatch {
    const items = this.decodeItems(request, context);
    return {
      requestId: request.requestId,
      provider: this.provider,
      channel: this.channel,
      batchId: context.createInternalEventId(),
      receivedAt: new Date(request.receivedAt.getTime()),
      decodedAt: new Date(),
      items: items.map((item) => ({
        itemId: context.createInternalEventId(),
        providerEventId: item.rawEvent.providerEventId,
        providerMessageId: 'providerMessageId' in item.rawEvent ? item.rawEvent.providerMessageId : undefined,
        rawEventKind: item.rawEventKind,
        sourceCoordinates: item.rawEvent.sourceCoordinates,
        event: item.event,
        providerTimestamp: 'providerTimestamp' in item.rawEvent ? item.rawEvent.providerTimestamp : undefined,
        errorReason: item.errorReason
      }))
    };
  }

  decodeBatchEnvelope(
    request: RawWebhookRequest,
    context: GatewayNormalizationContext
  ): DecodedProviderBatch {
    return this.decodeBatch(request, context);
  }
}
