import { describe, expect, it } from 'vitest';
import { decodeMetaOfficialWebhookEvents } from '../../services/channel-gateway/providers/metaOfficialProtocol';

const metadata = {
  display_phone_number: '15550000000',
  phone_number_id: 'phone-number-test'
};

function emptyChange() {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata
    }
  };
}

function messageChange() {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata,
      messages: [
        {
          id: 'wamid.coordinate-stable.message',
          from: '15550000001',
          timestamp: '1788542400',
          type: 'text',
          text: {
            body: 'synthetic test message'
          }
        }
      ]
    }
  };
}

function statusChange() {
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata,
      statuses: [
        {
          id: 'wamid.coordinate-stable.status',
          status: 'delivered',
          timestamp: '1788542400'
        }
      ]
    }
  };
}

function envelope(changes: readonly unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-test',
        changes
      }
    ]
  };
}

function getMessageEvent(input: unknown) {
  const event = decodeMetaOfficialWebhookEvents(input).find(
    candidate => candidate.kind === 'message'
  );

  if (!event || event.kind !== 'message') {
    throw new Error('MESSAGE_EVENT_NOT_FOUND');
  }

  return event;
}

function getStatusEvent(input: unknown) {
  const event = decodeMetaOfficialWebhookEvents(input).find(
    candidate => candidate.kind === 'status'
  );

  if (!event || event.kind !== 'status') {
    throw new Error('STATUS_EVENT_NOT_FOUND');
  }

  return event;
}

describe('Meta idempotency identity is independent from source coordinates', () => {
  it('keeps message providerEventId stable when changeIndex changes', () => {
    const first = getMessageEvent(
      envelope([messageChange()])
    );

    const replay = getMessageEvent(
      envelope([emptyChange(), messageChange()])
    );

    expect(first.sourceCoordinates?.changeIndex).toBe(0);
    expect(replay.sourceCoordinates?.changeIndex).toBe(1);

    expect(first.providerEventId).toBe(
      'meta:message:waba-test:wamid.coordinate-stable.message'
    );

    expect(replay.providerEventId).toBe(first.providerEventId);
  });

  it('keeps status providerEventId stable when changeIndex changes', () => {
    const first = getStatusEvent(
      envelope([statusChange()])
    );

    const replay = getStatusEvent(
      envelope([emptyChange(), statusChange()])
    );

    expect(first.sourceCoordinates?.changeIndex).toBe(0);
    expect(replay.sourceCoordinates?.changeIndex).toBe(1);

    expect(first.providerEventId).toBe(
      'meta:status:waba-test:delivered:wamid.coordinate-stable.status:1788542400'
    );

    expect(replay.providerEventId).toBe(first.providerEventId);
  });
});
