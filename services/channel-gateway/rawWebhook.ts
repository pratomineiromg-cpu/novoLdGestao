import type { ChannelProvider } from '../../src/domain/omnichannel';
import type { NormalizedChannelEvent } from './contracts';
import { GatewayError } from './errors';

export type RequestTrustMode = 'LIVE_UNTRUSTED' | 'TRUSTED_SYNTHETIC_FIXTURE';

export interface RawWebhookRequest {
  method: string;
  path?: string;
  /** Exact bytes captured before JSON parsing. */
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  receivedAt: Date;
  requestId: string;
  trustMode: 'LIVE_UNTRUSTED';
}

export interface CreateLiveWebhookRequestInput {
  method: string;
  path?: string;
  rawBody: Uint8Array;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  query?: Readonly<Record<string, string>>;
  receivedAt: Date;
  requestId: string;
}

function normalizeHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    const text = typeof value === 'string' ? value : value.join(',');
    // Preserve ambiguity so a security adapter can reject duplicate headers.
    normalized[key] = Object.hasOwn(normalized, key) ? `${normalized[key]},${text}` : text;
  }
  return Object.freeze(normalized);
}

export function createLiveWebhookRequest(input: CreateLiveWebhookRequestInput): RawWebhookRequest {
  if (
    input.method.trim().length === 0 ||
    input.requestId.trim().length === 0 ||
    Number.isNaN(input.receivedAt.getTime()) ||
    !(input.rawBody instanceof Uint8Array)
  ) {
    throw new GatewayError('MALFORMED_REQUEST');
  }
  return Object.freeze({
    method: input.method.toUpperCase(),
    path: input.path,
    rawBody: new Uint8Array(input.rawBody),
    headers: normalizeHeaders(input.headers ?? {}),
    query: Object.freeze({ ...(input.query ?? {}) }),
    receivedAt: new Date(input.receivedAt.getTime()),
    requestId: input.requestId,
    trustMode: 'LIVE_UNTRUSTED' as const
  });
}

export interface DecodedRawWebhookJson {
  provider: ChannelProvider;
  requestId: string;
  value: unknown;
  /** Retained copy proving parsing does not replace the authenticated bytes. */
  rawBody: Uint8Array;
}

export function decodeRawWebhookJson(
  request: RawWebhookRequest,
  provider: ChannelProvider
): DecodedRawWebhookJson {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(request.rawBody);
    return {
      provider,
      requestId: request.requestId,
      value: JSON.parse(text) as unknown,
      rawBody: new Uint8Array(request.rawBody)
    };
  } catch {
    throw new GatewayError('MALFORMED_REQUEST');
  }
}

export interface ProviderRawDecoder {
  readonly provider: ChannelProvider;
  /** Provider-specific live decode after authentication. */
  decode(
    request: RawWebhookRequest,
    context: { createInternalEventId: () => string }
  ): NormalizedChannelEvent;
}
