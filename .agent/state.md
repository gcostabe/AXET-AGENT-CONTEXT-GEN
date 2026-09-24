# CURRENT PROJECT STATE

Last updated: 2026-09-24 (America/Sao_Paulo)

Agent/session: Axet Multimodal Pipeline — Redesenho de Layout em Tela Única (Single-Screen 100vh), Paginação e Filtros para Filas e Histórico, e Identidade Visual NTT DATA.

---

## Current Version

v0.12.1 (Ver `versionamento.md` para o histórico detalhado).

---

## Current Objective

Processamento multimodal enriquecido de vídeos com OCR de telas, formulários e diagramas via LLM Gateway (:8766), mantendo compatibilidade com áudio clássico e controle dinâmico no Cockpit Web (http://localhost:4545/).

---

## Active Task

Status: COMPLETED (2026-09-24)

Task ID: TASK-20260924-REEF-TRON-INTRO-REPORT

Description: Relatório técnico-funcional multimodal exaustivo de 27 seções sobre a introdução REEF/TRON: evolução de versões, presença internacional, capacidades, modularidade, parametrização e módulo de Comunes, sustentado exclusivamente na transcrição Whisper e nos Frames 01–10 da solicitação atual.

Validation: Concluída — script confirmou as 27 seções principais em ordem, oito subseções de Q&A, referências aos Frames 01 e 04–10, filtro explícito dos Frames 02–03 e `git diff --check` sem falhas; documento com 658 linhas / 46.733 bytes.

---

## Current Implementation State

- `instalar_windows.bat` & `scripts/setup_wsl_internal.sh` — Instalador One-Click para Windows via WSL2 com detecção de GPU NVIDIA CUDA.
- `iniciar_cockpit.bat` — Lançador diário de duplo clique para Windows que inicia o Cockpit e abre o navegador padrão.
- `setup_mac.sh` & `iniciar_mac.command` — Instalador e lançador de duplo clique para macOS.
- `dashboard/server.js` — Resolvedor dinâmico `resolveOktaIdentity()` com decodificação de JWT e verificação de saúde do gateway (:8766 / :3001); endpoints `/api/auth/status`, `/api/auth/refresh`, `/api/fs/open`, `/api/batch/config` (com persistência imediata em `batch_manifest.json`); sincronização de itens do manifesto em `/state`; auto-refresh de token gateway.
- `dashboard/index.html` — Layout com badge Okta SSO dinâmico, modal enriquecido com metadados OIDC (Login corporativo, Okta User ID, TTL de sessão, IdP OneNTT), barra multissegmentada no KPI 2, simetria em diretórios e Card 3 de Telemetria de Tokens.
- `dashboard/style.css` — Estilos corporativos do modal Okta SSO, cards ativos, grid simétrico e paleta NTT DATA.
- `dashboard/app.js` — Função `syncAuthStatus()` para binding dinâmico de todos os claims corporativos, status em tempo real a cada 60s, sincronização de filas e histórico; persistência reativa e salvaguarda em `localStorage` para todos os parâmetros de configuração (Whisper, LLM, Idioma, Paralelismo, Pastas e Visão OCR).

---

## Latest Relevant Changes

- Implementada telemetria visual em tempo real para a Análise RAG (etapa 3 / `interpretacao_axet`): streaming monitorado via `AXET_STREAM_OUT` em background emitindo as 5 fases (15% ➔ 35% ➔ 55% ➔ 75% ➔ 90% ➔ 100%), ticker segundo a segundo no frontend (`tickActiveTimers()`) sem re-renderização completa do DOM, efeito visual de shimmer na barra de progresso ativa, e aceleração do Whisper (`-mc 0`, `-nf`, `-bs 1 -bo 1` e sanitização deduplicando repetições consecutivas com `awk`).
- Substituído `relatorio_tecnico_multimodal_reef_tron.md` por relatório de 27 seções sobre introdução REEF/TRON. O conteúdo usa Frame 01 e Frames 04–10 para evolução de versões, presença internacional, capacidades, modularidade, flexibilidade, integrações funcionais e módulo de Comunes; Frames 02–03 foram filtrados como ruído visual e as lacunas técnicas permanecem explícitas.
- Corrigida a reversão involuntária dos campos "Modelo LLM de Síntese RAG" e "Whisper (Áudio)": eliminada a sobrescrita forçada no polling/SSE de 3 segundos em `renderBatchState()`, implementados listeners `"change"` com persistência no `localStorage` e no backend (`POST /api/batch/config`), com gravação atômica em `.agent/batch_manifest.json`.
- Removida a tentativa de acionamento do Finder via AppleScript (`osascript`) ao clicar em "Procurar": `dashboard/app.js` agora abre diretamente e de forma instantânea o modal customizado de seleção de diretórios, e `dashboard/server.js` teve `chooseFolderNative` desativado defensivamente.
- Implementado redesenho completo de tela única (Single-Screen 100vh Viewport) eliminando scroll confuso de 3.500px.
- Implementada paginação e busca instantânea com chips de status na Fila do Lote e no Histórico Concluído.
- Integrados os logos oficiais da NTT DATA na pasta `logos/` (`ntt-data-logo.png`, `ntt-symbol.png`, `favicon-64.png`).
- Implementado suporte a `.html`, `.htm` e `.xhtml` com sanitização de scripts/estilos/navegação e conversão direta para Markdown estruturado.
- Implementado suporte a `.xlsx`, `.xls`, `.csv` e `.tsv` com conversão automática de abas em tabelas Markdown.
- Implementado suporte a `.txt`, `.md`, `.markdown`, `.json`, `.jsonl`, `.xml` e formatos OpenDocument (.odt, .ods, .odp).
- Adicionado watchdog auto-pump de 5s no servidor Node para evitar pausas acidentais na fila.

---

## Known Problems

- `.AGENTS.md` (dotfile, com ponto) contém conteúdo de bootstrap diagnostic — mantido intocado por política de não deletar arquivos. O arquivo autoritativo de regras é `AGENTS.md`.
- Workspace versionado no Git em https://github.com/gberbert/AGENTE-CONTEXT-GEN.git (branch `main`).
- Servidor do dashboard mantém `runs` apenas em memória (reinício do Node reinicia o mapa de runs).

---

## Pending Work

- Nenhum trabalho pendente relacionado ao relatório de Contabilidade REEF/TRON solicitado.

---

## Important Constraints

- Não deletar nenhum arquivo existente.
- Não sobrescrever `.vscode/settings.json` sem merge.
- Não fazer bump de versão sem mudança relevante correspondente em `versionamento.md`.
- Não realizar operações destrutivas ou de produção sem aprovação explícita do usuário.

---

## Next Recommended Action

Aguardar nova solicitação do usuário.
