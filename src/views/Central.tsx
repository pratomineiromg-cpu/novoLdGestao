import React, { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { sendDraftMessage, simulateClientResponse, createOrder, changeOpportunityStage } from '../services/Actions';
import { format } from 'date-fns';
import { Search, Send, UserCircle2, Tag, ShoppingBag, Info, Phone, PackageOpen, MessageSquare } from 'lucide-react';
import { FunnelStage } from '../domain/types';
import { isReadOnlyMode } from '../config/dataSource';

export const Central = () => {
  const { contacts, conversations, messages, pendingMessages, opportunities, timeline, products } = useAppStore();
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const readOnly = isReadOnlyMode();
  
  const selectedConv = conversations.find(c => c.id === selectedConvId);
  const selectedContact = selectedConv ? contacts.find(c => c.id === selectedConv.contactId) : null;
  const opp = selectedContact ? opportunities.find(o => o.contactId === selectedContact.id) : null;
  
  const convMessages = messages.filter(m => m.conversationId === selectedConvId).sort((a,b) => a.createdAt.getTime() - b.createdAt.getTime());
  const draftMessage = pendingMessages.find(p => p.conversationId === selectedConvId);
  const contactTimeline = selectedContact ? timeline.filter(t => t.contactId === selectedContact.id).sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime()) : [];

  const [orderItem, setOrderItem] = useState({ productId: '', quantity: 1, observation: '' });

  const [isProcessing, setIsProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleSendDraft = async () => {
    if (readOnly || isProcessing || !selectedConvId || !draftMessage) return;
    setIsProcessing(true);
    setActionError(null);
    try {
      await sendDraftMessage(selectedConvId);
    } catch (err) {
      setActionError('Erro ao enviar mensagem.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSimulateResponse = async () => {
    if (readOnly || isProcessing || !selectedConvId) return;
    setIsProcessing(true);
    setActionError(null);
    try {
      await simulateClientResponse(selectedConvId);
    } catch (err) {
      setActionError('Erro ao simular resposta.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCreateOrder = async () => {
    if (readOnly || isProcessing || !selectedContact || !orderItem.productId) return;
    setIsProcessing(true);
    setActionError(null);
    const product = products.find(p => p.id === orderItem.productId);
    if (product) {
      try {
        await createOrder(selectedContact.id, [{
          productId: product.id,
          productName: product.name,
          price: product.price,
          quantity: orderItem.quantity,
          observation: orderItem.observation
        }], 'PIX');
        setOrderModalOpen(false);
        setOrderItem({ productId: '', quantity: 1, observation: '' });
      } catch (err) {
        setActionError('Erro ao criar pedido.');
      } finally {
        setIsProcessing(false);
      }
    } else {
      setIsProcessing(false);
    }
  };

  const handleStageChange = async (contactId: string, stage: FunnelStage) => {
    if (readOnly || isProcessing) return;
    setIsProcessing(true);
    setActionError(null);
    try {
      await changeOpportunityStage(contactId, stage);
    } catch (err) {
      setActionError('Erro ao alterar estágio.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex h-full bg-white divide-x divide-slate-200">
      {/* PAINEL ESQUERDO: Lista de Conversas */}
      <div className="w-80 flex flex-col flex-shrink-0 bg-slate-50">
        <div className="p-4 border-b border-slate-200 bg-white">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar conversas..." 
              className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="p-6 text-center text-slate-400 text-sm">
              Nenhuma conversa encontrada.
            </div>
          ) : (
            conversations.map(conv => {
              const contact = contacts.find(c => c.id === conv.contactId);
              if (!contact) return null;
              const opp = opportunities.find(o => o.contactId === contact.id);
              const draft = pendingMessages.find(p => p.conversationId === conv.id);
              
              return (
                <div 
                  key={conv.id}
                  onClick={() => setSelectedConvId(conv.id)}
                  className={`flex items-start p-4 border-b border-slate-100 cursor-pointer transition-colors ${selectedConvId === conv.id ? 'bg-indigo-50' : 'hover:bg-slate-100 bg-white'}`}
                >
                  <div className="h-10 w-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 mr-3 flex-shrink-0">
                    <UserCircle2 className="h-6 w-6" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline mb-0.5">
                      <h4 className="text-sm font-semibold text-slate-900 truncate">{contact.name}</h4>
                      {opp && <span className="text-[10px] font-medium bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded ml-2 whitespace-nowrap">{opp.stage}</span>}
                    </div>
                    <p className="text-xs text-slate-500 truncate">
                      {draft ? <span className="text-amber-600 font-medium">[Rascunho] </span> : null}
                      {contact.phone}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* PAINEL CENTRAL: Chat */}
      <div className="flex-1 flex flex-col bg-[#e5ddd5]">
        {selectedConv ? (
          <>
            <div className="h-16 px-6 bg-slate-100 flex items-center justify-between border-b border-slate-200 flex-shrink-0 shadow-sm z-10">
              <div className="flex items-center">
                <div className="h-10 w-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 mr-3">
                  <UserCircle2 className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-900 leading-tight">{selectedContact?.name}</h3>
                  <p className="text-xs text-slate-500">{selectedContact?.phone}</p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {actionError && <span className="text-xs text-red-500 mr-2">{actionError}</span>}
                <button 
                  onClick={handleSimulateResponse} 
                  disabled={readOnly || isProcessing} 
                  title={readOnly ? "Indisponível no modo somente leitura." : undefined}
                  className="px-3 py-1.5 bg-white border border-slate-300 rounded text-sm font-medium text-slate-700 hover:bg-slate-50 shadow-sm transition-colors disabled:opacity-50"
                >
                  Simular Resposta
                </button>
                <button 
                  onClick={() => setOrderModalOpen(true)} 
                  disabled={readOnly || isProcessing} 
                  title={readOnly ? "Indisponível no modo somente leitura." : undefined}
                  className="px-3 py-1.5 bg-emerald-600 border border-emerald-700 rounded text-sm font-medium text-white hover:bg-emerald-700 shadow-sm flex items-center transition-colors disabled:opacity-50"
                >
                  <ShoppingBag className="w-4 h-4 mr-1.5" />
                  Gerar Pedido
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {convMessages.map(msg => (
                <div key={msg.id} className={`flex ${msg.sender === 'USER' ? 'justify-end' : msg.sender === 'SYSTEM' ? 'justify-center' : 'justify-start'}`}>
                  {msg.sender === 'SYSTEM' ? (
                     <div className="bg-slate-800/80 backdrop-blur text-white text-xs py-1.5 px-4 rounded-full shadow-sm max-w-md text-center">
                       {msg.content}
                     </div>
                  ) : (
                    <div className={`max-w-md rounded-lg p-3 shadow-sm relative ${msg.sender === 'USER' ? 'bg-[#d9fdd3] text-slate-900 rounded-tr-none' : 'bg-white text-slate-900 rounded-tl-none'}`}>
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      <span className="text-[10px] text-slate-500 block text-right mt-1">{format(msg.createdAt, 'HH:mm')}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="p-4 bg-slate-100 flex-shrink-0">
              <div className="bg-white rounded-xl border border-slate-300 shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-transparent transition-all">
                {draftMessage ? (
                  <div className="p-3 bg-amber-50 border-b border-amber-100 flex justify-between items-center">
                    <span className="text-xs font-semibold text-amber-700 flex items-center">
                      <Info className="w-4 h-4 mr-1" />
                      Rascunho gerado por automação
                    </span>
                  </div>
                ) : null}
                <div className="flex items-end">
                  <textarea 
                    className="flex-1 max-h-32 min-h-[44px] p-3 resize-none focus:outline-none text-sm text-slate-900"
                    placeholder="Digite uma mensagem..."
                    value={draftMessage?.content || ''}
                    readOnly
                    rows={Math.max(1, (draftMessage?.content.match(/\n/g)||[]).length + 1)}
                  />
                  <button 
                    className="p-3 m-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                    disabled={readOnly || !draftMessage || isProcessing}
                    title={readOnly ? "Indisponível no modo somente leitura." : undefined}
                    onClick={handleSendDraft}
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center flex-col text-slate-400">
            <MessageSquare className="w-16 h-16 mb-4 opacity-20" />
            <p>Selecione uma conversa para iniciar o atendimento</p>
          </div>
        )}
      </div>

      {/* PAINEL DIREITO: Info & CRM */}
      {selectedContact ? (
        <div className="w-80 flex flex-col flex-shrink-0 bg-white overflow-y-auto">
          <div className="p-6 border-b border-slate-100 flex flex-col items-center">
             <div className="h-20 w-20 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-4 border border-slate-200 shadow-sm">
                <UserCircle2 className="h-12 w-12" />
             </div>
             <h3 className="font-bold text-lg text-slate-900">{selectedContact.name}</h3>
             <div className="flex items-center text-sm text-slate-500 mt-1">
               <Phone className="w-4 h-4 mr-1.5" />
               {selectedContact.phone}
             </div>
          </div>

          <div className="p-5 border-b border-slate-100">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Funil Comercial</div>
            <select 
              value={opp?.stage || 'RASCUNHO'} 
              onChange={(e) => handleStageChange(selectedContact.id, e.target.value as FunnelStage)}
              disabled={readOnly || isProcessing}
              title={readOnly ? "Indisponível no modo somente leitura." : undefined}
              className="w-full p-2 border border-slate-300 rounded-md text-sm font-medium text-slate-700 bg-slate-50 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
            >
              <option value="RASCUNHO">Rascunho</option>
              <option value="LEAD">Lead</option>
              <option value="EM ATENDIMENTO">Em Atendimento</option>
              <option value="PEDIDO GERADO">Pedido Gerado</option>
              <option value="AGUARDANDO PAGAMENTO">Aguardando Pagamento</option>
              <option value="PAGO">Pago</option>
              <option value="PRODUÇÃO">Produção</option>
              <option value="ENTREGUE">Entregue</option>
              <option value="FECHADO">Fechado</option>
              <option value="PÓS-VENDA">Pós-venda</option>
            </select>
          </div>

          <div className="p-5 border-b border-slate-100">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Tags</div>
            <div className="flex flex-wrap gap-2">
              {selectedContact.tags.length > 0 ? selectedContact.tags.map(tag => (
                <span key={tag} className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs font-medium rounded-md border border-indigo-100 flex items-center">
                  <Tag className="w-3 h-3 mr-1" />
                  {tag}
                </span>
              )) : <span className="text-sm text-slate-400">Nenhuma tag</span>}
            </div>
          </div>

          <div className="p-5">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">Timeline de Eventos</div>
            <div className="relative border-l-2 border-slate-200 ml-3 space-y-6">
              {contactTimeline.map(t => (
                <div key={t.id} className="relative pl-5">
                  <div className="absolute -left-[9px] top-1 w-4 h-4 rounded-full bg-white border-2 border-indigo-500 shadow-sm" />
                  <p className="text-xs font-bold text-slate-800">{t.type.replace(/_/g, ' ')}</p>
                  <p className="text-sm text-slate-600 mt-0.5">{t.description}</p>
                  <span className="text-[10px] text-slate-400 font-medium mt-1 block">{format(t.createdAt, 'dd/MM HH:mm:ss')}</span>
                </div>
              ))}
              {contactTimeline.length === 0 && (
                <div className="pl-4 text-sm text-slate-400">Nenhum evento registrado.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* MODAL DE PEDIDO */}
      {orderModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-lg text-slate-900 flex items-center">
                <PackageOpen className="w-5 h-5 mr-2 text-indigo-600" />
                Gerar Pedido
              </h3>
              <button onClick={() => setOrderModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">&times;</button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Produto</label>
                <select 
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                  value={orderItem.productId}
                  onChange={e => setOrderItem({...orderItem, productId: e.target.value})}
                >
                  <option value="">Selecione um produto</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name} - R$ {p.price.toFixed(2)}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-4">
                <div className="w-1/3">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Qtd</label>
                  <input 
                    type="number" min="1" 
                    className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    value={orderItem.quantity}
                    onChange={e => setOrderItem({...orderItem, quantity: parseInt(e.target.value) || 1})}
                  />
                </div>
                <div className="w-2/3">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Total</label>
                  <div className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium text-slate-900">
                    R$ {((products.find(p => p.id === orderItem.productId)?.price || 0) * orderItem.quantity).toFixed(2)}
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Observações</label>
                <input 
                  type="text" 
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                  placeholder="Ex: Sem cebola"
                  value={orderItem.observation}
                  onChange={e => setOrderItem({...orderItem, observation: e.target.value})}
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end space-x-3 bg-slate-50">
              <button onClick={() => setOrderModalOpen(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800">
                Cancelar
              </button>
              <button 
                onClick={handleCreateOrder} 
                disabled={readOnly || !orderItem.productId || isProcessing}
                title={readOnly ? "Indisponível no modo somente leitura." : undefined}
                className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-sm"
              >
                Confirmar Pedido
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
