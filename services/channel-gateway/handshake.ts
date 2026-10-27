import type { ChannelProvider } from '../../src/domain/omnichannel';

export interface WebhookHandshakeRequest {
  provider: ChannelProvider;
  requestId: string;
  fields: Readonly<Record<string, string>>;
  receivedAt: Date;
}

export type WebhookHandshakeStatus =
  | 'VERIFIED'
  | 'REJECTED'
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED';

export interface WebhookHandshakeResult {
  status: WebhookHandshakeStatus;
  reasonCode: string;
  provider: ChannelProvider;
  requestId: string;
  evaluatedAt: Date;
}

export interface WebhookHandshakeVerifier {
  verify(request: WebhookHandshakeRequest): WebhookHandshakeResult;
}

/** No provider challenge field names or live protocol are assumed. */
export class UnconfiguredWebhookHandshakeVerifier implements WebhookHandshakeVerifier {
  verify(request: WebhookHandshakeRequest): WebhookHandshakeResult {
    return {
      status: 'NOT_CONFIGURED',
      reasonCode: 'HANDSHAKE_NOT_CONFIGURED',
      provider: request.provider,
      requestId: request.requestId,
      evaluatedAt: new Date(request.receivedAt.getTime())
    };
  }
}
