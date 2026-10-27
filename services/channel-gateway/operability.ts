import type { ChannelProvider, CommunicationChannel } from '../../src/domain/omnichannel';
import type { GatewayErrorCode, PreparedOutboundMessage } from './contracts';
import type { GatewayFailureCategory } from './errors';

export interface RateLimitObservation {
  category: 'RATE_LIMITED';
  /** Provider-supplied hint only; no provider quota is hardcoded. */
  retryAfterMs?: number;
  observedAt: Date;
}

export interface RateLimitPolicy {
  selectDelayMs(observation: RateLimitObservation, policyDelayMs: number): number;
}

export class ProviderHintRateLimitPolicy implements RateLimitPolicy {
  selectDelayMs(observation: RateLimitObservation, policyDelayMs: number): number {
    return Math.max(0, policyDelayMs, observation.retryAfterMs ?? 0);
  }
}

export type GatewayOperationalStage =
  | 'AUTHENTICATION'
  | 'DECODING'
  | 'IDEMPOTENCY'
  | 'IDENTITY_RESOLUTION'
  | 'CONVERSATION_RESOLUTION'
  | 'QUEUE'
  | 'DOWNSTREAM_IDEMPOTENCY'
  | 'COMMAND_HANDLING'
  | 'ACKNOWLEDGMENT'
  | 'TRANSPORT';

export type GatewayOperationalReasonCode =
  | GatewayErrorCode
  | 'EVENT_ACCEPTED'
  | 'OPERATION_COMPLETED'
  | 'COMMAND_HANDLER_FAILED'
  | 'ACKNOWLEDGMENT_UNCONFIRMED'
  | 'STATE_TRANSITION_UNCONFIRMED'
  | 'DOWNSTREAM_DUPLICATE'
  | 'IDEMPOTENCY_CONFLICT';

export interface GatewayMetricEvent {
  provider: ChannelProvider;
  channel: CommunicationChannel;
  stage: GatewayOperationalStage;
  outcome: 'SUCCESS' | 'FAILURE';
  reasonCode: GatewayOperationalReasonCode;
  durationBucket: 'LT_10_MS' | 'LT_100_MS' | 'LT_1_S' | 'GTE_1_S';
  retryCount: number;
  duplicate: boolean;
  correlationId: string;
  timestamp: string;
}

export interface GatewayOperationalEvent extends Omit<GatewayMetricEvent, 'durationBucket'> {
  healthImpact: 'NONE' | 'DEGRADED' | 'UNHEALTHY';
}

export interface GatewayOperationalEventSink {
  emit(event: GatewayOperationalEvent): void;
}

export class NoopGatewayOperationalEventSink implements GatewayOperationalEventSink {
  emit(_event: GatewayOperationalEvent): void {}
}

/** Process-local test/reference collector. It stores only the safe event schema. */
export class InMemoryGatewayOperationalEventSink implements GatewayOperationalEventSink {
  private readonly events: GatewayOperationalEvent[] = [];

  emit(event: GatewayOperationalEvent): void {
    this.events.push({ ...event });
  }

  list(): readonly GatewayOperationalEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export function createGatewayOperationalEvent(
  input: Omit<GatewayOperationalEvent, 'healthImpact'> & {
    healthImpact?: GatewayOperationalEvent['healthImpact'];
  }
): GatewayOperationalEvent {
  return {
    provider: input.provider,
    channel: input.channel,
    stage: input.stage,
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    retryCount: input.retryCount,
    duplicate: input.duplicate,
    correlationId: input.correlationId,
    timestamp: input.timestamp,
    healthImpact: input.healthImpact ?? (input.outcome === 'SUCCESS' ? 'NONE' : 'DEGRADED')
  };
}

/** Observability is best-effort and must never change business processing. */
export function emitGatewayOperationalEventSafely(
  sink: GatewayOperationalEventSink | undefined,
  event: GatewayOperationalEvent
): void {
  try {
    sink?.emit(event);
  } catch {
    // Runtime exporters are outside F1B-14; a failing sink cannot fail the worker.
  }
}

export function createGatewayMetricEvent(
  input: Omit<GatewayMetricEvent, 'durationBucket'> & { durationMs: number }
): GatewayMetricEvent {
  return {
    provider: input.provider,
    channel: input.channel,
    stage: input.stage,
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    durationBucket: durationBucket(input.durationMs),
    retryCount: input.retryCount,
    duplicate: input.duplicate,
    correlationId: input.correlationId,
    timestamp: input.timestamp
  };
}

export function durationBucket(durationMs: number): GatewayMetricEvent['durationBucket'] {
  if (durationMs < 10) return 'LT_10_MS';
  if (durationMs < 100) return 'LT_100_MS';
  if (durationMs < 1_000) return 'LT_1_S';
  return 'GTE_1_S';
}

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
export type ReadinessStatus = 'READY' | 'NOT_READY';

export interface GatewayHealth {
  status: HealthStatus;
  checkedAt: Date;
  reasonCodes: readonly string[];
}

/** Compiled F1B-09 phase gates cannot be bypassed with optimistic config flags. */
export const META_OFFLINE_LIVE_BLOCKERS = [
  'CURRENT_META_PROTOCOL_RECONFIRMATION_REQUIRED',
  'REAL_SECRET_PROVISIONING_REQUIRED',
  'HTTPS_RUNTIME_NOT_CONFIGURED',
  'PRODUCTION_DURABLE_STORE_NOT_CONFIGURED',
  'SERVER_PERSISTENCE_NOT_CONFIGURED',
  'RUNTIME_OBSERVABILITY_NOT_CONFIGURED',
  'DEPLOYMENT_NOT_HARDENED'
] as const;

export type ProviderReadinessReason = typeof META_OFFLINE_LIVE_BLOCKERS[number]
  | 'OFFICIAL_PROTOCOL_NOT_VERIFIED'
  | 'OFFICIAL_SIGNATURE_PROTOCOL_NOT_VERIFIED'
  | 'OFFICIAL_HANDSHAKE_PROTOCOL_NOT_VERIFIED'
  | 'WABA_SUBSCRIPTION_NOT_CONFIGURED'
  | 'WEBHOOK_VERIFY_TOKEN_NOT_CONFIGURED'
  | 'HTTPS_INGRESS_NOT_CONFIGURED'
  | 'TLS_CERTIFICATE_NOT_CONFIGURED'
  | 'WEBHOOK_AUTH_NOT_CONFIGURED'
  | 'DURABLE_IDEMPOTENCY_NOT_CONFIGURED'
  | 'DURABLE_PERSISTENCE_NOT_CONFIGURED'
  | 'TRANSPORT_NOT_CONFIGURED'
  | 'PERSISTENCE_NOT_CONFIGURED'
  | 'RUNTIME_NOT_CONFIGURED';

export interface ProviderReadinessInput {
  provider: ChannelProvider;
  officialProtocolVerified?: boolean;
  officialSignatureProtocolVerified?: boolean;
  officialHandshakeProtocolVerified?: boolean;
  wabaSubscriptionConfigured?: boolean;
  webhookVerifyTokenConfigured?: boolean;
  httpsIngressConfigured?: boolean;
  tlsCertificateConfigured?: boolean;
  webhookAuthConfigured?: boolean;
  durableIdempotencyConfigured?: boolean;
  durablePersistenceConfigured?: boolean;
  transportConfigured: boolean;
  persistenceConfigured?: boolean;
  runtimeConfigured?: boolean;
}

export interface ProviderLiveReadiness {
  provider: ChannelProvider;
  status: ReadinessStatus;
  reasons: readonly ProviderReadinessReason[];
}

export function evaluateProviderLiveReadiness(
  input: ProviderReadinessInput
): ProviderLiveReadiness {
  const reasons: ProviderReadinessReason[] = [];

  if (input.provider === 'WHATSAPP_META_OFFICIAL') {
    // Offline archived implementation is not current live verification.
    reasons.push('OFFICIAL_SIGNATURE_PROTOCOL_NOT_VERIFIED');
    reasons.push('OFFICIAL_HANDSHAKE_PROTOCOL_NOT_VERIFIED');
    reasons.push(...META_OFFLINE_LIVE_BLOCKERS);
    if (!input.wabaSubscriptionConfigured) {
      reasons.push('WABA_SUBSCRIPTION_NOT_CONFIGURED');
    }
    if (!input.webhookVerifyTokenConfigured) {
      reasons.push('WEBHOOK_VERIFY_TOKEN_NOT_CONFIGURED');
    }
    if (!input.httpsIngressConfigured) {
      reasons.push('HTTPS_INGRESS_NOT_CONFIGURED');
    }
    if (!input.tlsCertificateConfigured) {
      reasons.push('TLS_CERTIFICATE_NOT_CONFIGURED');
    }
    if (!input.transportConfigured) {
      reasons.push('TRANSPORT_NOT_CONFIGURED');
    }
    if (!input.durablePersistenceConfigured) {
      reasons.push('DURABLE_PERSISTENCE_NOT_CONFIGURED');
    }
  } else {
    if (!input.officialProtocolVerified) reasons.push('OFFICIAL_PROTOCOL_NOT_VERIFIED');
    if (!input.webhookAuthConfigured) reasons.push('WEBHOOK_AUTH_NOT_CONFIGURED');
    if (!input.durableIdempotencyConfigured) reasons.push('DURABLE_IDEMPOTENCY_NOT_CONFIGURED');
    if (!input.transportConfigured) reasons.push('TRANSPORT_NOT_CONFIGURED');
    if (!input.persistenceConfigured) reasons.push('PERSISTENCE_NOT_CONFIGURED');
    if (!input.runtimeConfigured) reasons.push('RUNTIME_NOT_CONFIGURED');
  }

  return {
    provider: input.provider,
    status: reasons.length === 0 ? 'READY' : 'NOT_READY',
    reasons
  };
}

export interface SecretRef {
  /** Opaque secret-manager reference; never secret material. */
  id: string;
}

export interface ProviderSafeConfig {
  provider: ChannelProvider;
  channel: CommunicationChannel;
  enabled: boolean;
  requestTimeoutMs: number;
  retryPolicyRef: string;
}

export interface ProviderSecretRefs {
  authentication: SecretRef;
  webhookVerification: SecretRef;
  webhookVerifyToken?: SecretRef;
}

export type ProviderTransportResult =
  | { status: 'PROVIDER_ACCEPTED'; providerReceiptId?: string }
  | { status: 'NOT_CONFIGURED'; reasonCode: 'TRANSPORT_NOT_CONFIGURED' }
  | { status: 'FAILED'; category: GatewayFailureCategory; retryAfterMs?: number };

export interface ProviderTransport {
  sendPreparedMessage(message: PreparedOutboundMessage): ProviderTransportResult;
}

export class UnconfiguredProviderTransport implements ProviderTransport {
  sendPreparedMessage(_message: PreparedOutboundMessage): ProviderTransportResult {
    return { status: 'NOT_CONFIGURED', reasonCode: 'TRANSPORT_NOT_CONFIGURED' };
  }
}
