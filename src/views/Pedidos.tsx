import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { format } from 'date-fns';

export const Pedidos = () => {
  const { orders, contacts, orderItems } = useAppStore();

  const sortedOrders = [...orders].sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-slate-900">Pedidos</h2>
        <p className="text-sm text-slate-500 mt-1">Histórico de pedidos gerados omnichannel.</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 bg-slate-50">
              <th className="p-4 font-semibold">Número</th>
              <th className="p-4 font-semibold">Data</th>
              <th className="p-4 font-semibold">Cliente</th>
              <th className="p-4 font-semibold">Origem</th>
              <th className="p-4 font-semibold">Total</th>
              <th className="p-4 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {sortedOrders.map(order => {
              const contact = contacts.find(c => c.id === order.contactId);
              const items = orderItems.filter(i => i.orderId === order.id);
              
              return (
                <tr key={order.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="p-4 font-mono font-medium text-slate-600">
                    #{order.id.split('-')[1] || order.id}
                  </td>
                  <td className="p-4 text-slate-500">
                    {format(order.createdAt, 'dd/MM/yyyy HH:mm')}
                  </td>
                  <td className="p-4 font-medium text-slate-900">
                    {contact?.name}
                    <div className="text-xs text-slate-400 font-normal mt-0.5">
                      {items.length} item(s)
                    </div>
                  </td>
                  <td className="p-4">
                    <span className="px-2 py-1 bg-indigo-50 text-indigo-700 text-[10px] font-bold rounded">
                      {order.channel}
                    </span>
                  </td>
                  <td className="p-4 font-bold text-slate-900">
                    R$ {order.total.toFixed(2)}
                  </td>
                  <td className="p-4">
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">
                      {order.status}
                    </span>
                  </td>
                </tr>
              )
            })}
            {sortedOrders.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-500">
                  Nenhum pedido gerado ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
