import type { GatewayRetryability } from './contracts';

export interface RetryPolicyInput {
  attempt: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryability: GatewayRetryability;
}

export interface RetryDecision {
  retry: boolean;
  nextAttempt: number | null;
  delayMs: number | null;
  reason: 'RETRY_SCHEDULED' | 'MAX_ATTEMPTS_REACHED' | 'NON_RETRYABLE';
}

/** Mathematical policy only: no clock, wait, timer, queue, or transport. */
export function calculateRetryDecision(input: RetryPolicyInput): RetryDecision {
  if (
    !Number.isInteger(input.attempt) ||
    !Number.isInteger(input.maxAttempts) ||
    input.attempt < 1 ||
    input.maxAttempts < 1 ||
    input.baseDelayMs < 0 ||
    input.maxDelayMs < 0
  ) {
    throw new Error('INVALID_RETRY_POLICY');
  }
  if (input.retryability === 'NON_RETRYABLE') {
    return { retry: false, nextAttempt: null, delayMs: null, reason: 'NON_RETRYABLE' };
  }
  if (input.attempt >= input.maxAttempts) {
    return { retry: false, nextAttempt: null, delayMs: null, reason: 'MAX_ATTEMPTS_REACHED' };
  }
  const delayMs = Math.min(
    input.maxDelayMs,
    input.baseDelayMs * (2 ** (input.attempt - 1))
  );
  return {
    retry: true,
    nextAttempt: input.attempt + 1,
    delayMs,
    reason: 'RETRY_SCHEDULED'
  };
}
