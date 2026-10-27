import type { GatewayErrorCode, GatewayRetryability } from './contracts';

export type GatewayFailureCategory =
  | 'RETRYABLE'
  | 'NON_RETRYABLE'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'PROVIDER_UNAVAILABLE'
  | 'MALFORMED_REQUEST'
  | 'UNKNOWN_PROVIDER_ERROR';

const RETRYABLE_CODES: ReadonlySet<GatewayErrorCode> = new Set([
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'UNKNOWN_PROVIDER_ERROR'
]);

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryability: GatewayRetryability;

  constructor(code: GatewayErrorCode) {
    super(code);
    this.name = 'GatewayError';
    this.code = code;
    this.retryability = RETRYABLE_CODES.has(code) ? 'RETRYABLE' : 'NON_RETRYABLE';
  }
}

export function classifyGatewayError(code: GatewayErrorCode): GatewayRetryability {
  return RETRYABLE_CODES.has(code) ? 'RETRYABLE' : 'NON_RETRYABLE';
}

export function classifyGatewayFailure(code: GatewayErrorCode): GatewayFailureCategory {
  if (code === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (code === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (code === 'PROVIDER_UNAVAILABLE') return 'PROVIDER_UNAVAILABLE';
  if (code === 'MALFORMED_REQUEST' || code === 'INVALID_EVENT') return 'MALFORMED_REQUEST';
  if (code === 'UNKNOWN_PROVIDER_ERROR') return 'UNKNOWN_PROVIDER_ERROR';
  return classifyGatewayError(code);
}
