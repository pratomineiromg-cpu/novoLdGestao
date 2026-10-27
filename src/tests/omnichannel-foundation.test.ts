import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Contact,
  ContactImporter,
  ContactImportPreview,
  ContactImportReport,
  ContactImportSource,
  Conversation,
  DispatchCampaign,
  MarketingCampaign,
  Message,
  OrderChannel
} from '../domain/types';
import {
  ChannelProvider,
  CommunicationChannel,
  ContactChannelIdentity,
  createContactChannelIdentity,
  createProviderCapabilities,
  externalMessageIdempotencyKey,
  hasKnownProviderCapability
} from '../domain/omnichannel';
import { decideRouting } from '../domain/routing';
import {
  validateContactChannelIdentity,
  validateConversation,
  validateDispatchCampaign,
  validateMessage,
  validateOrder,
  validateProviderCapabilities
} from '../repositories/firestore/readValidators';
import { getContactChannelIdentityPath } from '../repositories/firestore/schema';

const fixedAt = new Date('2026-09-04T12:00:00.000Z');

function identity(
  overrides: Partial<ContactChannelIdentity> = {}
): ContactChannelIdentity {
  return createContactChannelIdentity({
    id: 'identity-opaque-001',
    tenantId: 'tenant-opaque-001',
    contactId: 'contact-opaque-001',
    channel: 'WHATSAPP',
    provider: 'WHATSAPP_META_OFFICIAL',
    address: 'normalized-address-placeholder',
    createdAt: fixedAt,
    updatedAt: fixedAt,
    ...overrides
  });
}

describe('Omnichannel Contact and Messaging Foundation', () => {
  it('keeps Contact independent from channel identities while supporting WhatsApp and RCS for one person', () => {
    const contact: Contact = {
      id: 'contact-opaque-001',
      tenantId: 'tenant-opaque-001',
      name: 'Contato de teste',
      phone: 'legacy-phone-placeholder',
      tags: [],
      notes: '',
      createdAt: fixedAt,
      updatedAt: fixedAt
    };
    const identities = [
      identity(),
      identity({
        id: 'identity-opaque-002',
        channel: 'RCS',
        provider: 'RCS_GOOGLE',
        address: 'normalized-rcs-address-placeholder'
      })
    ];

    expect(contact).not.toHaveProperty('channel');
    expect(contact).not.toHaveProperty('provider');
    expect(identities.map((item) => item.contactId)).toEqual([contact.id, contact.id]);
    expect(identities.map((item) => item.channel)).toEqual(['WHATSAPP', 'RCS']);
  });

  it('does not change a Contact when the identity provider changes', () => {
    const contact = {
      id: 'contact-opaque-001',
      tenantId: 'tenant-opaque-001',
      name: 'Contato de teste',
      phone: 'legacy-phone-placeholder',
      tags: [],
      notes: '',
      createdAt: fixedAt,
      updatedAt: fixedAt
    } satisfies Contact;
    const before = structuredClone(contact);
    const channelIdentity = identity({ provider: 'WHATSAPP_META_OFFICIAL' });
    const changedProviderIdentity = {
      ...channelIdentity,
      provider: 'WHATSAPP_EVOLUTION_OPTIONAL' as const
    };

    expect(changedProviderIdentity.contactId).toBe(contact.id);
    expect(contact).toEqual(before);
  });

  it('defaults availability and eligibility to UNKNOWN', () => {
    const created = identity({
      id: 'identity-opaque-defaults',
      provider: undefined,
      availability: undefined,
      availabilitySource: undefined,
      eligibility: undefined
    });

    expect(created.availability).toBe('UNKNOWN');
    expect(created.availabilitySource).toBe('UNKNOWN');
    expect(created.eligibility).toBe('UNKNOWN');
  });

  it('represents the supported provider identifiers without a live adapter or default Evolution preference', () => {
    const providers: ChannelProvider[] = [
      'WHATSAPP_META_OFFICIAL',
      'WHATSAPP_EVOLUTION_OPTIONAL',
      'RCS_GOOGLE'
    ];

    expect(providers[0]).toBe('WHATSAPP_META_OFFICIAL');
    expect(providers).toContain('WHATSAPP_EVOLUTION_OPTIONAL');
    expect(providers).toContain('RCS_GOOGLE');
  });

  it('uses safe unknown capability defaults and keeps capabilities provider-specific', () => {
    const meta = createProviderCapabilities({
      channel: 'WHATSAPP',
      provider: 'WHATSAPP_META_OFFICIAL',
      capabilities: ['TEXT'],
      observedAt: fixedAt
    });
    const rcs = createProviderCapabilities({
      channel: 'RCS',
      provider: 'RCS_GOOGLE',
      capabilities: ['TEXT', 'RICH_MEDIA'],
      observedAt: fixedAt,
      source: 'RCS_CAPABILITY_CHECK'
    });
    const unknown = createProviderCapabilities({
      channel: 'WHATSAPP',
      provider: 'WHATSAPP_EVOLUTION_OPTIONAL',
      observedAt: fixedAt
    });

    expect(hasKnownProviderCapability(undefined, 'AUDIO')).toBe(false);
    expect(hasKnownProviderCapability(unknown, 'AUDIO')).toBe(false);
    expect(hasKnownProviderCapability(meta, 'RICH_MEDIA')).toBe(false);
    expect(hasKnownProviderCapability(rcs, 'RICH_MEDIA')).toBe(true);
  });

  it('rejects impossible channel and provider pairs at domain and Firestore boundaries', () => {
    expect(() => identity({ channel: 'RCS', provider: 'WHATSAPP_META_OFFICIAL' }))
      .toThrow('is not compatible with channel');
    expect(() => createProviderCapabilities({
      channel: 'WHATSAPP',
      provider: 'RCS_GOOGLE',
      observedAt: fixedAt
    })).toThrow('is not compatible with channel');

    expect(() => validateContactChannelIdentity({
      ...identity({ provider: undefined }),
      channel: 'WHATSAPP',
      provider: 'RCS_GOOGLE'
    })).toThrow('provider is incompatible with channel');
    expect(() => validateProviderCapabilities({
      channel: 'RCS',
      provider: 'WHATSAPP_EVOLUTION_OPTIONAL',
      capabilities: [],
      observedAt: fixedAt,
      source: 'MANUAL'
    })).toThrow('provider is incompatible with channel');
    expect(() => validateConversation({
      id: 'conversation-opaque-invalid',
      tenantId: 'tenant-opaque-001',
      contactId: 'contact-opaque-001',
      channel: 'RCS',
      provider: 'WHATSAPP_META_OFFICIAL',
      unreadCount: 0,
      createdAt: fixedAt,
      updatedAt: fixedAt
    })).toThrow('provider is incompatible with channel');
    expect(() => validateMessage({
      id: 'message-opaque-invalid-provider',
      conversationId: 'conversation-opaque-001',
      sender: 'CONTACT',
      content: 'fixture content',
      channel: 'WHATSAPP',
      provider: 'RCS_GOOGLE',
      createdAt: fixedAt
    })).toThrow('provider is incompatible with channel');
  });

  it('does not route UNKNOWN availability or eligibility', () => {
    const result = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'BOTH_SMART',
      identities: [identity()],
      evaluatedAt: fixedAt
    });

    expect(result.selectedChannel).toBeNull();
    expect(result.reason).toBe('NO_ELIGIBLE_CHANNEL');
  });

  it('prefers WhatsApp for BOTH_SMART when both channels are available and eligible', () => {
    const result = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'BOTH_SMART',
      identities: [
        identity({ availability: 'KNOWN_AVAILABLE', eligibility: 'ELIGIBLE' }),
        identity({
          id: 'identity-opaque-rcs',
          channel: 'RCS',
          provider: 'RCS_GOOGLE',
          availability: 'KNOWN_AVAILABLE',
          eligibility: 'ELIGIBLE'
        })
      ],
      evaluatedAt: fixedAt
    });

    expect(result.selectedChannel).toBe('WHATSAPP');
    expect(result.selectedProvider).toBe('WHATSAPP_META_OFFICIAL');
    expect(result.reason).toBe('WHATSAPP_SELECTED');
  });

  it('falls back to RCS when WhatsApp is known unavailable', () => {
    const result = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'BOTH_SMART',
      identities: [
        identity({ availability: 'KNOWN_UNAVAILABLE', eligibility: 'ELIGIBLE' }),
        identity({
          id: 'identity-opaque-rcs',
          channel: 'RCS',
          provider: 'RCS_GOOGLE',
          availability: 'KNOWN_AVAILABLE',
          eligibility: 'ELIGIBLE'
        })
      ],
      evaluatedAt: fixedAt
    });

    expect(result.selectedChannel).toBe('RCS');
    expect(result.reason).toBe('WHATSAPP_UNAVAILABLE_FALLBACK_RCS');
  });

  it('falls back to RCS when WhatsApp is ineligible', () => {
    const result = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'BOTH_SMART',
      identities: [
        identity({ availability: 'KNOWN_AVAILABLE', eligibility: 'INELIGIBLE' }),
        identity({
          id: 'identity-opaque-rcs',
          channel: 'RCS',
          provider: 'RCS_GOOGLE',
          availability: 'KNOWN_AVAILABLE',
          eligibility: 'ELIGIBLE'
        })
      ],
      evaluatedAt: fixedAt
    });

    expect(result.selectedChannel).toBe('RCS');
    expect(result.reason).toBe('WHATSAPP_INELIGIBLE_FALLBACK_RCS');
  });

  it('reports audit reasons for an unavailable or ineligible requested channel', () => {
    const unavailable = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'WHATSAPP',
      identities: [identity({ availability: 'KNOWN_UNAVAILABLE', eligibility: 'ELIGIBLE' })],
      evaluatedAt: fixedAt
    });
    const ineligible = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'RCS',
      identities: [identity({
        id: 'identity-opaque-rcs',
        channel: 'RCS',
        provider: 'RCS_GOOGLE',
        availability: 'KNOWN_AVAILABLE',
        eligibility: 'INELIGIBLE'
      })],
      evaluatedAt: fixedAt
    });

    expect(unavailable).toMatchObject({ selectedChannel: null, reason: 'REQUESTED_CHANNEL_UNAVAILABLE' });
    expect(ineligible).toMatchObject({ selectedChannel: null, reason: 'REQUESTED_CHANNEL_INELIGIBLE' });
  });

  it('selects at most one channel and ignores identities for another contact', () => {
    const result = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'BOTH_SMART',
      identities: [
        identity({ availability: 'KNOWN_AVAILABLE', eligibility: 'ELIGIBLE' }),
        identity({
          id: 'identity-opaque-other-contact',
          contactId: 'contact-opaque-002',
          channel: 'RCS',
          provider: 'RCS_GOOGLE',
          availability: 'KNOWN_AVAILABLE',
          eligibility: 'ELIGIBLE'
        })
      ],
      evaluatedAt: fixedAt
    });

    expect(['WHATSAPP', 'RCS', null]).toContain(result.selectedChannel);
    expect(result.selectedChannel).toBe('WHATSAPP');
  });

  it('is deterministic and does not mutate routing input', () => {
    const request = {
      contactId: 'contact-opaque-001',
      requestedMode: 'WHATSAPP' as const,
      identities: [identity({ availability: 'KNOWN_AVAILABLE', eligibility: 'ELIGIBLE' })],
      evaluatedAt: fixedAt
    };
    const before = structuredClone(request);
    Object.freeze(request.identities);
    Object.freeze(request);

    const first = decideRouting(request);
    const second = decideRouting(request);

    expect(first).toEqual(second);
    expect(request).toEqual(before);
    expect(first.evaluatedAt).not.toBe(request.evaluatedAt);
  });

  it('defines import sources and an offline, PII-free report contract', () => {
    const sources: ContactImportSource[] = [
      'WHATSAPP_COEXISTENCE',
      'EXCEL',
      'CSV',
      'GOOGLE_CONTACTS'
    ];
    const report: ContactImportReport = {
      operationId: 'operation-opaque-001',
      importId: 'import-opaque-001',
      source: 'CSV',
      found: 4,
      valid: 3,
      rejected: 1,
      duplicate: 0,
      technicalReasons: [{ code: 'INVALID_RECORD', count: 1 }],
      startedAt: fixedAt,
      completedAt: fixedAt
    };
    const preview: ContactImportPreview = { candidates: [], report };
    const importer: ContactImporter = {
      source: 'CSV',
      preview: () => preview
    };

    expect(sources).toHaveLength(4);
    expect(importer.preview({}).report.technicalReasons[0]).toEqual({ code: 'INVALID_RECORD', count: 1 });
    expect(Object.keys(report)).not.toContain('phone');
    expect(Object.keys(report)).not.toContain('email');
    expect(Object.keys(report)).not.toContain('address');
  });

  it('keeps legacy Conversation and Message documents valid', () => {
    const legacyConversation = validateConversation({
      id: 'conversation-opaque-001',
      tenantId: 'tenant-opaque-001',
      contactId: 'contact-opaque-001',
      unreadCount: 0,
      createdAt: fixedAt,
      updatedAt: fixedAt
    });
    const legacyMessage = validateMessage({
      id: 'message-opaque-001',
      conversationId: 'conversation-opaque-001',
      sender: 'CONTACT',
      content: 'fixture content',
      createdAt: fixedAt
    });

    expect(legacyConversation.channel).toBeUndefined();
    expect(legacyMessage.providerMessageId).toBeUndefined();
  });

  it('represents omnichannel Conversation and Message metadata including mobile-app origin', () => {
    const conversation: Conversation = validateConversation({
      id: 'conversation-opaque-001',
      tenantId: 'tenant-opaque-001',
      contactId: 'contact-opaque-001',
      channel: 'WHATSAPP',
      provider: 'WHATSAPP_META_OFFICIAL',
      externalConversationId: 'external-conversation-opaque-001',
      unreadCount: 0,
      createdAt: fixedAt,
      updatedAt: fixedAt
    });
    const message: Message = validateMessage({
      id: 'message-internal-opaque-001',
      conversationId: conversation.id,
      sender: 'USER',
      content: 'fixture content',
      channel: 'WHATSAPP',
      provider: 'WHATSAPP_META_OFFICIAL',
      providerMessageId: 'provider-message-opaque-001',
      originSurface: 'WHATSAPP_BUSINESS_APP',
      contentType: 'TEXT',
      createdAt: fixedAt
    });

    expect(conversation.externalConversationId).toBe('external-conversation-opaque-001');
    expect(message.originSurface).toBe('WHATSAPP_BUSINESS_APP');
    expect(message.id).not.toBe(message.providerMessageId);
  });

  it('requires a provider before accepting an external provider message identifier', () => {
    expect(() => validateMessage({
      id: 'message-opaque-invalid',
      conversationId: 'conversation-opaque-001',
      sender: 'CONTACT',
      content: 'fixture content',
      providerMessageId: 'provider-message-opaque-001',
      createdAt: fixedAt
    })).toThrow('provider is required');
  });

  it('validates standalone identity and provider capability contracts without persistence', () => {
    const channelIdentity = validateContactChannelIdentity({
      id: 'identity-opaque-validated',
      tenantId: 'tenant-opaque-001',
      contactId: 'contact-opaque-001',
      channel: 'RCS',
      provider: 'RCS_GOOGLE',
      address: 'normalized-rcs-address-placeholder',
      availability: 'KNOWN_AVAILABLE',
      availabilitySource: 'RCS_CAPABILITY_CHECK',
      eligibility: 'ELIGIBLE',
      eligibilitySource: 'POLICY',
      providerIdentityId: 'provider-identity-opaque-001',
      lastCapabilityCheckAt: fixedAt,
      createdAt: fixedAt,
      updatedAt: fixedAt
    });
    const capabilities = validateProviderCapabilities({
      channel: 'RCS',
      provider: 'RCS_GOOGLE',
      capabilities: ['TEXT', 'RICH_MEDIA'],
      observedAt: fixedAt,
      source: 'RCS_CAPABILITY_CHECK'
    });

    expect(channelIdentity.channel).toBe('RCS');
    expect(capabilities.capabilities).toEqual(['TEXT', 'RICH_MEDIA']);
  });

  it('keeps all existing Order attribution values, including NONE', () => {
    const orderChannel: OrderChannel = 'NONE';
    const order = validateOrder({
      id: 'order-opaque-001',
      tenantId: 'tenant-opaque-001',
      contactId: 'contact-opaque-001',
      entryPoint: 'DIGITAL_MENU',
      channel: orderChannel,
      creationMode: 'CUSTOMER',
      total: 1,
      status: 'CREATED',
      paymentMethod: 'TEST',
      conversationId: 'conversation-opaque-001',
      dispatchCampaignId: 'dispatch-opaque-001',
      queueEntryId: 'queue-opaque-001',
      createdAt: fixedAt,
      updatedAt: fixedAt
    });

    expect(order).toMatchObject({
      entryPoint: 'DIGITAL_MENU',
      channel: 'NONE',
      creationMode: 'CUSTOMER',
      conversationId: 'conversation-opaque-001',
      dispatchCampaignId: 'dispatch-opaque-001',
      queueEntryId: 'queue-opaque-001'
    });
  });

  it('keeps DispatchCampaign separate from MarketingCampaign and adds routing only as metadata', () => {
    const dispatch: DispatchCampaign = validateDispatchCampaign({
      id: 'dispatch-opaque-001',
      tenantId: 'tenant-opaque-001',
      name: 'Dispatch de teste',
      template: 'fixture template',
      dailyLimit: 1,
      routingMode: 'BOTH_SMART',
      createdAt: fixedAt,
      updatedAt: fixedAt
    });
    const marketing: MarketingCampaign = {
      id: 'marketing-opaque-001',
      tenantId: 'tenant-opaque-001',
      name: 'Planejamento de teste',
      createdAt: fixedAt,
      updatedAt: fixedAt
    };

    expect(dispatch.routingMode).toBe('BOTH_SMART');
    expect(marketing).not.toHaveProperty('template');
    expect(marketing).not.toHaveProperty('dailyLimit');
  });

  it('uses provider plus providerMessageId for an unambiguous external idempotency key', () => {
    const first = externalMessageIdempotencyKey({
      provider: 'WHATSAPP_META_OFFICIAL',
      providerMessageId: 'provider-message-opaque-001'
    });
    const duplicate = externalMessageIdempotencyKey({
      provider: 'WHATSAPP_META_OFFICIAL',
      providerMessageId: 'provider-message-opaque-001'
    });
    const otherProvider = externalMessageIdempotencyKey({
      provider: 'RCS_GOOGLE',
      providerMessageId: 'provider-message-opaque-001'
    });

    expect(first).toBe(duplicate);
    expect(first).not.toBe(otherProvider);
  });

  it('reserves a PII-free identity path contract without activating a collection', () => {
    expect(getContactChannelIdentityPath('identity-opaque-001')).toBe(
      'contactChannelIdentities/identity-opaque-001'
    );
  });

  it('contains no channel SDK dependencies, network primitives, or credentials in new domain modules', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    const allDependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };
    const moduleContents = [
      'src/domain/omnichannel.ts',
      'src/domain/routing.ts',
      'src/domain/types.ts'
    ].map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));

    expect(allDependencies).not.toHaveProperty('@whiskeysockets/baileys');
    expect(allDependencies).not.toHaveProperty('whatsapp-web.js');
    expect(allDependencies).not.toHaveProperty('puppeteer');
    for (const content of moduleContents) {
      expect(content).not.toMatch(/\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(|\bchild_process\b/);
      expect(content).not.toMatch(/apiKey|accessToken|client_secret|private_key|bearer\s+token|password/i);
    }
  });

  it('keeps routing independent from visual capabilities', () => {
    const channels: CommunicationChannel[] = ['WHATSAPP', 'RCS'];
    const result = decideRouting({
      contactId: 'contact-opaque-001',
      requestedMode: 'RCS',
      identities: [identity({
        id: 'identity-opaque-rcs',
        channel: 'RCS',
        provider: 'RCS_GOOGLE',
        availability: 'KNOWN_AVAILABLE',
        eligibility: 'ELIGIBLE'
      })],
      evaluatedAt: fixedAt
    });

    expect(channels).toEqual(['WHATSAPP', 'RCS']);
    expect(result).toMatchObject({ selectedChannel: 'RCS', reason: 'RCS_SELECTED' });
  });
});
