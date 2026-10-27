import React from 'react';
import { useAppStore } from '../store/useAppStore';

export const Dashboard = () => {
  const { contacts, opportunities, orders } = useAppStore();

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <h2 className="text-2xl font-bold text-slate-800 mb-6">Visão Geral</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-sm font-medium text-slate-500 mb-1">Contatos Base</div>
          <div className="text-3xl font-bold text-slate-900">{contacts.length}</div>
        </div>
        
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-sm font-medium text-slate-500 mb-1">Oportunidades Ativas</div>
          <div className="text-3xl font-bold text-indigo-600">{opportunities.length}</div>
        </div>
        
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-sm font-medium text-slate-500 mb-1">Pedidos Gerados</div>
          <div className="text-3xl font-bold text-emerald-600">{orders.length}</div>
        </div>
      </div>
      
      <div className="mt-8 bg-indigo-50 border border-indigo-100 p-6 rounded-xl text-indigo-800">
        <h3 className="font-bold mb-2">Bem-vindo à Fase 0</h3>
        <p className="text-sm">
          Nesta demonstração, concentre-se em testar o fluxo de vendas omnichannel.<br/>
          Vá para <strong>Disparador Inteligente</strong> para preparar uma campanha, 
          depois vá para <strong>Central de Atendimento</strong> para enviar mensagens,
          receber respostas e gerar pedidos, acompanhando tudo no <strong>CRM</strong>.
        </p>
      </div>
    </div>
  );
};
