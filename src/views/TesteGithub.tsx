import React from 'react';

/**
 * Tela isolada para verificar se alteracoes publicadas no GitHub
 * sao trazidas de volta ao Google AI Studio via sincronizacao.
 */
export const TesteGithub: React.FC = () => (
  <section className="p-8 max-w-5xl mx-auto" data-testid="github-ai-studio-sync-test">
    <div className="bg-white rounded-xl border border-indigo-200 shadow-sm p-8">
      <span className="inline-flex rounded-full bg-indigo-50 text-indigo-700 text-xs font-semibold px-3 py-1 mb-4">
        Experimento de sincronização
      </span>
      <h2 className="text-2xl font-bold text-slate-800 mb-3">Teste GitHub</h2>
      <p className="text-slate-600 mb-6">
        Esta aba foi adicionada no repositório GitHub para testar a sincronização com o Google AI Studio.
      </p>
      <div className="rounded-lg border border-dashed border-indigo-300 bg-indigo-50 p-5">
        <p className="text-sm font-medium text-indigo-900 mb-2">Identificador de verificação</p>
        <code className="block text-sm font-semibold text-indigo-800 break-all" data-testid="github-ai-studio-sync-marker">
          TESTE-GITHUB-AISTUDIO-2026-10-27
        </code>
      </div>
      <p className="text-sm text-slate-500 mt-6">
        Se esta tela aparecer na prévia do Google AI Studio, o código exibido inclui a alteração feita no GitHub.
        Isso não comprova atualização automática: confirme também se foi necessário usar a função Pull.
      </p>
    </div>
  </section>
);
