# Handoff — evidence-first-code-review 0.3.0

## Pedido e autorização

O usuário pediu análise read-only do handoff da skill e depois autorizou aplicar o patch,
para recarregar outro agente e executar um reviewer independente. Este documento registra
o contrato implementado, não uma aprovação independente do código. Não fazer commit/push.

A intenção aprovada na conversa é preservar o núcleo investigativo (prova comportamental,
contraevidência, falsificação, reflexão, severidade/confiança separadas), melhorar WIP grande
e respeitar decisões aprovadas sem esconder consequências demonstradas. Não transformar
preferências do revisor em defeitos. Não alegar SOTA sem avaliação comparativa.

## Onde está o patch

Fonte autoral: `/home/rrghost/.agents/skills/evidence-first-code-review/`.

- `SKILL.md`, `references/{review-ledger,severity-confidence,sources}.md`.
- `scripts/review_scope.py`, `review_ledger.py`, `review_workspace.py` e novo `review.py`.
- `tests/test_wip_review.py`, `tests/test_review_evals.py`, `pyproject.toml`, `uv.lock`.
- `evals/evals.json`, `evals/make_wip_fixture.py`, `evals/README.md`.
- `~/.pi/agent/agents/reviewer.md` e `~/.claude/agents/reviewer.md` atualizados.
- Symlink do Claude para a skill compartilhada preservado.

No Git de `~/SoftEng/pi-core`:

- Reviewer do pacote: `extensions/subagent/agents/reviewer.md`.
- Cópia **gerada**, não outra fonte autoral: `extensions/subagent/reviewer-skill/`.
- Sincronização: `scripts/sync-review-skill.mjs` e teste `tests/reviewer-skill.test.ts`.
- `package.json`/`Makefile` integram a verificação da cópia ao `make check`.
- Este handoff.

A alteração pré-existente em `systemd/pi-core-memory-dreamer.service` não pertence ao patch;
não foi modificada e não deve ser corrigida, revertida ou atribuída a esta implementação.

Backup anterior das fontes compartilhadas/perfis:
`/home/rrghost/.agents/skill-backups/review-method-patch-before-20260929-120622.tar.gz`.
O Git HEAD é a base dos arquivos do pi-core; o backup é a base dos arquivos externos.
Patch exportado e resultados finais: `/home/rrghost/.agents/skill-evals/evidence-first-code-review/patch-0.3.0/`.
Não reaplicar o patch exportado: as alterações já estão instaladas no working tree e no home.

## Contrato implementado / critérios de aceitação

1. `render` não produz relatório com ledger inválido; `finish --strict` rejeita cobertura,
   candidatos ou perguntas não resolvidas. `complete` não significa ausência de defeitos.
2. WIP inclui staged + unstaged + untracked. `--base BASE --working-tree` usa base exata;
   `--merge-base` é opt-in, não uma troca silenciosa de semântica.
3. Manifesto schema 2 tem fingerprint e pontos de deleção. CLI rejeita drift detectado de
   WIP/index/HEAD. O pai **pausa escritores durante toda a revisão**; hashes não são snapshots.
4. Remoção pura em arquivo modificado suporta `anchor: deletion`, `old_line`; snippets
   repetidos são rejeitados em vez de escolher a primeira ocorrência.
5. Decisão aprovada + implementação correta não é bug por preferência do reviewer. Uma
   consequência imprevista comprovada continua finding; `next_action: ask_owner` separa
   evidência de autoridade para decidir a solução. Intenção desconhecida vira proof gap.
6. Um coordenador escreve o ledger. Workers retornam receipts por bundle com fingerprint,
   caminhos, checks, candidatos e gaps. Há passagem explícita pelas interfaces entre bundles.
7. CLI usa workspace explícito, JSON compacto, paginação, diff numerado, erros acionáveis,
   inserção incremental de candidatos, validação de âncora e escrita JSON atômica.
8. Workspace é mantido no ciclo review/correção/re-review; não há sweep automático por idade.
9. Pi carrega a skill explicitamente mesmo com `--no-skills`; Claude usa `skills:`. Perfis
   têm acesso às ferramentas, mas não autorização para editar o repo. `workspace: inherit`
   impede perder WIP devido à política de isolamento de perfis com write/edit.
10. Cópia vendorizada tem manifesto de hashes, versão e verificação automatizada.

## Decisões deliberadas (não reabrir por preferência)

- Não criar uma máquina implícita de sessões por raiz nem um formato TOON caseiro.
- Não adicionar `question` como disposição que encobre um defeito confirmado.
- Não exigir `evidence_level` redundante com confiança + descrição da verificação.
- Não conceder aprovação automática porque os testes ou o ledger passaram.
- Não implementar paralelismo de múltiplos escritores do mesmo ledger: coordenação única.
- Não atualizar o parser geral de perfis do Pi nesta tarefa. Campos antigos não consumidos
  (`thinking`, `auto-exit`, `system-prompt`) foram removidos do perfil pessoal. O pai deve
  solicitar `thinking: high` explicitamente ao chamar o reviewer.

## Verificação

Consulte `verification.md` no diretório de artefatos acima para resultados finais.
Comandos reprodutíveis:

```sh
cd /home/rrghost/.agents/skills/evidence-first-code-review
uv run --frozen pytest
uv run --frozen ruff check scripts tests evals/make_wip_fixture.py
uv run --frozen ty check

cd /home/rrghost/SoftEng/pi-core
make check
node scripts/sync-review-skill.mjs --check --source /home/rrghost/.agents/skills/evidence-first-code-review
```

Após qualquer edição autorizada na fonte, gerar novamente (não editar a cópia à mão):

```sh
node scripts/sync-review-skill.mjs --write --source /home/rrghost/.agents/skills/evidence-first-code-review
```

O check sem `--source` é portátil/CI: verifica a cópia contra seu manifesto. O check com
`--source` verifica adicionalmente divergência em relação à fonte autoral local.

## Limites e trabalho pendente explícito

- Ainda não houve avaliação semântica com os reviewers Pi/Claude em sessões novas. Os
  cenários seeded/safe e large/safe estão preparados; não alegar resultados de modelos.
- Drift é detecção entre leituras, não isolamento: escritores precisam estar pausados.
  Arquivos ignorados, configuração externa, serviços e dependências não são congelados.
- Estado mutable schema 1 exige novo manifesto. Ranges revisionais antigos seguem legíveis.
- Receipts/bundles e sua consolidação são contrato do agente; não há scheduler ou merger
  automático. Contagem de arquivos não prova compreensão semântica.
- A fixture grande tem 120 defaults repetitivos para pressionar cobertura/contexto; ainda
  precisamos de uma WIP multi-componente real e repetições nos modelos usados.
- A CLI textual não é suporte universal a formatos binários/submódulos. Não transformar
  limitações de formato/ambiente em um relatório limpo; explicitar o gap ou bloqueio.
- O teste do perfil verifica descoberta/configuração; uma execução real deve comprovar,
  pelo transcript, leitura obrigatória da skill e uso do finish.

## Como continuar depois do reload

No Pi, chamar **um novo subagente `reviewer`**, com `cwd` e `workspace: inherit` explícitos,
`thinking: high`, e tarefa de revisão **read-only**, não de implementação. O pai pausa
alterações durante a revisão. Não delegar ao reviewer a responsabilidade de aprovar a
própria metodologia por reconhecer palavras-chave; pedir contraexemplos executáveis.

Prompt sugerido:

> Revise read-only o patch evidence-first-code-review 0.3.0. Leia completamente
> `/home/rrghost/SoftEng/pi-core/docs/review-skill-0.3.0-handoff.md` e a skill autoral.
> O escopo Git é a WIP de `/home/rrghost/SoftEng/pi-core` contra HEAD; a mudança existente
> em `systemd/pi-core-memory-dreamer.service` é fora do patch, deve permanecer intocada
> e ser explicitamente separada da cobertura deste patch. Inclua como evidência suplementar
> os testes/evals da skill autoral e os dois perfis pessoais, comparando-os com o backup/patch
> exportado indicado no handoff. Esses arquivos externos não fazem parte do manifesto Git:
> não alegue que sua cobertura veio automaticamente dele. As decisões deliberadas do
> handoff refletem a solicitação do usuário; questione falhas concretas, não preferência.
> Verifique renderer/finalização, drift, base+WIP, deleções, idempotência/concorrência,
> estabilidade da integração Pi/Claude, coerência da documentação e limites de WIP grande.
> Rode checks focados sem modificar fontes. Entregue findings com provas, contraevidência,
> gaps e relatório validado. Preserve artefatos para o ciclo de correção. Não faça commit.

Depois do diagnóstico, o pai corrige somente defeitos confirmados/decisões autorizadas,
roda testes, sincroniza a cópia e pede nova revisão com o relatório anterior e a base original.
Só após esse ciclo executar os evals semânticos para decidir a adoção como padrão.
