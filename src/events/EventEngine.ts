import { repository } from '../repositories';
import { FunnelStage, Order, Message } from '../domain/types';
import { createId } from '../utils/id';

// Events
export type AppEvent =
  | { type: 'CONTACT_CREATED', contactId: string }
  | { type: 'CONVERSATION_CREATED', conversationId: string, contactId: string }
  | { type: 'MESSAGE_DRAFT_CREATED', conversationId: string, contactId: string }
  | { type: 'MESSAGE_SENT', message: Message, contactId: string }
  | { type: 'MESSAGE_RECEIVED', message: Message, contactId: string }
  | { type: 'OPPORTUNITY_CREATED', opportunityId: string, contactId: string }
  | { type: 'FUNNEL_STAGE_CHANGED', opportunityId: string, newStage: FunnelStage, contactId: string }
  | { type: 'ORDER_CREATED', order: Order, contactId: string };

export const emitEvent = async (event: AppEvent) => {
  console.log('[EventEngine]', event.type);
  
  const now = new Date();
  
  // Add to timeline
  const addTimeline = async (type: string, desc: string) => {
    await repository.addTimelineEvent({
      id: createId('tl'),
      contactId: event.contactId,
      type,
      description: desc,
      createdAt: now,
    });
  };

  const updateFunnel = async (newStage: FunnelStage, manual: boolean = false) => {
    const tenantId = repository.getState().tenant.id;
    const result = await repository.transitionOpportunityStage(event.contactId, tenantId, newStage, now);
    
    if (result.created) {
      await addTimeline('OPPORTUNITY_CREATED', 'Oportunidade comercial criada.');
    }
    
    if (result.changed) {
      const oldStr = result.previousStage ? result.previousStage : '(Novo)';
      const prefix = manual ? 'Movimentação manual' : 'Funil alterado automaticamente';
      await addTimeline('FUNNEL_STAGE_CHANGED', `${prefix}: ${oldStr} → ${result.currentStage}.`);
    }
  };

  switch (event.type) {
    case 'MESSAGE_DRAFT_CREATED':
      await addTimeline('MESSAGE_DRAFT_CREATED', 'Mensagem de venda ativa preparada.');
      await updateFunnel('RASCUNHO');
      break;
      
    case 'MESSAGE_SENT':
      await addTimeline('MESSAGE_SENT', 'Mensagem enviada pelo operador.');
      await updateFunnel('LEAD');
      break;
      
    case 'MESSAGE_RECEIVED':
      await addTimeline('MESSAGE_RECEIVED', 'Cliente respondeu.');
      await updateFunnel('EM ATENDIMENTO');
      break;
      
    case 'ORDER_CREATED':
      await addTimeline('ORDER_CREATED', `Pedido #${event.order.id.split('-')[1] || event.order.id} gerado.`);
      await updateFunnel('PEDIDO GERADO');
      break;
      
    case 'FUNNEL_STAGE_CHANGED':
      await updateFunnel(event.newStage, true);
      break;
  }
};
