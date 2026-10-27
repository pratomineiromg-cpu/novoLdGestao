import { InjectedHmacDigestVerifier, timingSafeSecretEqual } from '../crypto';
import type { WebhookHandshakeRequest, WebhookHandshakeResult, WebhookHandshakeVerifier } from '../handshake';
import type { SecretRef } from '../operability';
import type { RawWebhookRequest } from '../rawWebhook';
import { resolveSecretBytes, UnconfiguredSecretResolver, type SecretResolver } from '../secrets';
import type { WebhookAuthenticationResult, WebhookAuthenticator } from '../webhookAuth';

export const META_SECURITY_EVIDENCE = Object.freeze({
  provenance: 'META_OFFICIAL_ARCHIVED',
  reconfirmation: 'PENDING_CURRENT_META_RECONFIRMATION',
  signature: 'OFFLINE_SIGNATURE_PROTOCOL_IMPLEMENTED',
  handshake: 'OFFLINE_HANDSHAKE_PROTOCOL_IMPLEMENTED'
} as const);

export interface MetaWebhookSecurityConfig {
  appSecretRef?: SecretRef;
  verifyTokenRef?: SecretRef;
  /** LOCAL DEPLOYMENT SECURITY POLICY, not an official provider limit. */
  maxWebhookBodyBytes: number;
}

export class MetaWebhookAuthenticator implements WebhookAuthenticator {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;
  readonly status: 'CONFIGURED' | 'NOT_CONFIGURED';
  #resolver: SecretResolver;
  #ref?: SecretRef;

  constructor(ref?: SecretRef, resolver: SecretResolver = new UnconfiguredSecretResolver()) {
    this.#ref = ref;
    this.#resolver = resolver;
    this.status = ref ? 'CONFIGURED' : 'NOT_CONFIGURED';
  }

  verify(request: RawWebhookRequest): WebhookAuthenticationResult {
    const result = (status: WebhookAuthenticationResult['status'], reasonCode: string): WebhookAuthenticationResult => ({
      status, reasonCode, provider: this.provider, requestId: request.requestId,
      evaluatedAt: new Date(request.receivedAt.getTime())
    });
    const signature = request.headers['x-hub-signature-256'];
    if (signature === undefined) return result('REJECTED', 'SIGNATURE_MISSING');
    if (typeof signature !== 'string' || signature.length !== 71 || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
      return result('REJECTED', 'SIGNATURE_MALFORMED');
    }
    const secret = resolveSecretBytes(this.#resolver, this.#ref);
    if (!secret) return result('NOT_CONFIGURED', 'APP_SECRET_NOT_CONFIGURED');
    const verified = new InjectedHmacDigestVerifier('sha256', secret).verify({
      rawBody: request.rawBody,
      presentedDigest: Buffer.from(signature.slice(7), 'hex')
    });
    return result(verified ? 'VERIFIED' : 'REJECTED', verified ? 'SIGNATURE_VERIFIED' : 'SIGNATURE_MISMATCH');
  }
}

export class MetaWebhookHandshakeVerifier implements WebhookHandshakeVerifier {
  #resolver: SecretResolver;
  #ref?: SecretRef;

  constructor(ref?: SecretRef, resolver: SecretResolver = new UnconfiguredSecretResolver()) {
    this.#ref = ref;
    this.#resolver = resolver;
  }

  verify(request: WebhookHandshakeRequest): WebhookHandshakeResult {
    const result = (status: WebhookHandshakeResult['status'], reasonCode: string): WebhookHandshakeResult => ({
      status, reasonCode, provider: 'WHATSAPP_META_OFFICIAL', requestId: request.requestId,
      evaluatedAt: new Date(request.receivedAt.getTime())
    });
    if (request.provider !== 'WHATSAPP_META_OFFICIAL' || request.fields['hub.mode'] !== 'subscribe') {
      return result('REJECTED', 'HANDSHAKE_MODE_INVALID');
    }
    const token = request.fields['hub.verify_token'];
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      return result('REJECTED', 'VERIFY_TOKEN_MISMATCH');
    }
    const challenge = request.fields['hub.challenge'];
    // Local response policy: bounded numeric text; never reflect arbitrary query content.
    if (typeof challenge !== 'string' || challenge.length < 1 || challenge.length > 256 || /[^0-9]/.test(challenge)) {
      return result('REJECTED', 'HANDSHAKE_CHALLENGE_INVALID');
    }
    const expected = resolveSecretBytes(this.#resolver, this.#ref);
    if (!expected) return result('NOT_CONFIGURED', 'VERIFY_TOKEN_NOT_CONFIGURED');
    const match = timingSafeSecretEqual(new TextEncoder().encode(token), expected);
    return result(match ? 'VERIFIED' : 'REJECTED', match ? 'VERIFY_TOKEN_MATCH' : 'VERIFY_TOKEN_MISMATCH');
  }
}

export interface MetaHandshakeHttpResult {
  statusCode: number;
  body: string;
  contentType: 'text/plain; charset=utf-8';
  reason: string;
  status: WebhookHandshakeResult['status'];
}

/** HTTP error status codes are LOCAL IMPLEMENTATION POLICY. */
export function evaluateMetaHandshake(
  request: RawWebhookRequest,
  verifier: MetaWebhookHandshakeVerifier
): MetaHandshakeHttpResult {
  const result = verifier.verify({
    provider: 'WHATSAPP_META_OFFICIAL', requestId: request.requestId,
    fields: request.query, receivedAt: request.receivedAt
  });
  return {
    statusCode: result.status === 'VERIFIED' ? 200 : result.status === 'NOT_CONFIGURED' ? 503 : 403,
    body: result.status === 'VERIFIED' ? request.query['hub.challenge'] : '',
    contentType: 'text/plain; charset=utf-8', reason: result.reasonCode, status: result.status
  };
}
