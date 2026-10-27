import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { changeOpportunityStage } from '../services/Actions';
import { FunnelStage } from '../domain/types';
import { format } from 'date-fns';
import { isReadOnlyMode } from '../config/dataSource';

const STAGES: FunnelStage[] = [
  'RASCUNHO', 'LEAD', 'EM ATENDIMENTO', 'PEDIDO GERADO', 
  'AGUARDANDO PAGAMENTO', 'PAGO', 'PRODUÇÃO', 'ENTREGUE', 
  'FECHADO', 'PÓS-VENDA'
];

export const CRM = () => {
  const { opportunities, contacts } = useAppStore();
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const readOnly = isReadOnlyMode();

  const handleStageChange = async (contactId: string, newStage: FunnelStage) => {
    if (readOnly || isProcessing) return;
    setIsProcessing(true);
    setActionError(null);
    try {
      await changeOpportunityStage(contactId, newStage);
    } catch (e) {
      console.error(e);
      setActionError('Erro ao alterar o estágio da oportunidade.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <div className="p-6 border-b border-slate-200 bg-white flex-shrink-0">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">CRM / Funil de Vendas</h2>
            <p className="text-sm text-slate-500 mt-1">Acompanhe as oportunidades comerciais ativas.</p>
          </div>
          {actionError && (
            <div className="text-sm text-red-500 font-medium px-3 py-1.5 bg-red-50 rounded-md border border-red-100">
              {actionError}
            </div>
          )}
        </div>
      </div>
      
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-6 custom-scrollbar">
        <div className="flex space-x-4 h-full items-start">
          {STAGES.map(stage => {
            const oppsInStage = opportunities.filter(o => o.stage === stage);
            
            return (
              <div key={stage} className="flex flex-col flex-shrink-0 w-72 max-h-full bg-slate-100/50 border border-slate-200 rounded-xl">
                <div className="p-3 border-b border-slate-200 bg-slate-100/80 rounded-t-xl flex justify-between items-center">
                  <h3 className="font-semibold text-sm text-slate-700">{stage}</h3>
                  <span className="bg-white text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full shadow-sm border border-slate-200">
                    {oppsInStage.length}
                  </span>
                </div>
                
                <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
                  {oppsInStage.map(opp => {
                    const contact = contacts.find(c => c.id === opp.contactId);
                    if (!contact) return null;
                    
                    return (
                      <div key={opp.id} className="bg-white p-4 rounded-lg shadow-sm border border-slate-200 hover:shadow-md transition-shadow cursor-grab">
                        <div className="flex justify-between items-start mb-2">
                          <h4 className="font-bold text-sm text-slate-900">{contact.name}</h4>
                        </div>
                        <p className="text-xs text-slate-500 mb-3">{contact.phone}</p>
                        
                        <div className="text-[10px] text-slate-400 mb-3 font-medium">
                          Atualizado: {format(opp.updatedAt, 'HH:mm')}
                        </div>

                        <select 
                          className="w-full text-xs p-1.5 border border-slate-200 rounded text-slate-600 bg-slate-50 outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                          value={opp.stage}
                          onChange={(e) => handleStageChange(contact.id, e.target.value as FunnelStage)}
                          disabled={readOnly || isProcessing}
                          title={readOnly ? "Indisponível no modo somente leitura." : undefined}
                        >
                          {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    );
                  })}
                  {oppsInStage.length === 0 && (
                    <div className="p-4 text-center text-xs font-medium text-slate-400 border-2 border-dashed border-slate-200 rounded-lg">
                      Vazio
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
