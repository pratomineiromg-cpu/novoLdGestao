import React from 'react';
import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, MessageSquare, Kanban, Send, ShoppingBag, 
  BarChart, Users, MenuSquare, MonitorSmartphone, Utensils, Truck,
  Settings, Link, FlaskConical
} from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

export const Sidebar = () => {
  const activeItems = [
    { name: 'Dashboard', path: '/', icon: LayoutDashboard },
    { name: 'Central de Atendimento', path: '/chat', icon: MessageSquare },
    { name: 'CRM / Funil', path: '/crm', icon: Kanban },
    { name: 'Disparador Inteligente', path: '/disparador', icon: Send },
    { name: 'Pedidos', path: '/pedidos', icon: ShoppingBag },
    { name: 'Teste GitHub', path: '/teste-github', icon: FlaskConical },
  ];

  const plannedItems = [
    { name: 'Inteligência Comercial', icon: BarChart },
    { name: 'Clientes', icon: Users },
    { name: 'Cardápio', icon: MenuSquare },
    { name: 'Caixa / PDV', icon: MonitorSmartphone },
    { name: 'Mesas / Comandas', icon: Utensils },
    { name: 'Cozinha / KDS', icon: Utensils },
    { name: 'Entregas', icon: Truck },
    { name: 'Relatórios / BI', icon: BarChart },
    { name: 'Automações', icon: Settings },
    { name: 'Configurações', icon: Settings },
    { name: 'Integrações', icon: Link },
  ];

  return (
    <div className="w-64 h-screen bg-slate-900 text-slate-300 flex flex-col flex-shrink-0">
      <div className="h-16 flex items-center px-6 text-white font-bold text-lg tracking-tight border-b border-slate-800 leading-tight">
        <div>
          <div className="text-slate-100">LidacomZap</div>
          <div className="text-sm font-medium text-slate-400">Gestão Inteligente</div>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto py-4 custom-scrollbar">
        <div className="px-3 mb-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Principal
        </div>
        <nav className="space-y-1 px-2">
          {activeItems.map(item => (
            <NavLink
              key={item.name}
              to={item.path}
              className={({ isActive }) => cn(
                "flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors",
                isActive ? "bg-indigo-600 text-white" : "hover:bg-slate-800 hover:text-white"
              )}
            >
              <item.icon className="mr-3 h-5 w-5 flex-shrink-0" />
              {item.name}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 mt-8 mb-2 text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
          <span>Planejados</span>
          <span className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">FASE 2+</span>
        </div>
        <nav className="space-y-1 px-2 opacity-50 pointer-events-none">
          {plannedItems.map(item => (
            <div key={item.name} className="flex items-center px-3 py-2 text-sm font-medium">
              <item.icon className="mr-3 h-5 w-5 flex-shrink-0" />
              {item.name}
            </div>
          ))}
        </nav>
      </div>
    </div>
  );
};
