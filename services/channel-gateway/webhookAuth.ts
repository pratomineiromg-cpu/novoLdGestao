import type { ChannelProvider } from '../../src/domain/omnichannel';
import type { RawWebhookRequest } from './rawWebhook';

export type WebhookAuthenticationStatus = 'VERIFIED' | 'REJECTED' | 'NOT_CONFIGURED';

export interface WebhookAuthenticationResult {
  status: WebhookAuthenticationStatus;
  reasonCode: string;
  provider: ChannelProvider;
  requestId: string;
  evaluatedAt: Date;
}

export interface WebhookAuthenticator {
  readonly provider: ChannelProvider;
  readonly status: 'NOT_CONFIGURED' | 'CONFIGURED';
  verify(request: RawWebhookRequest): WebhookAuthenticationResult;
}

/** Explicit future boundary. NOT_CONFIGURED is never equivalent to VERIFIED. */
export class UnconfiguredWebhookAuthenticator implements WebhookAuthenticator {
  readonly status = 'NOT_CONFIGURED' as const;

  constructor(readonly provider: ChannelProvider = 'WHATSAPP_META_OFFICIAL') {}

  verify(request: RawWebhookRequest): WebhookAuthenticationResult {
    return {
      status: 'NOT_CONFIGURED',
      reasonCode: 'WEBHOOK_AUTH_NOT_CONFIGURED',
      provider: this.provider,
      requestId: request.requestId,
      evaluatedAt: new Date(request.receivedAt.getTime())
    };
  }
}
