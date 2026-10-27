# Contact Bootstrap Tool

Ferramenta OFFLINE para preparar, validar e auditar o primeiro bootstrap real de contatos do Restaurante Prato Mineiro.

## Regras
- Nenhuma operação de rede.
- Zero Update / Zero Delete. Apenas criações com precondição `exists: false`.
- Não envia dados para o Firestore de verdade nesta fase (F1B-05A).
- PII limits: logs não mostram telefones ou nomes.
- Dados reais com PII devem ficar fora do repositório, em
  `LOCALAPPDATA/LidacomZap/private-data/contact-bootstrap`.
- O CLI aceita caminhos absolutos externos para entrada real e recusa saída de
  plano dentro da raiz Git.
- O CLI recusa saída de plano sem o sufixo `.plan.json`.

## Como usar
Para planejar e validar usando o arquivo de exemplo:
```sh
npm run bootstrap:contacts:plan -- --input tools/contact-bootstrap/example-manifest.json
```

Para dados reais locais, use caminhos fora do repositório:

```powershell
$privateDir = Join-Path $env:LOCALAPPDATA 'LidacomZap\private-data\contact-bootstrap'
npm run bootstrap:contacts:plan -- --input (Join-Path $privateDir 'prato-mineiro-bootstrap-001.local.json') --output (Join-Path $privateDir 'prato-mineiro-bootstrap-001.plan.json')
```
