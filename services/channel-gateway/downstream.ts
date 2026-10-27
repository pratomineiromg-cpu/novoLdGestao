import { isGatewayErrorCode, type GatewayCommand, type GatewayErrorCode } from './contracts';
import type {
  InboundCommandExecution,
  InboundCommandHandler,
  InboundCommandHandlingResult
} from './inboundWorker';
import {
  createGatewayOperationalEvent,
  emitGatewayOperationalEventSafely,
  type GatewayOperationalEventSink
} from './operability';

export type DownstreamExecutionState =
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL';

/** Payload-free journal record. Command/event content must never be stored here. */
export interface DownstreamExecutionRecord {
  idempotencyKey: string;
  workItemId: string;
  commandType: GatewayCommand['type'];
  state: DownstreamExecutionState;
  attempt: number;
  reasonCode?: GatewayErrorCode;
  updatedAt: Date;
}

export interface BeginDownstreamExecutionInput {
  idempotencyKey: string;
  workItemId: string;
  commandType: GatewayCommand['type'];
  attempt: number;
  now: Date;
}

export type BeginDownstreamExecutionResult =
  | { status: 'STARTED'; record: DownstreamExecutionRecord }
  | { status: 'ALREADY_COMPLETED'; record: DownstreamExecutionRecord }
  | { status: 'FAILED_FINAL'; record: DownstreamExecutionRecord }
  | { status: 'IDEMPOTENCY_CONFLICT'; record: DownstreamExecutionRecord };

export interface DownstreamExecutionJournal {
  begin(input: BeginDownstreamExecutionInput): BeginDownstreamExecutionResult;
  complete(idempotencyKey: string, now: Date): DownstreamExecutionRecord;
  fail(
    idempotencyKey: string,
    now: Date,
    retryability: 'RETRYABLE' | 'FINAL',
    reasonCode: GatewayErrorCode
  ): DownstreamExecutionRecord;
  get(idempotencyKey: string): DownstreamExecutionRecord | undefined;
}

function copyRecord(record: DownstreamExecutionRecord): DownstreamExecutionRecord {
  return { ...record, updatedAt: new Date(record.updatedAt.getTime()) };
}

/**
 * Process-local reference journal. F1B-15 must replace this with a durable,
 * atomic adapter before any hosted worker is considered.
 */
export class InMemoryDownstreamExecutionJournal implements DownstreamExecutionJournal {
  private readonly records = new Map<string, DownstreamExecutionRecord>();

  begin(input: BeginDownstreamExecutionInput): BeginDownstreamExecutionResult {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.workItemId.trim().length === 0 ||
      !Number.isInteger(input.attempt) ||
      input.attempt < 1 ||
      Number.isNaN(input.now.getTime())
    ) {
      throw new Error('INVALID_DOWNSTREAM_EXECUTION_INPUT');
    }

    const existing = this.records.get(input.idempotencyKey);
    if (existing) {
      if (existing.workItemId !== input.workItemId || existing.commandType !== input.commandType) {
        return { status: 'IDEMPOTENCY_CONFLICT', record: copyRecord(existing) };
      }
      if (existing.state === 'COMPLETED') {
        return { status: 'ALREADY_COMPLETED', record: copyRecord(existing) };
      }
      if (existing.state === 'FAILED_FINAL') {
        return { status: 'FAILED_FINAL', record: copyRecord(existing) };
      }
    }

    const record: DownstreamExecutionRecord = {
      idempotencyKey: input.idempotencyKey,
      workItemId: input.workItemId,
      commandType: input.commandType,
      state: 'PROCESSING',
      attempt: input.attempt,
      updatedAt: new Date(input.now.getTime())
    };
    this.records.set(input.idempotencyKey, record);
    return { status: 'STARTED', record: copyRecord(record) };
  }

  complete(idempotencyKey: string, now: Date): DownstreamExecutionRecord {
    return this.transition(idempotencyKey, now, 'COMPLETED');
  }

  fail(
    idempotencyKey: string,
    now: Date,
    retryability: 'RETRYABLE' | 'FINAL',
    reasonCode: GatewayErrorCode
  ): DownstreamExecutionRecord {
    return this.transition(
      idempotencyKey,
      now,
      retryability === 'RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
      reasonCode
    );
  }

  get(idempotencyKey: string): DownstreamExecutionRecord | undefined {
    const record = this.records.get(idempotencyKey);
    return record && copyRecord(record);
  }

  private transition(
    idempotencyKey: string,
    now: Date,
    state: Exclude<DownstreamExecutionState, 'PROCESSING'>,
    reasonCode?: GatewayErrorCode
  ): DownstreamExecutionRecord {
    const existing = this.records.get(idempotencyKey);
    if (!existing || existing.state !== 'PROCESSING' || Number.isNaN(now.getTime())) {
      throw new Error('INVALID_DOWNSTREAM_EXECUTION_TRANSITION');
    }
    const record: DownstreamExecutionRecord = {
      ...existing,
      state,
      reasonCode,
      updatedAt: new Date(now.getTime())
    };
    this.records.set(idempotencyKey, record);
    return copyRecord(record);
  }
}

/** Application boundary only. Implementations must remain provider-neutral. */
export interface DownstreamCommandProcessor {
  process(execution: InboundCommandExecution): InboundCommandHandlingResult;
}

export interface OfflineIdempotentCommandHandlerInput {
  journal: DownstreamExecutionJournal;
  processor: DownstreamCommandProcessor;
  now?: () => Date;
  operationalEventSink?: GatewayOperationalEventSink;
}

function isValidProcessorResult(result: unknown): result is InboundCommandHandlingResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const candidate = result as { status?: unknown; reasonCode?: unknown };
  if (candidate.status === 'COMPLETED') return true;
  return (
    (candidate.status === 'RETRYABLE_FAILURE' || candidate.status === 'FINAL_FAILURE') &&
    isGatewayErrorCode(candidate.reasonCode)
  );
}

/**
 * Offline reference handler with replay-safe downstream effects. It makes no
 * network call and performs no repository write by itself.
 */
export class OfflineIdempotentCommandHandler implements InboundCommandHandler {
  private readonly now: () => Date;

  constructor(private readonly input: OfflineIdempotentCommandHandlerInput) {
    this.now = input.now ?? (() => new Date());
  }

  handle(execution: InboundCommandExecution): InboundCommandHandlingResult {
    const now = this.now();
    let started: BeginDownstreamExecutionResult;
    try {
      started = this.input.journal.begin({
        idempotencyKey: execution.idempotencyKey,
        workItemId: execution.workItemId,
        commandType: execution.command.type,
        attempt: execution.attempt,
        now
      });
    } catch {
      return { status: 'RETRYABLE_FAILURE', reasonCode: 'UNKNOWN_PROVIDER_ERROR' };
    }

    if (started.status === 'ALREADY_COMPLETED') {
      this.observe(execution, 'SUCCESS', 'DOWNSTREAM_DUPLICATE', true, now);
      return { status: 'COMPLETED' };
    }
    if (started.status === 'FAILED_FINAL') {
      const reasonCode = started.record.reasonCode ?? 'NON_RETRYABLE';
      this.observe(execution, 'FAILURE', reasonCode, false, now);
      return { status: 'FINAL_FAILURE', reasonCode };
    }
    if (started.status === 'IDEMPOTENCY_CONFLICT') {
      this.observe(execution, 'FAILURE', 'IDEMPOTENCY_CONFLICT', false, now);
      return { status: 'FINAL_FAILURE', reasonCode: 'NON_RETRYABLE' };
    }

    this.observe(execution, 'SUCCESS', 'OPERATION_COMPLETED', false, now);
    let result: InboundCommandHandlingResult;
    try {
      const candidate = this.input.processor.process(execution);
      result = isValidProcessorResult(candidate)
        ? candidate
        : { status: 'RETRYABLE_FAILURE', reasonCode: 'UNKNOWN_PROVIDER_ERROR' };
    } catch {
      result = { status: 'RETRYABLE_FAILURE', reasonCode: 'UNKNOWN_PROVIDER_ERROR' };
    }

    try {
      if (result.status === 'COMPLETED') {
        this.input.journal.complete(execution.idempotencyKey, this.now());
      } else {
        this.input.journal.fail(
          execution.idempotencyKey,
          this.now(),
          result.status === 'RETRYABLE_FAILURE' ? 'RETRYABLE' : 'FINAL',
          result.reasonCode
        );
      }
    } catch {
      return { status: 'RETRYABLE_FAILURE', reasonCode: 'UNKNOWN_PROVIDER_ERROR' };
    }
    return result;
  }

  private observe(
    execution: InboundCommandExecution,
    outcome: 'SUCCESS' | 'FAILURE',
    reasonCode: Parameters<typeof createGatewayOperationalEvent>[0]['reasonCode'],
    duplicate: boolean,
    now: Date
  ): void {
    emitGatewayOperationalEventSafely(
      this.input.operationalEventSink,
      createGatewayOperationalEvent({
        provider: execution.command.event.provider,
        channel: execution.command.event.channel,
        stage: 'DOWNSTREAM_IDEMPOTENCY',
        outcome,
        reasonCode,
        retryCount: Math.max(0, execution.attempt - 1),
        duplicate,
        correlationId: execution.workItemId,
        timestamp: now.toISOString()
      })
    );
  }
}
