import type { DurableIdempotencyStore } from './idempotency';
import type { DownstreamExecutionJournal } from './downstream';
import type { InboundAdmissionStore, InboundWorkQueue } from './ingress';
import type { OutboundQueue } from './outboundQueue';
import type { ContactIdentityResolver, ConversationResolver } from './resolution';

/** Technology-neutral server persistence ports; no implementation is selected. */
export interface ChannelGatewayPersistencePorts {
  idempotency: DurableIdempotencyStore;
  contactIdentities: ContactIdentityResolver;
  conversations: ConversationResolver;
  outboundQueue: OutboundQueue;
  /** Absent means production inbound durable admission is NOT_CONFIGURED. */
  inboundAdmission?: InboundAdmissionStore;
  /** Absent means production inbound worker queue is NOT_CONFIGURED. */
  inboundWorkQueue?: InboundWorkQueue;
  /** Absent means production replay-safe downstream execution is NOT_CONFIGURED. */
  downstreamExecutions?: DownstreamExecutionJournal;
}
