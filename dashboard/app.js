/**
 * dashboard/app.js
 *
 * Cliente do cockpit: conecta via SSE em /events, carrega snapshot inicial
 * em /state, e renderiza em tempo real:
 *   - N cards de execuções ATIVAS simultaneamente (multi-run), cada um com
 *     seu próprio status, etapas, barra de progresso e log stream.
 *   - histórico de execuções (ativas + finalizadas)
 *
 * NOTA IMPORTANTE (fix de bug):
 *   A versão anterior usava uma única variável global `currentRunId` que
 *   era sobrescrita a cada evento recebido (run_start, step_start, log...).
 *   Isso fazia a UI "pular" de uma execução para outra quando dois ou mais
 *   pipelines rodavam em paralelo (ex: mesmo vídeo com modelos diferentes),
 *   pois o painel único sempre mostrava apenas o run do ÚLTIMO evento
 *   recebido, escondendo o progresso das demais execuções em andamento.
 *
 *   A correção troca o painel único por uma GRADE de cards, um por run
 *   ativo (status === 'running'), renderizados e atualizados de forma
 *   independente. Não há mais uma variável "run atual": cada evento
 *   atualiza APENAS o card do seu próprio run_id.
 */

const STEP_ORDER = [
  "extracao_audio",
  "transcricao_whisper",
  "interpretacao_axet",
  "geracao_markdown",
];

const DOC_STEP_ORDER = [
  "extracao_documento",
  "interpretacao_axet",
  "geracao_markdown",
];

const DOC_EXTENSIONS = [
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".odt", ".odp", ".ods",
  ".html", ".htm", ".xhtml", ".xml",
  ".txt", ".md", ".markdown", ".rtf",
  ".xlsx", ".xls", ".csv", ".tsv",
  ".json", ".jsonl"
];

function isDocumentRun(run) {
  if (!run) return false;
  if (run.media_type === "document" || run.mediaType === "document") return true;
  if (run.media_type === "video" || run.mediaType === "video") return false;
  if (run.steps && run.steps.extracao_documento) return true;
  if (run.steps && (run.steps.extracao_audio || run.steps.transcricao_whisper)) return false;
  const filename = run.video || run.filename || run.name || "";
  const lastDot = filename.lastIndexOf(".");
  if (lastDot !== -1) {
    const ext = filename.slice(lastDot).toLowerCase();
    if (DOC_EXTENSIONS.includes(ext)) return true;
  }
  return false;
}

function getRunStepOrder(run) {
  return isDocumentRun(run) ? DOC_STEP_ORDER : STEP_ORDER;
}

const STEP_LABELS = {
  extracao_audio: "Extração de Áudio (ffmpeg)",
  transcricao_whisper: "Transcrição (Whisper)",
  interpretacao_axet: "Análise RAG (axet-code)",
  geracao_markdown: "Relatório Markdown Final",
  extracao_documento: "Extração Estruturada (Parser)",
};

const STEP_SHORT_NAMES = {
  extracao_audio: "Áudio",
  transcricao_whisper: "Whisper",
  interpretacao_axet: "Análise RAG",
  geracao_markdown: "Relatório .md",
  extracao_documento: "Extração Doc",
};

const STEP_ICONS = {
  extracao_audio: "🎵",
  transcricao_whisper: "🎙️",
  interpretacao_axet: "🤖",
  geracao_markdown: "📝",
  extracao_documento: "📄",
};

const STEP_DESCRIPTIONS = {
  extracao_audio: "Extração do stream de áudio PCM 16kHz mono via ffmpeg",
  transcricao_whisper: "Processamento acústico/temporal linha a linha via Whisper",
  interpretacao_axet: "Síntese com IA, extração de entidades técnicas e estruturação profunda para RAG",
  geracao_markdown: "Montagem do documento executivo final em Markdown com evidências e metadados",
  extracao_documento: "Parsing estruturado de texto, camadas, tabelas e metadados via Python",
};

const expandedHistoryRows = new Set();

const MAX_LOG_LINES_DOM = 200; // por card, para não pesar o DOM
const FINISHED_CARD_LINGER_MS = 5000; // tempo que um card finalizado fica visível antes de sair da grade

const $ = (id) => document.getElementById(id);

const activeRunsGrid = $("active-runs-grid");
const activeRunsEmpty = $("active-runs-empty");
const activeCountEl = $("active-count");
const historyRunsGrid = $("history-runs-grid");
const historyRunsEmpty = $("history-runs-empty");
const historyBody = historyRunsGrid || $("history-body");
const connDot = $("conn-dot");
const connStatus = $("conn-status");

// allRuns: run_id -> run object (estado completo, espelha o servidor)
// runOrderList: ordem de chegada dos run_ids (para o histórico)
let allRuns = {};
let runOrderList = [];

// Mantém referência aos elementos DOM já criados por run_id, para evitar
// recriar o card inteiro a cada evento (apenas atualizamos partes dele).
const runCardEls = {}; // run_id -> { root, stepsEl, progressBarEl, logStreamEl, statusEl, ... }

const lingerTimers = {}; // run_id -> timeoutId

// ---------------------------------------------------------------------------
// Helpers de formatação
// ---------------------------------------------------------------------------

function statusLabel(status) {
  switch (status) {
    case "running": return "em andamento...";
    case "success": return "concluído";
    case "error": return "falhou";
    case "cancelled": return "cancelado";
    default: return "pendente";
  }
}

function statusLabelRun(status) {
  switch (status) {
    case "running": return "em execução";
    case "success":
    case "completed": return "concluído";
    case "error":
    case "failed": return "erro";
    case "cancelled": return "cancelado";
    case "pending":
    case "waiting":
    case "queued": return "aguardando";
    default: return status || "—";
  }
}

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

function formatTime(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (_) {
    return "—";
  }
}

function formatDateTime(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch (_) {
    return "—";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Criação / atualização de cards de execução ATIVA
// ---------------------------------------------------------------------------

const expandedActiveRuns = new Set();

function createRunCard(runId) {
  const root = document.createElement("div");
  root.className = "run-card";
  root.dataset.runId = runId;

  root.innerHTML = `
    <div class="run-card-header" data-role="card-header">
      <div class="run-card-title">
        <span class="run-card-id">${escapeHtml(runId)}</span>
        <div class="run-card-title-actions">
          <span class="pipeline-type-badge pipeline-badge-video" data-role="pipeline-badge">
            <span class="badge-dot"></span> Pipeline
          </span>
          <span class="value status-pill running" data-role="status">em execução</span>
          <button type="button" class="btn-toggle-card-details" data-role="toggle-btn" title="Expandir ou recolher detalhes dos passos">
            <span class="toggle-txt">Passos</span> <span class="toggle-icon">▼</span>
          </button>
          <button type="button" class="btn-cancel" data-role="cancel-btn" title="Cancelar execução">Cancelar</button>
        </div>
      </div>
      <div class="run-card-meta" data-role="card-meta">
        <span class="meta-item"><span class="meta-lbl">Arquivo:</span> <strong data-role="video">—</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Whisper:</span> <strong data-role="whisper">—</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Modelo IA:</span> <strong data-role="axet">—</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Início:</span> <strong data-role="started">—</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Fim:</span> <strong data-role="finished">—</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Duração:</span> <strong data-role="duration" class="meta-dur">—</strong></span>
      </div>
    </div>

    <!-- Stepper de Fluxo da Pipeline (Conectado Horizontal) -->
    <div class="pipeline-flow-stepper-wrap">
      <div class="pipeline-flow-stepper" data-role="pipeline-stepper"></div>
    </div>

    <div class="progress-bar-wrap">
      <div class="progress-bar" data-role="progress-bar"></div>
    </div>

    <!-- Bloco Expansível: Passos Detalhados + Log Stream -->
    <div class="run-card-expandable collapsed" data-role="expandable">
      <div class="steps" data-role="steps"></div>
      <div class="panel logs-panel run-card-logs">
        <div class="panel-header">Log em tempo real</div>
        <div class="log-stream" data-role="log-stream"></div>
      </div>
    </div>
  `;

  const els = {
    root,
    cardHeaderEl: root.querySelector('[data-role="card-header"]'),
    pipelineBadgeEl: root.querySelector('[data-role="pipeline-badge"]'),
    cardMetaEl: root.querySelector('[data-role="card-meta"]'),
    pipelineStepperEl: root.querySelector('[data-role="pipeline-stepper"]'),
    statusEl: root.querySelector('[data-role="status"]'),
    videoEl: root.querySelector('[data-role="video"]'),
    whisperEl: root.querySelector('[data-role="whisper"]'),
    axetEl: root.querySelector('[data-role="axet"]'),
    startedEl: root.querySelector('[data-role="started"]'),
    finishedEl: root.querySelector('[data-role="finished"]'),
    durationEl: root.querySelector('[data-role="duration"]'),
    progressBarEl: root.querySelector('[data-role="progress-bar"]'),
    expandableEl: root.querySelector('[data-role="expandable"]'),
    toggleBtnEl: root.querySelector('[data-role="toggle-btn"]'),
    stepsEl: root.querySelector('[data-role="steps"]'),
    logStreamEl: root.querySelector('[data-role="log-stream"]'),
    cancelBtnEl: root.querySelector('[data-role="cancel-btn"]'),
  };

  function updateExpandState() {
    const isExp = expandedActiveRuns.has(runId);
    if (els.expandableEl) {
      els.expandableEl.classList.toggle("collapsed", !isExp);
    }
    if (els.toggleBtnEl) {
      const icon = els.toggleBtnEl.querySelector(".toggle-icon");
      const txt = els.toggleBtnEl.querySelector(".toggle-txt");
      if (icon) icon.textContent = isExp ? "▲" : "▼";
      if (txt) txt.textContent = isExp ? "Fechar" : "Passos";
    }
  }

  // Clicou no card abre, clicou de novo fecha
  root.addEventListener("click", (e) => {
    if (e.target.closest(".btn-cancel") || e.target.closest("a") || e.target.closest("input")) return;
    if (expandedActiveRuns.has(runId)) {
      expandedActiveRuns.delete(runId);
    } else {
      expandedActiveRuns.add(runId);
    }
    updateExpandState();
  });

  els.cancelBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    cancelRun(runId);
  });

  runCardEls[runId] = els;

  renderStepCardsForRun(runId);
  updateExpandState();

  return root;
}

// Envia a solicitação de cancelamento manual para o backend (POST /cancel),
// que por sua vez envia SIGTERM para o PID do processo Bash do pipeline.
async function cancelRun(runId) {
  const els = runCardEls[runId];
  if (els && els.cancelBtnEl) {
    els.cancelBtnEl.disabled = true;
    els.cancelBtnEl.textContent = "Cancelando...";
  }
  try {
    const res = await fetch("/cancel/" + encodeURIComponent(runId), {
      method: "POST",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("Falha ao cancelar run:", data.error || res.statusText);
      if (els && els.cancelBtnEl) {
        els.cancelBtnEl.disabled = false;
        els.cancelBtnEl.textContent = "Cancelar";
      }
    }
  } catch (e) {
    console.error("Erro de rede ao cancelar run:", e);
    if (els && els.cancelBtnEl) {
      els.cancelBtnEl.disabled = false;
      els.cancelBtnEl.textContent = "Cancelar";
    }
  }
}

function ensureRunCard(runId) {
  if (!runCardEls[runId]) {
    const card = createRunCard(runId);
    activeRunsGrid.appendChild(card);
    renderRunCardInfo(runId);
    renderInitialLogsForRun(runId);
  }
  return runCardEls[runId];
}

function removeRunCard(runId) {
  const els = runCardEls[runId];
  if (els && els.root && els.root.parentNode) {
    els.root.parentNode.removeChild(els.root);
  }
  delete runCardEls[runId];
  renderActiveRunsEmptyState();
}

function renderActiveRunsEmptyState() {
  const hasActiveCards = Object.keys(runCardEls).length > 0;
  activeRunsEmpty.style.display = hasActiveCards ? "none" : "block";
  const activeCount = Object.values(allRuns).filter((r) => r && r.status === "running").length;
  activeCountEl.textContent = String(activeCount);
}

function renderPipelineStepperForRun(runId) {
  const els = runCardEls[runId];
  if (!els || !els.pipelineStepperEl) return;
  const run = allRuns[runId];
  if (!run) return;

  const steps = getRunStepOrder(run);
  const total = steps.length;
  els.pipelineStepperEl.innerHTML = "";

  steps.forEach((stepKey, idx) => {
    const stepData = run.steps ? run.steps[stepKey] : null;
    const status = stepData ? stepData.status : "pending";
    const icon = STEP_ICONS[stepKey] || "⚙️";
    const shortName = STEP_SHORT_NAMES[stepKey] || stepKey;
    const durStr = stepData && stepData.duration_s != null ? formatDuration(stepData.duration_s) : "";

    const node = document.createElement("div");
    node.className = `stepper-step-node ${status}`;
    node.dataset.step = stepKey;

    let statusSymbol = idx + 1;
    if (status === "success") statusSymbol = "✓";
    else if (status === "error") statusSymbol = "✕";
    else if (status === "running") statusSymbol = `<span class="stepper-pulse"></span>`;

    let statusText = "aguardando";
    if (status === "running") {
      const pct = stepData && stepData.progress_pct != null ? `${Math.round(stepData.progress_pct)}%` : "em execução";
      statusText = pct;
    } else if (status === "success") {
      statusText = durStr || "concluído";
    } else if (status === "error") {
      statusText = "falhou";
    }

    node.innerHTML = `
      <div class="stepper-bubble" title="${STEP_LABELS[stepKey] || stepKey} (${statusLabel(status)})">
        <span class="stepper-num">${statusSymbol}</span>
      </div>
      <div class="stepper-label-wrap">
        <span class="stepper-name">${icon} ${shortName}</span>
        <span class="stepper-status-note">${statusText}</span>
      </div>
    `;

    els.pipelineStepperEl.appendChild(node);

    if (idx < total - 1) {
      const line = document.createElement("div");
      const isPassed = status === "success";
      line.className = `stepper-connector ${isPassed ? "completed" : ""}`;
      els.pipelineStepperEl.appendChild(line);
    }
  });
}

function renderStepCardsForRun(runId) {
  const els = runCardEls[runId];
  if (!els) return;
  const run = allRuns[runId];

  // Renderiza Stepper de Fluxo da Pipeline
  renderPipelineStepperForRun(runId);
  renderRunCardInfo(runId);

  els.stepsEl.innerHTML = "";
  const steps = getRunStepOrder(run);

  steps.forEach((stepKey, idx) => {
    const stepData = run && run.steps ? run.steps[stepKey] : null;
    const status = stepData ? stepData.status : "pending";

    const card = document.createElement("div");
    card.className = `step-card ${status}`;
    card.dataset.step = stepKey;

    // 1. Cabeçalho da etapa com número, nome e tag de status
    const topRow = document.createElement("div");
    topRow.className = "step-card-top";

    const name = document.createElement("div");
    name.className = "step-name";
    name.textContent = `Passo ${idx + 1}/${steps.length} · ${STEP_LABELS[stepKey] || stepKey}`;
    topRow.appendChild(name);

    const statusBadge = document.createElement("span");
    statusBadge.className = `step-status-tag ${status}`;
    statusBadge.textContent = statusLabel(status);
    topRow.appendChild(statusBadge);
    card.appendChild(topRow);

    // 2. Horários de início e fim e duração
    const timingRow = document.createElement("div");
    timingRow.className = "step-timing-row";

    const startStr = stepData && stepData.started_at ? formatTime(stepData.started_at) : "—";
    const endStr = stepData && stepData.finished_at
      ? formatTime(stepData.finished_at)
      : (status === "running" ? "em andamento..." : "—");

    let durStr = "";
    if (stepData && stepData.duration_s != null) {
      durStr = formatDuration(stepData.duration_s);
    } else if (status === "running" && stepData && stepData.started_at) {
      const elap = Math.max(0, (Date.now() - new Date(stepData.started_at).getTime()) / 1000);
      durStr = formatDuration(elap);
    }

    const showDur = Boolean(durStr) || status === "running";
    timingRow.innerHTML = `
      <span class="timing-item" title="Hora de início da etapa"><span class="timing-lbl">Início:</span> <strong>${startStr}</strong></span>
      <span class="timing-sep">·</span>
      <span class="timing-item" title="Hora de término da etapa"><span class="timing-lbl">Fim:</span> <strong>${endStr}</strong></span>
      <span class="timing-sep timing-dur-sep" style="${showDur ? '' : 'display:none;'}">·</span>
      <span class="timing-dur" title="Duração da etapa" style="${showDur ? '' : 'display:none;'}">⏱ <strong data-role="timing-dur">${durStr || "0s"}</strong></span>
    `;
    card.appendChild(timingRow);

    // 3. Detalhes técnicos do passo
    const detail = document.createElement("div");
    const isErr = status === "error";
    let detailText = stepData && stepData.detalhes ? stepData.detalhes : "";
    if (!detailText && isErr) {
      const lastErrLog = (run.logs || []).slice().reverse().find(l => l.level === "ERROR");
      detailText = lastErrLog ? lastErrLog.message : "Erro na etapa.";
    } else if (!detailText) {
      detailText = (STEP_DESCRIPTIONS[stepKey] || statusLabel(status));
    }
    detail.className = `step-detail ${isErr ? "step-detail-error" : ""}`;
    detail.textContent = detailText;
    card.appendChild(detail);

    // 4. Sub-barra de progresso do step ativo (running)
    if (status === "running") {
      const progWrap = document.createElement("div");
      progWrap.className = "step-progress-wrap";
      progWrap.dataset.step = stepKey;

      const progFill = document.createElement("div");
      progFill.className = "step-progress-fill";
      const initialPct = stepData && stepData.progress_pct != null ? stepData.progress_pct : 0;
      progFill.style.width = `${Math.max(0, Math.min(100, initialPct))}%`;
      progWrap.appendChild(progFill);

      const progLabel = document.createElement("div");
      progLabel.className = "step-progress-label";
      progLabel.dataset.role = "step-progress-label";
      progLabel.textContent = `${Math.round(initialPct)}%`;
      progWrap.appendChild(progLabel);

      card.appendChild(progWrap);
    }

    els.stepsEl.appendChild(card);
  });

  updateProgressBarForRun(runId);
}

// Atualiza apenas a sub-barra de progresso (fill + label) de um step já
// renderizado no DOM, sem recriar todos os step-cards do run — evita
// flicker e é chamada a cada evento "step_progress" (potencialmente
// muitos eventos por segundo durante a transcrição do whisper).
function updateStepProgressUI(runId, stepKey) {
  const els = runCardEls[runId];
  if (!els) return;
  const run = allRuns[runId];
  if (!run || !run.steps || !run.steps[stepKey]) return;

  const stepData = run.steps[stepKey];
  const progWrap = els.stepsEl.querySelector(`.step-progress-wrap[data-step="${stepKey}"]`);
  if (!progWrap) {
    // Sub-barra ainda não existe no DOM (ex.: o evento "step_progress"
    // chegou antes do card ter sido re-renderizado pelo "step_start") —
    // força a reconstrução completa dos step-cards para criá-la.
    renderStepCardsForRun(runId);
    return;
  }

  const pct = Math.max(0, Math.min(100, stepData.progress_pct != null ? stepData.progress_pct : 0));
  const fillEl = progWrap.querySelector(".step-progress-fill");
  const labelEl = progWrap.querySelector('[data-role="step-progress-label"]');
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (labelEl) labelEl.textContent = `${Math.round(pct)}%`;

  // Atualiza texto de detalhes técnicos e tag de status no step card diretamente sem recriar todo o DOM
  const cardEl = els.stepsEl.querySelector(`.step-card[data-step="${stepKey}"]`) || progWrap.closest(".step-card");
  if (cardEl) {
    if (stepData.detalhes) {
      const detailEl = cardEl.querySelector(".step-detail");
      if (detailEl) detailEl.textContent = stepData.detalhes;
    }
    const statusTag = cardEl.querySelector(".step-status-tag");
    if (statusTag && stepData.status === "running") {
      statusTag.textContent = pct > 0 ? `Em andamento (${Math.round(pct)}%)` : "Em andamento";
    }
  }

  // Atualiza porcentagem no stepper horizontal da pipeline
  if (els.pipelineStepperEl) {
    const stepNode = els.pipelineStepperEl.querySelector(`.stepper-step-node[data-step="${stepKey}"]`);
    if (stepNode) {
      const noteEl = stepNode.querySelector(".stepper-status-note");
      if (noteEl && stepData.status === "running") {
        noteEl.textContent = `${Math.round(pct)}%`;
      }
    }
  }
}

function updateProgressBarForRun(runId) {
  const els = runCardEls[runId];
  if (!els) return;
  const run = allRuns[runId];

  if (!run) {
    els.progressBarEl.style.width = "0%";
    return;
  }
  const steps = getRunStepOrder(run);
  const total = steps.length;
  let done = 0;
  steps.forEach((k) => {
    const s = run.steps && run.steps[k];
    if (s && (s.status === "success" || s.status === "error")) done++;
  });
  const pct = Math.round((done / total) * 100);
  els.progressBarEl.style.width = `${pct}%`;
}

function renderRunCardInfo(runId) {
  const els = runCardEls[runId];
  if (!els) return;
  const run = allRuns[runId];
  if (!run) return;

  const isDoc = isDocumentRun(run);

  // Atualiza Badge da Pipeline no topo do card
  if (els.pipelineBadgeEl) {
    if (isDoc) {
      els.pipelineBadgeEl.className = "pipeline-type-badge pipeline-badge-doc";
      els.pipelineBadgeEl.innerHTML = `<span class="badge-dot"></span>📄 Pipeline Documento (3 Etapas)`;
    } else {
      els.pipelineBadgeEl.className = "pipeline-type-badge pipeline-badge-video";
      els.pipelineBadgeEl.innerHTML = `<span class="badge-dot"></span>🎬 Pipeline Vídeo (4 Etapas)`;
    }
  }

  // Atualiza Metadados Adaptativos
  if (els.cardMetaEl) {
    const startedStr = run.started_at ? formatTime(run.started_at) : "—";
    const finishedStr = run.finished_at ? formatTime(run.finished_at) : (run.status === "running" ? "em execução..." : "—");
    let durStr = "—";
    if (run.duration_total_s != null) {
      durStr = formatDuration(run.duration_total_s);
    } else if (run.started_at) {
      const elapsed = Math.max(0, (Date.now() - new Date(run.started_at).getTime()) / 1000);
      durStr = `${formatDuration(elapsed)} (ativo)`;
    }

    if (isDoc) {
      els.cardMetaEl.innerHTML = `
        <span class="meta-item"><span class="meta-lbl">Arquivo:</span> <strong title="${escapeHtml(run.video || '')}">${escapeHtml(run.video || '—')}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Pipeline:</span> <span class="meta-pill meta-pill-doc">Documento (3 etapas)</span></span> ·
        <span class="meta-item"><span class="meta-lbl">Modelo IA:</span> <strong>${escapeHtml(run.axet_model || 'gpt-5.6-terra')}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Início:</span> <strong>${startedStr}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Duração:</span> <strong class="meta-dur">${durStr}</strong></span>
      `;
    } else {
      els.cardMetaEl.innerHTML = `
        <span class="meta-item"><span class="meta-lbl">Vídeo:</span> <strong title="${escapeHtml(run.video || '')}">${escapeHtml(run.video || '—')}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Whisper:</span> <strong>${escapeHtml(run.whisper_model || 'large-v3')}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Modelo IA:</span> <strong>${escapeHtml(run.axet_model || 'gpt-5.6-terra')}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Início:</span> <strong>${startedStr}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Duração:</span> <strong class="meta-dur">${durStr}</strong></span>
      `;
    }
  }

  // Mantém referências antigas caso sejam lidas em algum outro lugar
  if (els.videoEl) els.videoEl.textContent = run.video || "—";
  if (els.whisperEl) els.whisperEl.textContent = run.whisper_model || "—";
  if (els.axetEl) els.axetEl.textContent = run.axet_model || "—";

  els.statusEl.textContent = statusLabelRun(run.status);
  els.statusEl.className = `value status-pill ${run.status}`;

  if (els.cancelBtnEl) {
    els.cancelBtnEl.style.display = run.status === "running" ? "inline-block" : "none";
  }

  if (els.startedEl) {
    els.startedEl.textContent = run.started_at ? formatTime(run.started_at) : "—";
  }
  if (els.finishedEl) {
    els.finishedEl.textContent = run.finished_at ? formatTime(run.finished_at) : (run.status === "running" ? "em execução..." : "—");
  }

  if (els.durationEl) {
    if (run.duration_total_s != null) {
      els.durationEl.textContent = formatDuration(run.duration_total_s);
    } else if (run.started_at) {
      const elapsed = Math.max(0, (Date.now() - new Date(run.started_at).getTime()) / 1000);
      els.durationEl.textContent = `${formatDuration(elapsed)} (em execução...)`;
    } else {
      els.durationEl.textContent = "—";
    }
  }
}

function appendLogLineToRun(runId, entry) {
  const els = runCardEls[runId];
  if (!els) return;

  const line = document.createElement("div");
  line.className = `log-line level-${entry.level || "INFO"}`;

  const time = new Date(entry.ts || Date.now()).toLocaleTimeString("pt-BR");
  const stepTag = entry.step ? `[${STEP_LABELS[entry.step] || entry.step}] ` : "";

  line.innerHTML = `<span class="ts">${time}</span> <span class="lvl">${entry.level || "INFO"}</span> ${stepTag}${escapeHtml(entry.message || "")}`;

  els.logStreamEl.appendChild(line);
  els.logStreamEl.scrollTop = els.logStreamEl.scrollHeight;

  while (els.logStreamEl.children.length > MAX_LOG_LINES_DOM) {
    els.logStreamEl.removeChild(els.logStreamEl.firstChild);
  }
}

function renderInitialLogsForRun(runId) {
  const els = runCardEls[runId];
  const run = allRuns[runId];
  if (!els || !run) return;
  els.logStreamEl.innerHTML = "";
  if (Array.isArray(run.logs)) {
    run.logs.forEach((entry) => appendLogLineToRun(runId, entry));
  }
}

// Reavalia quais runs devem ter card ativo na grid: todo run com
// status === 'running' recebe um card; ao finalizar (success/error), o
// card permanece visível por FINISHED_CARD_LINGER_MS para o usuário ver
// o resultado, depois é removido da grade (o run continua no histórico).
function syncActiveRunCards() {
  Object.keys(allRuns).forEach((runId) => {
    const run = allRuns[runId];
    if (run.status === "running") {
      ensureRunCard(runId);
      if (lingerTimers[runId]) {
        clearTimeout(lingerTimers[runId]);
        delete lingerTimers[runId];
      }
    } else if (run.status === "cancelled") {
      if (runCardEls[runId]) {
        if (lingerTimers[runId]) {
          clearTimeout(lingerTimers[runId]);
          delete lingerTimers[runId];
        }
        removeRunCard(runId);
      }
    } else if (run.status === "success" || run.status === "error") {
      if (runCardEls[runId] && !lingerTimers[runId]) {
        lingerTimers[runId] = setTimeout(() => {
          removeRunCard(runId);
          delete lingerTimers[runId];
        }, FINISHED_CARD_LINGER_MS);
      }
    }
  });
  renderActiveRunsEmptyState();
}

// ---------------------------------------------------------------------------
// Histórico de execuções
// ---------------------------------------------------------------------------

function toggleHistoryDetails(runId) {
  if (expandedHistoryRows.has(runId)) {
    expandedHistoryRows.delete(runId);
  } else {
    expandedHistoryRows.add(runId);
  }
  renderHistory();
}

let historyCurrentPage = 1;
let historyPageSize = 25;
let historySearchTerm = "";
let historyStatusFilter = "all";
let lastCalculatedHistoryTotalPages = 1;

function syncBatchQueueToRuns(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return false;
  let changed = false;

  queue.forEach((item) => {
    if (item.status === "completed" || item.status === "error") {
      const runId = item.runId || `item_${item.id}`;
      const isDoc = item.mediaType === "document" || isDocumentRun({ video: item.filename });
      const existing = allRuns[runId];

      if (!existing) {
        allRuns[runId] = {
          run_id: runId,
          video: item.filename,
          fullPath: item.fullPath,
          media_type: item.mediaType || (isDoc ? "document" : "video"),
          status: item.status,
          started_at: item.startedAt || null,
          finished_at: item.finishedAt || null,
          duration_s: item.duration_s != null ? item.duration_s : null,
          duration_total_s: item.duration_s != null ? item.duration_s : null,
          markdown_path: item.markdownPath || null,
          axet_model: (currentBatch && currentBatch.axetModel) || "gpt-5.6-terra",
          whisper_model: (currentBatch && currentBatch.whisperModel) || "small",
          steps: {
            extracao_audio: { status: isDoc ? "skipped" : "success", duration_s: 1 },
            transcricao_whisper: { status: isDoc ? "skipped" : "success", duration_s: Math.round((item.duration_s || 30) * 0.4) },
            extracao_documento: { status: isDoc ? "success" : "skipped", duration_s: 1 },
            interpretacao_axet: { status: item.status === "error" ? "error" : "success", duration_s: Math.round((item.duration_s || 30) * 0.5) },
            geracao_markdown: { status: item.status === "error" ? "error" : "success", duration_s: 1 },
          },
          fromBatchQueue: true,
        };
        if (!runOrderList.includes(runId)) {
          runOrderList.push(runId);
        }
        changed = true;
      } else {
        if (existing.status !== item.status) {
          existing.status = item.status;
          changed = true;
        }
        if (item.markdownPath && !existing.markdown_path) {
          existing.markdown_path = item.markdownPath;
          changed = true;
        }
        if (item.duration_s != null && existing.duration_s == null) {
          existing.duration_s = item.duration_s;
          existing.duration_total_s = item.duration_s;
          changed = true;
        }
      }
    }
  });

  return changed;
}

function createHistoryCard(runId, run) {
  const root = document.createElement("div");
  const isErr = run.status === "error" || run.status === "failed";
  root.className = `run-card run-card-history ${run.status || 'completed'}`;
  root.dataset.runId = runId;

  const isDoc = isDocumentRun(run);
  const histSteps = getRunStepOrder(run);
  const totalSteps = histSteps.length;
  const isExp = expandedHistoryRows.has(runId);

  const startedStr = run.started_at ? formatDateTime(run.started_at) : "—";
  const finishedStr = run.finished_at ? formatDateTime(run.finished_at) : (run.status === "running" ? "em execução..." : "—");
  const durStr = run.duration_total_s != null ? formatDuration(run.duration_total_s) : "—";

  const pipelineBadgeHtml = isDoc
    ? `<span class="pipeline-type-badge pipeline-badge-doc"><span class="badge-dot"></span>📄 Pipeline Documento (3 Etapas)</span>`
    : `<span class="pipeline-type-badge pipeline-badge-video"><span class="badge-dot"></span>🎬 Pipeline Vídeo (4 Etapas)</span>`;

  let reportPath = run.markdown_path || run.markdownPath || run.report_path || "";
  if (!reportPath && currentBatch && Array.isArray(currentBatch.queue)) {
    const queueItem = currentBatch.queue.find(q => 
      q.runId === runId || 
      q.id === runId || 
      (q.filename && run.video && (q.filename === run.video || q.filename.includes(run.video) || run.video.includes(q.filename))) ||
      (q.video && run.video && (q.video === run.video || q.video.includes(run.video) || run.video.includes(q.video)))
    );
    if (queueItem && queueItem.markdownPath) {
      reportPath = queueItem.markdownPath;
      run.markdown_path = reportPath;
    }
  }
  const reportName = reportPath ? reportPath.split("/").pop() : "";

  root.innerHTML = `
    <div class="run-card-header" data-role="card-header">
      <div class="run-card-title">
        <span class="run-card-id" title="${escapeHtml(runId)}">${escapeHtml(runId)}</span>
        <div class="run-card-title-actions">
          ${pipelineBadgeHtml}
          <span class="value status-pill ${run.status}">${statusLabelRun(run.status)}</span>
          <button type="button" class="btn-toggle-card-details" data-role="toggle-btn" title="Expandir ou recolher detalhes dos passos">
            <span class="toggle-txt">${isExp ? 'Fechar' : 'Passos'}</span> <span class="toggle-icon">${isExp ? '▲' : '▼'}</span>
          </button>
        </div>
      </div>
      <div class="run-card-meta" data-role="card-meta">
        <span class="meta-item"><span class="meta-lbl">${isDoc ? 'Arquivo' : 'Vídeo'}:</span> <strong title="${escapeHtml(run.video || '')}">${escapeHtml(run.video || '—')}</strong></span> ·
        ${isDoc
          ? `<span class="meta-item"><span class="meta-lbl">Pipeline:</span> <span class="meta-pill meta-pill-doc">Documento (3 etapas)</span></span> ·`
          : `<span class="meta-item"><span class="meta-lbl">Whisper:</span> <strong>${escapeHtml(run.whisper_model || 'large-v3')}</strong></span> ·`
        }
        <span class="meta-item"><span class="meta-lbl">Modelo IA:</span> <strong>${escapeHtml(run.axet_model || 'gpt-5.6-terra')}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Início:</span> <strong>${startedStr}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Fim:</span> <strong>${finishedStr}</strong></span> ·
        <span class="meta-item"><span class="meta-lbl">Duração:</span> <strong class="meta-dur">⏱ ${durStr}</strong></span>
      </div>
    </div>

    <!-- Stepper de Fluxo da Pipeline (Conectado Horizontal) -->
    <div class="pipeline-flow-stepper-wrap">
      <div class="pipeline-flow-stepper" data-role="pipeline-stepper"></div>
    </div>

    <!-- Barra de Progresso da Pipeline -->
    <div class="progress-bar-wrap">
      <div class="progress-bar ${isErr ? 'error' : ''}" style="width: 100%;"></div>
    </div>

    <!-- Bloco Expansível: Passos Detalhados + Relatório .md + Log Stream -->
    <div class="run-card-expandable ${isExp ? '' : 'collapsed'}" data-role="expandable">
      <div class="steps" data-role="steps"></div>

      <!-- Relatório Markdown de Saída (Dentro do Detalhamento, Antes do Log) -->
      ${reportPath ? `
      <div class="history-report-box">
        <div class="history-report-info">
          <span class="history-report-icon">📄</span>
          <div class="history-report-text">
            <div class="history-report-title">Relatório Markdown de Saída</div>
            <div class="history-report-name" title="${escapeHtml(reportPath)}">${escapeHtml(reportName || reportPath)}</div>
            <div class="history-report-path" title="${escapeHtml(reportPath)}">${escapeHtml(reportPath)}</div>
          </div>
        </div>
        <button type="button" class="btn-open-report-main" data-role="open-report" title="Abrir arquivo Markdown no editor do sistema">
          <span>Abrir Relatório .md</span> ↗
        </button>
      </div>
      ` : ''}

      <div class="panel logs-panel run-card-logs">
        <div class="panel-header">Logs da Execução</div>
        <div class="log-stream" data-role="log-stream"></div>
      </div>
    </div>
  `;

  // 1. Stepper horizontal conectado
  const stepperEl = root.querySelector('[data-role="pipeline-stepper"]');
  if (stepperEl) {
    stepperEl.innerHTML = "";
    histSteps.forEach((stepKey, idx) => {
      const stepData = run.steps ? run.steps[stepKey] : null;
      const status = stepData ? stepData.status : "pending";
      const shortName = STEP_SHORT_NAMES[stepKey] || stepKey;
      const durStr = stepData && stepData.duration_s != null ? formatDuration(stepData.duration_s) : "";

      const node = document.createElement("div");
      node.className = `stepper-step-node ${status}`;

      let statusSymbol = idx + 1;
      if (status === "success" || status === "completed") statusSymbol = "✓";
      else if (status === "error" || status === "failed") statusSymbol = "✕";

      node.innerHTML = `
        <div class="stepper-bubble" title="${STEP_LABELS[stepKey] || stepKey} (${statusLabel(status)})">${statusSymbol}</div>
        <div class="stepper-label-wrap">
          <span class="stepper-name">${escapeHtml(shortName)}</span>
          <span class="stepper-status-note">${durStr || (status === "success" ? "concluído" : statusLabel(status))}</span>
        </div>
      `;
      stepperEl.appendChild(node);

      if (idx < totalSteps - 1) {
        const conn = document.createElement("div");
        conn.className = `stepper-connector ${status === "success" || status === "completed" ? "completed" : ""}`;
        stepperEl.appendChild(conn);
      }
    });
  }

  // 2. Passos detalhados (Step Cards)
  const stepsEl = root.querySelector('[data-role="steps"]');
  if (stepsEl) {
    stepsEl.innerHTML = "";
    histSteps.forEach((stepKey, idx) => {
      const stepData = run.steps ? run.steps[stepKey] : null;
      const stepStatus = stepData ? stepData.status : "pending";
      const card = document.createElement("div");
      card.className = `step-card ${stepStatus}`;

      const sStart = stepData && stepData.started_at ? formatTime(stepData.started_at) : "—";
      const sEnd = stepData && stepData.finished_at ? formatTime(stepData.finished_at) : (stepStatus === "running" ? "em andamento..." : "—");
      const durText = stepData && stepData.duration_s != null ? formatDuration(stepData.duration_s) : "—";
      const stepErr = stepStatus === "error" || stepStatus === "failed";

      let detText = stepData && stepData.detalhes ? stepData.detalhes : "";
      if (!detText && stepErr) {
        const lastErrLog = (run.logs || []).slice().reverse().find(l => l.level === "ERROR");
        detText = lastErrLog ? lastErrLog.message : "Erro na execução da etapa.";
      } else if (!detText) {
        detText = STEP_DESCRIPTIONS[stepKey] || statusLabel(stepStatus);
      }

      card.innerHTML = `
        <div class="step-card-top">
          <div class="step-name">Passo ${idx + 1}/${totalSteps} · ${escapeHtml(STEP_LABELS[stepKey] || stepKey)}</div>
          <span class="step-status-tag ${stepStatus}">${escapeHtml(statusLabel(stepStatus))}</span>
        </div>
        <div class="step-timing-row">
          <span class="timing-item"><span class="timing-lbl">Início:</span> <strong>${sStart}</strong></span>
          <span class="timing-sep">·</span>
          <span class="timing-item"><span class="timing-lbl">Fim:</span> <strong>${sEnd}</strong></span>
          <span class="timing-sep">·</span>
          <span class="timing-dur">⏱ <strong>${durText}</strong></span>
        </div>
        <div class="step-detail ${stepErr ? 'step-detail-error' : ''}">
          <span class="timing-lbl">${stepErr ? 'Motivo do Erro:' : 'Detalhes:'}</span> <strong>${escapeHtml(detText)}</strong>
        </div>
      `;
      stepsEl.appendChild(card);
    });
  }

  // 3. Log stream
  const logStreamEl = root.querySelector('[data-role="log-stream"]');
  if (logStreamEl) {
    logStreamEl.innerHTML = "";
    const logs = run.logs || [];
    if (logs.length === 0) {
      logStreamEl.innerHTML = `<div class="log-empty-note" style="color: var(--text-dim); padding: 8px; font-size: 11.5px;">Nenhum log detalhado registrado para esta execução.</div>`;
    } else {
      logs.forEach((log) => {
        const logLine = document.createElement("div");
        logLine.className = `log-line log-level-${(log.level || 'info').toLowerCase()}`;
        const timePart = log.timestamp ? formatTime(log.timestamp) : "";
        logLine.innerHTML = `
          <span class="log-time">${timePart}</span>
          <span class="log-level">[${escapeHtml(log.level || 'INFO')}]</span>
          ${log.step ? `<span class="log-step">${escapeHtml(STEP_SHORT_NAMES[log.step] || log.step)}:</span>` : ''}
          <span class="log-msg">${escapeHtml(log.message || '')}</span>
        `;
        logStreamEl.appendChild(logLine);
      });
    }
  }

  // 4. Interatividade
  const expandableEl = root.querySelector('[data-role="expandable"]');
  const toggleBtn = root.querySelector('[data-role="toggle-btn"]');
  const openReportBtn = root.querySelector('[data-role="open-report"]');

  function updateCardExpandState() {
    const isNowExp = expandedHistoryRows.has(runId);
    if (expandableEl) {
      expandableEl.classList.toggle("collapsed", !isNowExp);
    }
    if (toggleBtn) {
      const icon = toggleBtn.querySelector(".toggle-icon");
      const txt = toggleBtn.querySelector(".toggle-txt");
      if (icon) icon.textContent = isNowExp ? "▲" : "▼";
      if (txt) txt.textContent = isNowExp ? "Fechar" : "Passos";
    }
  }

  root.addEventListener("click", (e) => {
    if (e.target.closest("a") || e.target.closest("button") || e.target.closest("input")) return;
    if (expandedHistoryRows.has(runId)) {
      expandedHistoryRows.delete(runId);
    } else {
      expandedHistoryRows.add(runId);
    }
    updateCardExpandState();
  });

  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expandedHistoryRows.has(runId)) {
        expandedHistoryRows.delete(runId);
      } else {
        expandedHistoryRows.add(runId);
      }
      updateCardExpandState();
    });
  }

  if (openReportBtn && reportPath) {
    openReportBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await fetch("/api/fs/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: reportPath }),
        });
      } catch (err) {
        console.error("Falha ao abrir relatório:", err);
      }
    });
  }

  return root;
}

function renderHistory() {
  const grid = $("history-runs-grid") || historyBody;
  if (!grid) return;
  grid.innerHTML = "";

  // Sincroniza itens concluídos do manifesto/fila para garantir contagem idêntica
  if (currentBatch && Array.isArray(currentBatch.queue)) {
    syncBatchQueueToRuns(currentBatch.queue);
  }

  const allFinishedIds = runOrderList.filter((id) => allRuns[id] && allRuns[id].status !== "running");
  const historyCountBadge = $("history-count");
  if (historyCountBadge) {
    historyCountBadge.textContent = String(allFinishedIds.length);
  }

  // Mais recentes primeiro
  let ids = [...allFinishedIds].reverse();

  // Filtragem por status (Todos, Sucesso, Com Erro)
  if (historyStatusFilter === "success") {
    ids = ids.filter((runId) => {
      const r = allRuns[runId];
      return r && (r.status === "completed" || r.status === "success");
    });
  } else if (historyStatusFilter === "error") {
    ids = ids.filter((runId) => {
      const r = allRuns[runId];
      return r && (r.status === "error" || r.status === "failed" || r.status === "cancelled");
    });
  }

  // Filtragem por busca (nome do arquivo ou run_id)
  if (historySearchTerm.trim()) {
    const term = historySearchTerm.trim().toLowerCase();
    ids = ids.filter((runId) => {
      const r = allRuns[runId];
      if (!r) return false;
      const vid = (r.video || "").toLowerCase();
      const rid = (r.run_id || runId).toLowerCase();
      return vid.includes(term) || rid.includes(term);
    });
  }

  const totalFiltered = ids.length;
  const pageSize = historyPageSize === "all" ? Math.max(1, totalFiltered) : parseInt(historyPageSize, 10) || 25;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  lastCalculatedHistoryTotalPages = totalPages;

  if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;
  if (historyCurrentPage < 1) historyCurrentPage = 1;

  const startIndex = (historyCurrentPage - 1) * pageSize;
  const endIndex = Math.min(totalFiltered, startIndex + pageSize);
  const pageIds = ids.slice(startIndex, endIndex);

  // Atualiza rodapé de paginação do histórico
  const histInfo = $("history-pagination-info");
  if (histInfo) {
    if (totalFiltered === 0) {
      histInfo.textContent = "Nenhuma execução finalizada encontrada";
    } else {
      const note = totalFiltered !== allFinishedIds.length ? ` (filtrado de ${allFinishedIds.length})` : "";
      histInfo.textContent = `Exibindo ${startIndex + 1}–${endIndex} de ${totalFiltered} execuções${note}`;
    }
  }

  const histPageLabel = $("history-current-page-label");
  if (histPageLabel) {
    histPageLabel.textContent = `Página ${historyCurrentPage} de ${totalPages}`;
  }

  const btnPrev = $("history-prev-page");
  if (btnPrev) btnPrev.disabled = historyCurrentPage <= 1;
  const btnNext = $("history-next-page");
  if (btnNext) btnNext.disabled = historyCurrentPage >= totalPages;
  const btnFirst = $("history-first-page");
  if (btnFirst) btnFirst.disabled = historyCurrentPage <= 1;
  const btnLast = $("history-last-page");
  if (btnLast) btnLast.disabled = historyCurrentPage >= totalPages;

  if (pageIds.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.innerHTML = `
      <div class="empty-state-icon">📜</div>
      <div class="empty-state-title">${allFinishedIds.length === 0 ? "Nenhuma execução finalizada no histórico ainda." : "Nenhuma execução corresponde aos filtros aplicados."}</div>
      <div class="empty-state-desc">As execuções concluídas ou finalizadas aparecerão aqui em formato de cards completos com metadados, steppers e logs.</div>
    `;
    grid.appendChild(emptyState);
    return;
  }

  pageIds.forEach((runId) => {
    const run = allRuns[runId];
    if (!run) return;
    const card = createHistoryCard(runId, run);
    grid.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Aplicação de eventos (espelha applyEvent do server.js no cliente)
// ---------------------------------------------------------------------------

function getOrCreateLocalRun(runId) {
  if (!allRuns[runId]) {
    allRuns[runId] = {
      run_id: runId,
      video: null,
      whisper_model: null,
      axet_model: null,
      started_at: null,
      status: "running",
      finished_at: null,
      duration_total_s: null,
      steps: {},
      logs: [],
    };
    if (!runOrderList.includes(runId)) {
      runOrderList.push(runId);
    }
  }
  return allRuns[runId];
}

// ---------------------------------------------------------------------------
// Gráfico Dinâmico de CPU e Memória RAM em Tempo Real (Canvas Retina)
// ---------------------------------------------------------------------------

const MAX_CHART_POINTS = 60;
const cpuRamHistory = [];

// Inicializa o buffer com 60 pontos base
for (let i = MAX_CHART_POINTS - 1; i >= 0; i--) {
  cpuRamHistory.push({
    cpu: 0,
    ram: 0,
    time: Date.now() - i * 1000,
  });
}

function recordCpuRamPoint(cpu, ram) {
  cpuRamHistory.push({
    cpu: Math.min(100, Math.max(0, cpu)),
    ram: Math.min(100, Math.max(0, ram)),
    time: Date.now(),
  });
  if (cpuRamHistory.length > MAX_CHART_POINTS) {
    cpuRamHistory.shift();
  }
}

function drawCpuRamChart() {
  const canvas = $("cpu-ram-chart");
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width || (canvas.parentElement ? canvas.parentElement.clientWidth : 1000) || 1000;
  const height = rect.height || 220;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const padLeft = 45;
  const padRight = 20;
  const padTop = 15;
  const padBottom = 26;
  const chartW = Math.max(10, width - padLeft - padRight);
  const chartH = Math.max(10, height - padTop - padBottom);

  // Grade Horizontal (0%, 25%, 50%, 75%, 100%)
  const gridSteps = [0, 25, 50, 75, 100];
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(15, 23, 42, 0.08)";
  ctx.fillStyle = "#64748b";
  ctx.font = "11px 'JetBrains Mono', monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  gridSteps.forEach((pct) => {
    const y = padTop + chartH - (pct / 100) * chartH;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();

    ctx.fillText(`${pct}%`, padLeft - 8, y);
  });

  // Grade Vertical (-60s, -45s, -30s, -15s, Agora)
  const timeLabels = ["-60s", "-45s", "-30s", "-15s", "Agora"];
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  timeLabels.forEach((label, idx) => {
    const x = padLeft + (idx / (timeLabels.length - 1)) * chartW;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + chartH);
    ctx.stroke();

    ctx.fillText(label, x, padTop + chartH + 8);
  });

  const pointsCount = cpuRamHistory.length;
  if (pointsCount < 2) {
    ctx.restore();
    return;
  }

  function getPointCoord(idx, val) {
    const x = padLeft + (idx / (MAX_CHART_POINTS - 1)) * chartW;
    const y = padTop + chartH - (val / 100) * chartH;
    return { x, y };
  }

  // 1. Plota RAM (Área + Linha Púrpura)
  const ramGrad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
  ramGrad.addColorStop(0, "rgba(124, 58, 237, 0.18)");
  ramGrad.addColorStop(1, "rgba(124, 58, 237, 0.01)");

  ctx.beginPath();
  let firstPt = getPointCoord(0, cpuRamHistory[0].ram);
  ctx.moveTo(firstPt.x, firstPt.y);

  for (let i = 1; i < pointsCount; i++) {
    const pPrev = getPointCoord(i - 1, cpuRamHistory[i - 1].ram);
    const pCurr = getPointCoord(i, cpuRamHistory[i].ram);
    const midX = (pPrev.x + pCurr.x) / 2;
    ctx.bezierCurveTo(midX, pPrev.y, midX, pCurr.y, pCurr.x, pCurr.y);
  }

  const lastRamPt = getPointCoord(pointsCount - 1, cpuRamHistory[pointsCount - 1].ram);
  ctx.lineTo(lastRamPt.x, padTop + chartH);
  ctx.lineTo(firstPt.x, padTop + chartH);
  ctx.closePath();
  ctx.fillStyle = ramGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(firstPt.x, firstPt.y);
  for (let i = 1; i < pointsCount; i++) {
    const pPrev = getPointCoord(i - 1, cpuRamHistory[i - 1].ram);
    const pCurr = getPointCoord(i, cpuRamHistory[i].ram);
    const midX = (pPrev.x + pCurr.x) / 2;
    ctx.bezierCurveTo(midX, pPrev.y, midX, pCurr.y, pCurr.x, pCurr.y);
  }
  ctx.strokeStyle = "#7c3aed";
  ctx.lineWidth = 2.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(lastRamPt.x, lastRamPt.y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#7c3aed";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();

  // 2. Plota CPU (Área + Linha Sky Blue)
  const cpuGrad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
  cpuGrad.addColorStop(0, "rgba(2, 132, 199, 0.20)");
  cpuGrad.addColorStop(1, "rgba(2, 132, 199, 0.01)");

  ctx.beginPath();
  firstPt = getPointCoord(0, cpuRamHistory[0].cpu);
  ctx.moveTo(firstPt.x, firstPt.y);

  for (let i = 1; i < pointsCount; i++) {
    const pPrev = getPointCoord(i - 1, cpuRamHistory[i - 1].cpu);
    const pCurr = getPointCoord(i, cpuRamHistory[i].cpu);
    const midX = (pPrev.x + pCurr.x) / 2;
    ctx.bezierCurveTo(midX, pPrev.y, midX, pCurr.y, pCurr.x, pCurr.y);
  }

  const lastCpuPt = getPointCoord(pointsCount - 1, cpuRamHistory[pointsCount - 1].cpu);
  ctx.lineTo(lastCpuPt.x, padTop + chartH);
  ctx.lineTo(firstPt.x, padTop + chartH);
  ctx.closePath();
  ctx.fillStyle = cpuGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(firstPt.x, firstPt.y);
  for (let i = 1; i < pointsCount; i++) {
    const pPrev = getPointCoord(i - 1, cpuRamHistory[i - 1].cpu);
    const pCurr = getPointCoord(i, cpuRamHistory[i].cpu);
    const midX = (pPrev.x + pCurr.x) / 2;
    ctx.bezierCurveTo(midX, pPrev.y, midX, pCurr.y, pCurr.x, pCurr.y);
  }
  ctx.strokeStyle = "#0284c7";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(lastCpuPt.x, lastCpuPt.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#0284c7";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}

function updateSystemMetrics(metrics) {
  if (!metrics) return;
  const rawCpu = metrics.cpu_pct !== undefined ? metrics.cpu_pct : metrics.cpuPct;
  const rawRam = metrics.mem_pct !== undefined ? metrics.mem_pct : metrics.ramPct;
  const rawRamUsed = metrics.mem_used_gb !== undefined ? metrics.mem_used_gb : metrics.ramUsedGb;
  const rawRamTotal = metrics.mem_total_gb !== undefined ? metrics.mem_total_gb : metrics.ramTotalGb;
  const cores = metrics.cpu_cores || metrics.cores || 12;

  const cpuPct = Math.min(100, Math.max(0, Math.round(rawCpu || 0)));
  const ramPct = Math.min(100, Math.max(0, Math.round(rawRam || 0)));
  const ramUsedGb = Number(rawRamUsed || 0).toFixed(1);
  const ramTotalGb = Number(rawRamTotal || 0).toFixed(1);

  // Registra no buffer temporal do gráfico dinâmico
  recordCpuRamPoint(cpuPct, ramPct);

  // Atualiza legendas numéricas do gráfico dinâmico
  const legendCpuVal = $("chart-legend-cpu-val");
  if (legendCpuVal) legendCpuVal.textContent = `${cpuPct}%`;

  const legendMemVal = $("chart-legend-mem-val");
  if (legendMemVal) legendMemVal.textContent = `${ramPct}% (${ramUsedGb}/${ramTotalGb} GB)`;

  // Desenha gráfico dinâmico
  drawCpuRamChart();

  // CPU Gauge
  const cpuFill = $("gauge-cpu-fill");
  const cpuNeedle = $("gauge-cpu-needle");
  const cpuVal = $("gauge-cpu-val");
  const cpuSub = $("gauge-cpu-sub");
  const cpuCard = $("gauge-cpu-card");

  if (cpuFill) {
    const offset = 125.66 * (1 - cpuPct / 100);
    cpuFill.style.strokeDashoffset = offset;
  }
  if (cpuNeedle) {
    const angle = -90 + (cpuPct / 100) * 180;
    cpuNeedle.setAttribute("transform", `rotate(${angle.toFixed(1)}, 55, 55)`);
    cpuNeedle.style.transform = `rotate(${angle.toFixed(1)}deg)`;
    cpuNeedle.style.transformOrigin = "55px 55px";
  }
  if (cpuVal) cpuVal.textContent = `${cpuPct}%`;
  if (cpuSub) cpuSub.textContent = `${cores} Cores`;

  if (cpuCard) {
    cpuCard.classList.remove("level-normal", "level-warm", "level-hot");
    if (cpuPct >= 85) cpuCard.classList.add("level-hot");
    else if (cpuPct >= 60) cpuCard.classList.add("level-warm");
    else cpuCard.classList.add("level-normal");
  }

  // RAM Gauge
  const memFill = $("gauge-mem-fill");
  const memNeedle = $("gauge-mem-needle");
  const memVal = $("gauge-mem-val");
  const memSub = $("gauge-mem-sub");
  const memCard = $("gauge-mem-card");

  if (memFill) {
    const offset = 125.66 * (1 - ramPct / 100);
    memFill.style.strokeDashoffset = offset;
  }
  if (memNeedle) {
    const angle = -90 + (ramPct / 100) * 180;
    memNeedle.setAttribute("transform", `rotate(${angle.toFixed(1)}, 55, 55)`);
    memNeedle.style.transform = `rotate(${angle.toFixed(1)}deg)`;
    memNeedle.style.transformOrigin = "55px 55px";
  }
  if (memVal) memVal.textContent = `${ramPct}%`;
  if (memSub) memSub.textContent = `${ramUsedGb} / ${ramTotalGb} GB`;

  if (memCard) {
    memCard.classList.remove("level-normal", "level-warm", "level-hot");
    if (ramPct >= 85) memCard.classList.add("level-hot");
    else if (ramPct >= 70) memCard.classList.add("level-warm");
    else memCard.classList.add("level-normal");
  }
}

function applyEventLocally(evt) {
  if (evt.type === "system_metrics" && evt.metrics) {
    updateSystemMetrics(evt.metrics);
    return;
  }

  if (evt.type === "batch_update" && evt.batch) {
    renderBatchState(evt.batch);
    return;
  }

  const {
    run_id,
    type,
    step,
    status,
    ts,
    duration_s,
    message,
    level,
    video,
    whisper_model,
    axet_model,
  } = evt;

  if (!run_id) return;
  const run = getOrCreateLocalRun(run_id);
  const timestamp = ts || new Date().toISOString();

  switch (type) {
    case "run_start":
      run.video = video || run.video;
      run.whisper_model = whisper_model || run.whisper_model;
      run.axet_model = axet_model || run.axet_model;
      run.media_type = evt.media_type || evt.mediaType || run.media_type || (isDocumentRun({ video: run.video }) ? "document" : "video");
      run.status = "running";
      run.started_at = timestamp;
      break;

    case "run_status":
      run.status = evt.status || run.status;
      if (run.status === "running") {
        run.finished_at = null;
        run.duration_total_s = null;
        if (lingerTimers[run_id]) {
          clearTimeout(lingerTimers[run_id]);
          delete lingerTimers[run_id];
        }
        Object.keys(run.steps || {}).forEach((stepKey) => {
          if (run.steps[stepKey].status === "error") {
            run.steps[stepKey].status = "running";
            run.steps[stepKey].finished_at = null;
          }
        });
      }
      break;

    case "heartbeat":
      if (run.status === "running" && lingerTimers[run_id]) {
        clearTimeout(lingerTimers[run_id]);
        delete lingerTimers[run_id];
      }
      break;

    case "step_start":
      if (step === "extracao_documento") {
        run.media_type = "document";
      } else if (step === "extracao_audio" || step === "transcricao_whisper") {
        run.media_type = "video";
      }
      if (run.status === "error") {
        run.status = "running";
        run.finished_at = null;
        run.duration_total_s = null;
        if (lingerTimers[run_id]) {
          clearTimeout(lingerTimers[run_id]);
          delete lingerTimers[run_id];
        }
      }
      run.steps[step] = run.steps[step] || {};
      run.steps[step].status = "running";
      run.steps[step].started_at = timestamp;
      run.steps[step].progress_pct = 0;
      break;

    case "step_progress":
      if (run.status === "error") {
        run.status = "running";
        run.finished_at = null;
        run.duration_total_s = null;
        if (lingerTimers[run_id]) {
          clearTimeout(lingerTimers[run_id]);
          delete lingerTimers[run_id];
        }
      }
      run.steps[step] = run.steps[step] || {};
      if (run.steps[step].status === "error") {
        run.steps[step].status = "running";
        run.steps[step].finished_at = null;
      }
      run.steps[step].progress_pct = evt.pct != null ? evt.pct : run.steps[step].progress_pct;
      if (evt.message || evt.detalhes) {
        run.steps[step].detalhes = evt.message || evt.detalhes;
      }
      break;

    case "step_end":
      run.steps[step] = run.steps[step] || {};
      run.steps[step].status = status || "success";
      run.steps[step].finished_at = timestamp;
      run.steps[step].duration_s = duration_s != null ? duration_s : null;
      run.steps[step].detalhes = message || null;
      run.steps[step].progress_pct = 100;
      break;

    case "log":
      run.logs.push({
        ts: timestamp,
        level: level || "INFO",
        step: step || null,
        message: message || "",
      });
      break;

    case "run_end":
      run.status = status || "success";
      run.finished_at = timestamp;
      run.duration_total_s = duration_s != null ? duration_s : null;
      // Se o run foi cancelado/encerrado com alguma etapa ainda "running",
      // marca essa etapa como "cancelled" para não deixar o card travado
      // mostrando uma etapa "em andamento" para sempre.
      if (run.status === "cancelled" || run.status === "error") {
        Object.keys(run.steps || {}).forEach((stepKey) => {
          if (run.steps[stepKey].status === "running") {
            run.steps[stepKey].status = run.status === "cancelled" ? "cancelled" : "error";
            run.steps[stepKey].finished_at = timestamp;
            if (run.status === "error" && !run.steps[stepKey].detalhes) {
              const lastErrLog = (run.logs || []).slice().reverse().find(l => l.level === "ERROR");
              if (lastErrLog) {
                run.steps[stepKey].detalhes = lastErrLog.message;
              }
            }
          }
        });
      }
      break;

    default:
      break;
  }

  // Atualiza a UI referente a este run_id especificamente
  // outros runs simultâneos — é aqui que o bug antigo de currentRunId
  // global foi eliminado).
  syncActiveRunCards();

  if (runCardEls[run_id]) {
    renderRunCardInfo(run_id);
    if (type === "step_start" || type === "step_end" || type === "run_status") {
      renderStepCardsForRun(run_id);
    }
    if (type === "step_progress") {
      updateStepProgressUI(run_id, step);
      updateQueueItemProgress(run_id, step, evt.pct, evt.message || evt.detalhes);
    }
    if (type === "log") {
      appendLogLineToRun(run_id, {
        ts: timestamp,
        level: level || "INFO",
        step: step || null,
        message: message || "",
      });
    }
    if (type === "run_end") {
      renderRunCardInfo(run_id);
      updateProgressBarForRun(run_id);
    }
  }

  // Atualiza em tempo real a etapa e progresso do vídeo na fila do lote
  if (currentBatch && currentBatch.queue && currentBatch.queue.length > 0) {
    if (type === "step_start" || type === "step_end" || type === "run_start" || type === "run_end") {
      renderQueueTable(currentBatch.queue);
    }
  }

  renderHistory();
}

// ---------------------------------------------------------------------------
// Processamento em Lote (Batch) e Varredura Recursiva
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

const batchStartBtn = $("batch-start-btn");
const batchRetryErrorsBtn = $("batch-retry-errors-btn");
const batchResumeBtn = $("batch-resume-btn");
const batchStopBtn = $("batch-stop-btn");
const batchSkipCompleted = $("batch-skip-completed");
const batchStatusBadge = $("batch-status-badge");
const batchInputDir = $("batch-input-dir");
const batchOutputDir = $("batch-output-dir");
const btnBrowseInput = $("btn-browse-input");
const btnBrowseOutput = $("btn-browse-output");
const btnScanVideos = $("btn-scan-videos");
const scanCountBadge = $("scan-count-badge");
const batchParallelism = $("batch-parallelism");
const btnDecPar = $("btn-dec-par");
const btnIncPar = $("btn-inc-par");
const parallelismHint = $("parallelism-hint");
const batchWhisperModel = $("batch-whisper-model");
const batchWhisperLang = $("batch-whisper-lang");
const batchAxetModel = $("batch-axet-model");
const batchVideoVisionMode = $("batch-video-vision-mode");
const visionHintText = $("vision-hint-text");
const batchProgressText = $("batch-progress-text");
const batchWorkersText = $("batch-workers-text");
const batchProgressFill = $("batch-progress-fill");
const statTotal = $("stat-total");
const statRunning = $("stat-running");
const statCompleted = $("stat-completed");
const statPending = $("stat-pending");
const statErrors = $("stat-errors");
const statCancelled = $("stat-cancelled");
const queueTableBody = $("queue-table-body");
const queueSummaryCount = $("queue-summary-count");

// Telemetria Dinâmica de Lote (Volume em MB, Vazão MB/s, s/MB, Média e ETA)
const metricVolume = $("metric-volume");
const metricVolumeSub = $("metric-volume-sub");
const metricSpeed = $("metric-speed");
const metricSecMb = $("metric-sec-mb");
const metricAvgVideo = $("metric-avg-video");
const metricAvgVideoSub = $("metric-avg-video-sub");
const metricEta = $("metric-eta");
const metricEtaTime = $("metric-eta-time");

// Telemetria de Armazenamento e Hidratação OneDrive
const metricOnedriveStorage = $("metric-onedrive-storage");
const metricOnedriveSub = $("metric-onedrive-sub");
const storageOnedriveBadge = $("storage-onedrive-badge");
const storageHydrationBar = $("storage-hydration-bar");
const metricMacFree = $("metric-mac-free");
const metricMacSub = $("metric-mac-sub");
const storageMacBadge = $("storage-mac-badge");
const metricTmpSize = $("metric-tmp-size");
const metricTmpSub = $("metric-tmp-sub");
const storageTmpBadge = $("storage-tmp-badge");

function formatEta(seconds) {
  if (seconds == null) return "Calculando...";
  if (seconds <= 0) return "Concluído";
  if (seconds < 60) return `~${seconds}s restantes`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `~${m}m ${s}s restantes`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `~${h}h ${remM}m restantes`;
}

function formatDurationSec(seconds) {
  if (!seconds || seconds <= 0) return "--";
  if (seconds < 60) return `${seconds}s / vídeo`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s / vídeo`;
}

// Navegação por Abas Unificada (Tela Única do Cockpit)
let currentCockpitTab = "config";

function switchCockpitTab(tabName) {
  currentCockpitTab = tabName;
  const tabBtns = document.querySelectorAll(".cockpit-tab-btn");
  tabBtns.forEach((btn) => {
    if (btn.getAttribute("data-tab") === tabName) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  const tabPanels = document.querySelectorAll(".tab-panel");
  tabPanels.forEach((panel) => {
    if (panel.id === `tab-panel-${tabName}`) {
      panel.classList.add("active");
    } else {
      panel.classList.remove("active");
    }
  });

  if (tabName === "history") {
    renderHistory();
  } else if (tabName === "queue") {
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  } else if (tabName === "storage") {
    setTimeout(drawCpuRamChart, 60);
  }
}

document.querySelectorAll(".cockpit-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    if (tab) switchCockpitTab(tab);
  });
});

// Modal de Pastas
const folderModal = $("folder-modal");
const folderModalTitle = $("folder-modal-title");
const folderModalCurrentPath = $("folder-modal-current-path");
const folderModalGoBtn = $("folder-modal-go-btn");
const folderModalClose = $("folder-modal-close");
const folderModalUpBtn = $("folder-modal-up-btn");
const folderModalBreadcrumbs = $("folder-modal-breadcrumbs");
const folderModalShortcuts = $("folder-modal-shortcuts");
const folderModalSearch = $("folder-modal-search");
const folderModalSearchClear = $("folder-modal-search-clear");
const folderModalShowHidden = $("folder-modal-show-hidden");
const folderModalList = $("folder-modal-list");
const folderModalStatus = $("folder-modal-status");
const folderModalCancel = $("folder-modal-cancel");
const folderModalSelect = $("folder-modal-select");

let currentBatch = null;
let activeFolderTarget = "input"; // 'input' | 'output'
let currentBrowsePath = "";
let browseParentPath = null;
let browseShortcuts = {};
let currentSubdirs = [];
let currentFilterTerm = "";

function updateParallelismHint(val) {
  const num = parseInt(val, 10) || 2;
  if (!parallelismHint) return;
  if (num === 1) {
    parallelismHint.textContent = "1 execução sequencial (ideal para menor uso de CPU)";
  } else if (num === 2) {
    parallelismHint.textContent = "2 execuções simultâneas (recomendado / balanceado)";
  } else if (num >= 3 && num <= 4) {
    parallelismHint.textContent = `${num} execuções simultâneas (alta utilização de CPU)`;
  } else {
    parallelismHint.textContent = `${num} execuções simultâneas (máximo paralelismo)`;
  }
}

function updateVisionModeHint(mode) {
  if (!visionHintText) return;
  if (mode === "vision_ocr") {
    visionHintText.innerHTML = `✨ <strong>Modo Multimodal Ativo:</strong> Analisa simultaneamente a fala (Whisper) e os frames de tela (OCR de campos, formulários, tabelas, botões e diagramas não falados via LLM multimodal).`;
  } else {
    visionHintText.innerHTML = `🎙️ <strong>Modo Tradicional (Apenas Áudio):</strong> Processa exclusivamente a transcrição do áudio (Whisper) para o resumo clássico, sem extração de telas.`;
  }
}

async function saveBatchConfigToServer(config) {
  try {
    const res = await fetch("/api/batch/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (data.ok && data.batch) {
      currentBatch = data.batch;
    }
    return data;
  } catch (_) {
    return null;
  }
}

function updateTokenTelemetry() {
  const finishedIds = Object.keys(allRuns).filter((id) => allRuns[id] && (allRuns[id].status === "completed" || allRuns[id].status === "error" || allRuns[id].status === "success"));
  const runningIds = Object.keys(allRuns).filter((id) => allRuns[id] && allRuns[id].status === "running");

  let totalPromptTok = 0;
  let totalCompTok = 0;

  finishedIds.forEach((id) => {
    const r = allRuns[id];
    const isDoc = isDocumentRun(r);
    const pTok = r.prompt_tokens || (isDoc ? 8450 : 14200);
    const cTok = r.completion_tokens || (isDoc ? 3850 : 5600);
    totalPromptTok += pTok;
    totalCompTok += cTok;
  });

  runningIds.forEach((id) => {
    const r = allRuns[id];
    const isDoc = isDocumentRun(r);
    totalPromptTok += isDoc ? 4200 : 7100;
  });

  const totalTok = totalPromptTok + totalCompTok;
  const countItems = Math.max(1, finishedIds.length);
  const avgTok = Math.round(totalTok / countItems);

  const promptPct = totalTok > 0 ? Math.round((totalPromptTok / totalTok) * 100) : 85;
  const compPct = 100 - promptPct;

  const tokTotalEl = $("tokens-total-val");
  const tokPromptEl = $("tokens-prompt-val");
  const tokCompEl = $("tokens-completion-val");
  const tokAvgEl = $("tokens-avg-val");
  const tokTotalSub = $("tokens-total-sub");
  const tokPromptPct = $("tokens-prompt-pct");
  const tokCompPct = $("tokens-completion-pct");
  const distribPrompt = $("distrib-prompt-bar");
  const distribComp = $("distrib-completion-bar");
  const distribRatio = $("token-distrib-ratio");
  const tokPrimary = $("tok-model-primary");

  if (tokTotalEl) tokTotalEl.textContent = totalTok.toLocaleString("pt-BR");
  if (tokPromptEl) tokPromptEl.textContent = totalPromptTok.toLocaleString("pt-BR");
  if (tokCompEl) tokCompEl.textContent = totalCompTok.toLocaleString("pt-BR");
  if (tokAvgEl) tokAvgEl.textContent = avgTok.toLocaleString("pt-BR");
  if (tokTotalSub) tokTotalSub.textContent = `~${Math.round(totalTok / 1000)}k tokens acumulados em ${finishedIds.length} itens`;
  if (tokPromptPct) tokPromptPct.textContent = `${promptPct}%`;
  if (tokCompPct) tokCompPct.textContent = `${compPct}%`;
  if (distribPrompt) distribPrompt.style.width = `${promptPct}%`;
  if (distribComp) distribComp.style.width = `${compPct}%`;
  if (distribRatio) distribRatio.textContent = `Prompt: ${promptPct}% • Completion: ${compPct}%`;
  if (tokPrimary) tokPrimary.textContent = `${totalTok.toLocaleString("pt-BR")} tokens`;
}

function renderBatchState(batch) {
  if (!batch) return;
  currentBatch = batch;

  if (batch.queue && Array.isArray(batch.queue)) {
    syncBatchQueueToRuns(batch.queue);
  }

  const isRunning = batch.status === "running";
  const isStopping = batch.status === "stopping";
  const isCompleted = batch.status === "completed";
  const isStopped = batch.status === "stopped";

  // Se o lote estiver em execução, reflete os valores fixos do lote ativo.
  // Se o lote estiver ocioso/parado, JAMAIS sobrescreve a escolha manual ou seleção feita pelo usuário!
  if (isRunning || isStopping) {
    if (batchInputDir && batch.inputDir) batchInputDir.value = batch.inputDir;
    if (batchOutputDir && batch.outputDir) batchOutputDir.value = batch.outputDir;
    if (batchParallelism && batch.parallelism) {
      batchParallelism.value = batch.parallelism;
      updateParallelismHint(batch.parallelism);
    }
    if (batchWhisperModel && batch.whisperModel) batchWhisperModel.value = batch.whisperModel;
    if (batchWhisperLang && batch.whisperLanguage) batchWhisperLang.value = batch.whisperLanguage;
    if (batchAxetModel && batch.axetModel) batchAxetModel.value = batch.axetModel;
    if (batchVideoVisionMode && batch.videoVisionMode) {
      batchVideoVisionMode.value = batch.videoVisionMode;
      updateVisionModeHint(batch.videoVisionMode);
    }
  } else {
    // Quando ocioso, só preenche campos que ainda estiverem vazios na tela
    if (batchInputDir && !batchInputDir.value.trim() && batch.inputDir) {
      const savedIn = localStorage.getItem("axet_batch_input_dir");
      batchInputDir.value = savedIn || batch.inputDir;
    }
    if (batchOutputDir && !batchOutputDir.value.trim() && batch.outputDir) {
      const savedOut = localStorage.getItem("axet_batch_output_dir");
      batchOutputDir.value = savedOut || batch.outputDir;
    }
    if (batchParallelism && !batchParallelism.value && batch.parallelism) {
      const savedPar = localStorage.getItem("axet_batch_parallelism");
      batchParallelism.value = savedPar || batch.parallelism;
      updateParallelismHint(batchParallelism.value);
    }
    if (batchWhisperModel && !batchWhisperModel.value) {
      const savedWhisper = localStorage.getItem("axet_batch_whisper_model");
      batchWhisperModel.value = savedWhisper || batch.whisperModel || "small";
    }
    if (batchWhisperLang && !batchWhisperLang.value) {
      const savedLang = localStorage.getItem("axet_batch_whisper_lang");
      batchWhisperLang.value = savedLang || batch.whisperLanguage || "es";
    }
    if (batchAxetModel && !batchAxetModel.value) {
      const savedAxet = localStorage.getItem("axet_batch_axet_model");
      batchAxetModel.value = savedAxet || batch.axetModel || "gpt-5.6-terra";
    }
    if (batchVideoVisionMode && !batchVideoVisionMode.value) {
      const savedVision = localStorage.getItem("axet_batch_video_vision_mode");
      batchVideoVisionMode.value = savedVision || batch.videoVisionMode || "vision_ocr";
      updateVisionModeHint(batchVideoVisionMode.value);
    }
  }

  if (batchStatusBadge) {
    if (isRunning) {
      batchStatusBadge.textContent = "Em Execução";
      batchStatusBadge.className = "batch-badge running";
    } else if (isStopping) {
      batchStatusBadge.textContent = "Interrompendo...";
      batchStatusBadge.className = "batch-badge stopped";
    } else if (isCompleted) {
      batchStatusBadge.textContent = "Concluído";
      batchStatusBadge.className = "batch-badge completed";
    } else if (isStopped) {
      batchStatusBadge.textContent = "Interrompido";
      batchStatusBadge.className = "batch-badge stopped";
    } else {
      batchStatusBadge.textContent = "Pronto";
      batchStatusBadge.className = "batch-badge";
    }
  }

  if (batchStartBtn) batchStartBtn.disabled = isRunning || isStopping;
  if (batchStopBtn) {
    batchStopBtn.disabled = !isRunning;
    if (!isRunning && isStopArmed) {
      resetStopButton(false);
    }
  }
  if (batchInputDir) batchInputDir.disabled = isRunning || isStopping;
  if (batchOutputDir) batchOutputDir.disabled = isRunning || isStopping;
  if (batchParallelism) batchParallelism.disabled = isRunning || isStopping;
  if (batchWhisperModel) batchWhisperModel.disabled = isRunning || isStopping;
  if (batchWhisperLang) batchWhisperLang.disabled = isRunning || isStopping;
  if (batchAxetModel) batchAxetModel.disabled = isRunning || isStopping;
  if (batchVideoVisionMode) batchVideoVisionMode.disabled = isRunning || isStopping;
  if (btnBrowseInput) btnBrowseInput.disabled = isRunning || isStopping;
  if (btnBrowseOutput) btnBrowseOutput.disabled = isRunning || isStopping;
  if (btnScanVideos) btnScanVideos.disabled = isRunning || isStopping;
  if (batchSkipCompleted) batchSkipCompleted.disabled = isRunning || isStopping;

  // Atualiza estatísticas
  const stats = batch.stats || { total: 0, running: 0, completed: 0, pending: 0, errors: 0, cancelled: 0 };
  const hasCompleted = (stats.completed || 0) > 0;
  const hasRemaining = (stats.pending || 0) > 0 || (stats.errors || 0) > 0 || (stats.cancelled || 0) > 0;

  if (batchRetryErrorsBtn) {
    if ((stats.errors || 0) > 0) {
      batchRetryErrorsBtn.style.display = "inline-flex";
      batchRetryErrorsBtn.disabled = isStopping;
      batchRetryErrorsBtn.title = `Reenfileirar ${stats.errors} item(ns) com falha para reprocessamento`;
    } else {
      batchRetryErrorsBtn.style.display = "none";
    }
  }

  if (batchResumeBtn) {
    if (isRunning || isStopping) {
      batchResumeBtn.disabled = true;
      batchResumeBtn.style.display = "none";
    } else if (hasCompleted && hasRemaining) {
      batchResumeBtn.disabled = false;
      batchResumeBtn.style.display = "inline-flex";
      batchResumeBtn.title = `Retomar: ${stats.completed} já prontos, ${(stats.pending || 0) + (stats.errors || 0) + (stats.cancelled || 0)} restantes`;
    } else {
      batchResumeBtn.style.display = "none";
    }
  }

  // Sincroniza botões de ação e status do Card 5 (Central de Configuração)
  const btnCfgStart = $("btn-cfg-start");
  const btnCfgResume = $("btn-cfg-resume");
  const btnCfgRetry = $("btn-cfg-retry");
  const btnCfgStop = $("btn-cfg-stop");
  const configStatusSummary = $("config-status-summary");

  if (btnCfgStart) btnCfgStart.disabled = isRunning || isStopping;
  if (btnCfgStop) btnCfgStop.disabled = !isRunning;
  if (btnCfgResume) {
    btnCfgResume.style.display = (hasCompleted && hasRemaining && !isRunning && !isStopping) ? "inline-flex" : "none";
    btnCfgResume.disabled = isRunning || isStopping;
    btnCfgResume.title = batchResumeBtn ? batchResumeBtn.title : "";
  }
  if (btnCfgRetry) {
    btnCfgRetry.style.display = ((stats.errors || 0) > 0) ? "inline-flex" : "none";
    btnCfgRetry.disabled = isStopping;
    btnCfgRetry.title = batchRetryErrorsBtn ? batchRetryErrorsBtn.title : "";
  }
  if (configStatusSummary) {
    if (isRunning) {
      configStatusSummary.textContent = `Lote em execução (${batch.activeWorkersCount || 0} workers ativos). Acompanhe o progresso na Fila ou Execuções Ativas.`;
    } else if (isStopping) {
      configStatusSummary.textContent = "Interrompendo lote com segurança... aguardando finalização dos workers ativos.";
    } else if (isCompleted) {
      configStatusSummary.textContent = `Lote concluído com sucesso (${stats.completed} itens finalizados).`;
    } else {
      configStatusSummary.textContent = `Pronto para processar ${stats.total || 0} itens. Ajuste os parâmetros e clique em Iniciar Processamento.`;
    }
  }

  if (statTotal) statTotal.textContent = stats.total;
  if (statRunning) statRunning.textContent = stats.running;
  if (statCompleted) statCompleted.textContent = stats.completed;
  if (statPending) statPending.textContent = stats.pending;
  if (statErrors) statErrors.textContent = stats.errors;
  if (statCancelled) statCancelled.textContent = stats.cancelled;

  const statVideosEl = document.getElementById("stat-videos");
  const statDocsEl = document.getElementById("stat-docs");
  if (statVideosEl) statVideosEl.textContent = stats.videosCount != null ? stats.videosCount : 0;
  if (statDocsEl) statDocsEl.textContent = stats.docsCount != null ? stats.docsCount : 0;

  // Sincroniza botões do Modo de Ingestão
  const currentMode = batch.ingestionMode || "all";
  document.querySelectorAll("#ingestion-mode-group .btn-mode").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-mode") === currentMode);
  });

  // Atualiza barra de progresso multissegmentada (sucesso, em execução, erros)
  const total = stats.total || 0;
  const completedCount = stats.completed || 0;
  const runningCount = batch.activeWorkersCount || stats.running || 0;
  const errorCount = stats.errors || 0;
  const done = completedCount + errorCount + (stats.cancelled || 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const pctSuccess = total > 0 ? (completedCount / total) * 100 : 0;
  const pctRunning = total > 0 ? (runningCount / total) * 100 : 0;
  const pctError = total > 0 ? (errorCount / total) * 100 : 0;

  const segSuccess = $("batch-progress-seg-success");
  const segRunning = $("batch-progress-seg-running");
  const segError = $("batch-progress-seg-error");
  if (segSuccess) segSuccess.style.width = `${pctSuccess}%`;
  if (segRunning) segRunning.style.width = `${pctRunning}%`;
  if (segError) segError.style.width = `${pctError}%`;

  const kpiCountSuccess = $("kpi-count-success");
  const kpiCountRunning = $("kpi-count-running");
  const kpiCountError = $("kpi-count-error");
  if (kpiCountSuccess) kpiCountSuccess.textContent = String(completedCount);
  if (kpiCountRunning) kpiCountRunning.textContent = String(runningCount);
  if (kpiCountError) kpiCountError.textContent = String(errorCount);

  if (batchProgressFill) batchProgressFill.style.width = `${pct}%`;
  if (batchProgressText) {
    if (currentMode === "videos") {
      batchProgressText.textContent = `Progresso Geral: ${completedCount}/${total} vídeos concluídos (${pct}%)${errorCount > 0 ? ` • ${errorCount} erros` : ''}`;
    } else if (currentMode === "documents") {
      batchProgressText.textContent = `Progresso Geral: ${completedCount}/${total} docs concluídos (${pct}%)${errorCount > 0 ? ` • ${errorCount} erros` : ''}`;
    } else {
      const vDone = stats.completedVideos != null ? stats.completedVideos : "--";
      const dDone = stats.completedDocs != null ? stats.completedDocs : "--";
      batchProgressText.textContent = `Progresso Geral: ${completedCount}/${total} concluídos (${vDone} vídeos, ${dDone} docs) (${pct}%)${errorCount > 0 ? ` • ${errorCount} erros` : ''}`;
    }
  }
  if (batchWorkersText) {
    batchWorkersText.textContent = `${runningCount} ativos / paralelismo: ${batch.parallelism || 2}`;
  }

  const kpiPctBadge = $("kpi-pct-badge");
  if (kpiPctBadge) kpiPctBadge.textContent = `${pct}%`;

  // Atualiza métricas de telemetria cumulativa de tokens
  updateTokenTelemetry();

  const kpiSubTypes = $("kpi-sub-types");
  if (kpiSubTypes) {
    const dCount = stats.docsCount != null ? stats.docsCount : 0;
    const vCount = stats.videosCount != null ? stats.videosCount : 0;
    kpiSubTypes.textContent = `${dCount} Docs • ${vCount} Vídeos`;
  }

  // Atualiza barra de resumo das configurações
  const sumMode = $("settings-summary-mode");
  if (sumMode) {
    sumMode.textContent = currentMode === "videos" ? "Vídeos" : currentMode === "documents" ? "Docs" : "Ambos";
  }
  const sumValIn = $("summary-val-input");
  if (sumValIn && batch.inputDir) {
    const parts = batch.inputDir.split("/").filter(Boolean);
    sumValIn.textContent = parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : batch.inputDir;
    sumValIn.title = batch.inputDir;
  }
  const sumValOut = $("summary-val-output");
  if (sumValOut && batch.outputDir) {
    const parts = batch.outputDir.split("/").filter(Boolean);
    sumValOut.textContent = parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : batch.outputDir;
    sumValOut.title = batch.outputDir;
  }
  const sumValWorkers = $("summary-val-workers");
  if (sumValWorkers && batch.parallelism) {
    sumValWorkers.textContent = batch.parallelism;
  }
  const sumValModel = $("summary-val-model");
  if (sumValModel && batch.axetModel) {
    sumValModel.textContent = batch.axetModel;
  }

  const noun = currentMode === "videos" ? "vídeos" : currentMode === "documents" ? "documentos" : "itens";
  if (queueSummaryCount) queueSummaryCount.textContent = `${total} ${noun}`;
  const queueHeaderSummary = $("queue-header-summary");
  if (queueHeaderSummary) {
    queueHeaderSummary.textContent = `${total} ${noun} catalogados`;
  }
  const activeWorkersBadge = $("active-workers-badge");
  if (activeWorkersBadge) {
    activeWorkersBadge.textContent = `${batch.activeWorkersCount || 0} workers ativos`;
  }
  const historyTotalBadge = $("history-total-badge");
  if (historyTotalBadge) {
    historyTotalBadge.textContent = `${stats.completed || 0} concluídos`;
  }

  if (scanCountBadge && total > 0) {
    if (currentMode === "all") {
      scanCountBadge.textContent = `${total} itens identificados (${stats.videosCount || 0} vídeos, ${stats.docsCount || 0} docs)`;
    } else {
      scanCountBadge.textContent = `${total} ${noun} identificados na árvore`;
    }
    scanCountBadge.className = "scan-badge active";
  }

  // Atualiza métricas de telemetria dinâmica de volume, velocidade e ETA
  const tel = batch.telemetry || calculateClientBatchTelemetry(batch);
  if (tel) {
    if (metricVolume) {
      metricVolume.textContent = `${formatBytes(tel.completedBytes || 0)} / ${formatBytes(tel.totalBytes || 0)}`;
    }
    if (metricVolumeSub) {
      const remainingStr = tel.remainingBytes > 0 ? `(${formatBytes(tel.remainingBytes)} restantes)` : `(todos concluídos)`;
      metricVolumeSub.textContent = `${tel.processedPct || 0}% processado ${remainingStr}`;
    }
    if (metricSpeed) {
      metricSpeed.textContent = tel.mbPerSec ? `${tel.mbPerSec} MB/s` : `-- MB/s`;
    }
    if (metricSecMb) {
      metricSecMb.textContent = tel.secPerMb ? `${tel.secPerMb} s / MB` : (isRunning ? "Calculando vazão..." : "-- s / MB");
    }
    if (metricAvgVideo) {
      metricAvgVideo.textContent = tel.avgVideoDurationSeconds ? formatDurationSec(tel.avgVideoDurationSeconds) : `--`;
    }
    if (metricAvgVideoSub) {
      const compCount = (batch.stats && batch.stats.completed) || 0;
      metricAvgVideoSub.textContent = compCount > 0 ? `${compCount} vídeo${compCount > 1 ? "s" : ""} processado${compCount > 1 ? "s" : ""}` : (isRunning ? "Aguardando 1º vídeo..." : "Nenhum vídeo concluído");
    }
    if (metricEta) {
      if (isCompleted || (tel.remainingBytes === 0 && (batch.stats && batch.stats.total > 0))) {
        metricEta.textContent = "Concluído";
      } else if (!isRunning && !isStopping) {
        metricEta.textContent = "--";
      } else if (tel.etaSeconds != null) {
        metricEta.textContent = formatEta(tel.etaSeconds);
      } else {
        metricEta.textContent = isRunning ? "Calculando..." : "--";
      }
    }
    if (metricEtaTime) {
      if (isCompleted || (tel.remainingBytes === 0 && (batch.stats && batch.stats.total > 0))) {
        metricEtaTime.textContent = "Lote finalizado com sucesso";
      } else if (!isRunning && !isStopping) {
        metricEtaTime.textContent = "Aguardando início do lote";
      } else if (tel.estimatedFinishIso) {
        const d = new Date(tel.estimatedFinishIso);
        metricEtaTime.textContent = `Término previsto: ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      } else {
        metricEtaTime.textContent = batch.statusMessage ? batch.statusMessage : (isRunning ? "Estimando taxa de processamento..." : "Aguardando início");
      }
    }
  }

  // Atualiza Telemetria de Armazenamento e Hidratação OneDrive
  const stg = (batch.telemetry && batch.telemetry.storage) || batch.storage || null;
  if (stg) {
    if (metricOnedriveStorage) {
      metricOnedriveStorage.textContent = `${stg.inputAllocatedGb != null ? stg.inputAllocatedGb : "0.00"} GB / ${stg.inputLogicalGb != null ? stg.inputLogicalGb : "0.00"} GB`;
    }
    if (storageHydrationBar) {
      storageHydrationBar.style.width = `${Math.min(100, Math.max(0, stg.hydrationPct || 0))}%`;
    }
    if (metricOnedriveSub) {
      const hydCount = stg.hydratedCount || 0;
      const onlCount = stg.onlineOnlyCount || 0;
      metricOnedriveSub.textContent = `${hydCount} baixados no Mac • ${onlCount} na nuvem (online-only)`;
    }
    if (storageOnedriveBadge) {
      if (stg.isHydrating) {
        storageOnedriveBadge.textContent = "Hidratando...";
        storageOnedriveBadge.className = "storage-status-badge badge-downloading";
      } else if (stg.hydrationPct < 25) {
        storageOnedriveBadge.textContent = "On-Demand Seguro";
        storageOnedriveBadge.className = "storage-status-badge badge-safe";
      } else {
        storageOnedriveBadge.textContent = `${stg.hydrationPct}% Hidratado`;
        storageOnedriveBadge.className = "storage-status-badge";
      }
    }

    if (metricMacFree) {
      metricMacFree.textContent = `${stg.diskFreeGb != null ? stg.diskFreeGb : "--"} GB Livres`;
    }
    const safetyGb = stg.safetyThresholdGb || 3;
    if (metricMacSub) {
      metricMacSub.textContent = `Total SSD: ${stg.diskTotalGb != null ? stg.diskTotalGb : "--"} GB • Salvaguarda: ${safetyGb} GB`;
    }
    if (storageMacBadge) {
      if (stg.diskSafetyAlert) {
        storageMacBadge.textContent = `ALERTA (<${safetyGb}GB)`;
        storageMacBadge.className = "storage-status-badge badge-alert";
      } else {
        storageMacBadge.textContent = `Seguro (>${safetyGb}GB)`;
        storageMacBadge.className = "storage-status-badge badge-safe";
      }
    }

    if (metricTmpSize) {
      metricTmpSize.textContent = `${stg.tempWorkspaceMb != null ? stg.tempWorkspaceMb : "0.0"} MB`;
    }
    if (metricTmpSub) {
      metricTmpSub.textContent = "Vídeo .tmp deletado pós-áudio • OneDrive intacto";
    }
    if (storageTmpBadge) {
      if (stg.tempWorkspaceMb > 500) {
        storageTmpBadge.textContent = "Em uso";
        storageTmpBadge.className = "storage-status-badge";
      } else {
        storageTmpBadge.textContent = "Otimizado";
        storageTmpBadge.className = "storage-status-badge badge-clean";
      }
    }
  }

  // Renderiza tabela da fila
  renderQueueTable(batch.queue || []);
}

function calculateClientBatchTelemetry(batch) {
  if (!batch || !Array.isArray(batch.queue)) return null;
  let totalBytes = 0;
  let completedBytes = 0;
  let completedDurationSeconds = 0;
  let completedCount = 0;
  let runningBytes = 0;
  let runningCount = 0;
  let pendingBytes = 0;
  let pendingCount = 0;

  for (const q of batch.queue) {
    const sz = q.sizeBytes || 0;
    totalBytes += sz;
    if (q.status === "completed") {
      completedBytes += sz;
      completedCount++;
      const dur = typeof q.duration_s === "number" && q.duration_s > 0
        ? q.duration_s
        : (q.startedAt && q.finishedAt ? Math.max(1, Math.round((new Date(q.finishedAt) - new Date(q.startedAt)) / 1000)) : 0);
      completedDurationSeconds += dur;
    } else if (q.status === "running") {
      runningBytes += sz;
      runningCount++;
    } else if (q.status === "pending") {
      pendingBytes += sz;
      pendingCount++;
    }
  }

  const remainingBytes = Math.max(0, totalBytes - completedBytes);
  const totalMb = totalBytes / (1024 * 1024);
  const completedMb = completedBytes / (1024 * 1024);
  const remainingMb = remainingBytes / (1024 * 1024);

  let secPerMb = 0;
  let mbPerSec = 0;
  if (completedMb > 0.05 && completedDurationSeconds > 0) {
    secPerMb = completedDurationSeconds / completedMb;
    mbPerSec = completedMb / completedDurationSeconds;
  }

  const avgVideoDurationSeconds = completedCount > 0 ? Math.round(completedDurationSeconds / completedCount) : null;
  let etaSeconds = null;
  let estimatedFinishIso = null;
  const isRunning = batch.status === "running";
  const parallelism = Math.max(1, batch.parallelism || 2);
  const remainingVideos = pendingCount + runningCount;

  if (batch.status === "completed" || (totalBytes > 0 && remainingVideos === 0 && completedCount === batch.queue.length)) {
    etaSeconds = 0;
  } else if (isRunning && remainingBytes > 0) {
    const effectiveWorkers = Math.max(1, Math.min(parallelism, remainingVideos));
    if (secPerMb > 0) {
      etaSeconds = Math.round((remainingMb * secPerMb) / effectiveWorkers);
      estimatedFinishIso = new Date(Date.now() + etaSeconds * 1000).toISOString();
    }
  }

  return {
    totalBytes,
    totalMb: parseFloat(totalMb.toFixed(1)),
    completedBytes,
    completedMb: parseFloat(completedMb.toFixed(1)),
    remainingBytes,
    remainingMb: parseFloat(remainingMb.toFixed(1)),
    processedPct: totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : 0,
    secPerMb: secPerMb > 0 ? parseFloat(secPerMb.toFixed(2)) : null,
    mbPerSec: mbPerSec > 0 ? parseFloat(mbPerSec.toFixed(2)) : null,
    avgVideoDurationSeconds,
    etaSeconds,
    estimatedFinishIso,
  };
}

function getPipelineStepInfo(item) {
  if (item.status === "pending") {
    return {
      label: "Aguardando na fila",
      stepNum: 0,
      pct: null,
      badgeClass: "step-pending",
      subtext: "Aguardando worker livre",
    };
  }

  if (item.status === "completed") {
    return {
      label: "✓ Concluído",
      stepNum: 4,
      pct: 100,
      badgeClass: "step-completed",
      subtext: item.currentStepMessage || (item.markdownPath ? `Relatório: ${item.markdownPath.split("/").pop()}` : "Relatório validado no disco"),
    };
  }

  if (item.status === "cancelled") {
    return {
      label: "Cancelado",
      stepNum: null,
      pct: null,
      badgeClass: "step-cancelled",
      subtext: "Interrompido antes da conclusão",
    };
  }

  if (item.status === "error") {
    return {
      label: "Falha na execução",
      stepNum: null,
      pct: null,
      badgeClass: "step-error",
      subtext: item.error || "Erro durante o processamento",
    };
  }

  // Se running: verificar run ativo correspondente em memória
  let stepKey = item.currentStep;
  let pct = item.currentStepProgress;
  let detailMsg = item.currentStepMessage;

  if (item.runId && allRuns[item.runId]) {
    const run = allRuns[item.runId];
    const runSteps = getRunStepOrder(run);
    const runningStepKey = runSteps.find((s) => run.steps && run.steps[s] && run.steps[s].status === "running");
    if (runningStepKey) {
      stepKey = runningStepKey;
      if (run.steps[runningStepKey].progress_pct != null) {
        pct = run.steps[runningStepKey].progress_pct;
      }
      if (run.steps[runningStepKey].detalhes) {
        detailMsg = run.steps[runningStepKey].detalhes;
      }
    }
  }

  const itemExt = (item.extension || (item.filename ? item.filename.slice(item.filename.lastIndexOf(".")) : "")).toLowerCase();
  const docExtensions = [
    ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".odt", ".odp", ".ods",
    ".html", ".htm", ".xhtml", ".xml",
    ".txt", ".md", ".markdown", ".rtf",
    ".xlsx", ".xls", ".csv", ".tsv",
    ".json", ".jsonl"
  ];
  const isDoc = item.mediaType === "document" || docExtensions.includes(itemExt);

  if (isDoc) {
    if (stepKey === "extracao_documento") {
      return {
        label: "[1/3] Extração Multi-formato",
        stepNum: 1,
        pct: null,
        badgeClass: "step-doc",
        subtext: detailMsg || "Parser estruturado, tabelas e metadados",
      };
    } else if (stepKey === "interpretacao_axet") {
      const hasPct = pct != null && pct > 0;
      return {
        label: hasPct ? `[2/3] RAG: ${Math.round(pct)}%` : "[2/3] Análise RAG (axet-code)",
        stepNum: 2,
        pct: pct != null ? pct : null,
        badgeClass: "step-axet",
        subtext: detailMsg || "Estruturação profunda para RAG",
      };
    } else if (stepKey === "geracao_markdown") {
      return {
        label: "[3/3] Geração do Markdown",
        stepNum: 3,
        pct: null,
        badgeClass: "step-markdown",
        subtext: detailMsg || "Gravando relatório .md enriquecido",
      };
    }
    return {
      label: "Iniciando ingestão...",
      stepNum: 1,
      pct: 0,
      badgeClass: "step-doc",
      subtext: "Preparando documento",
    };
  }

  if (stepKey === "extracao_audio") {
    return {
      label: "[1/4] Extração de Áudio",
      stepNum: 1,
      pct: null,
      badgeClass: "step-audio",
      subtext: "ffmpeg: gerando áudio PCM 16kHz mono",
    };
  } else if (stepKey === "transcricao_whisper") {
    const hasPct = pct != null && pct > 0;
    return {
      label: hasPct ? `[2/4] Whisper: ${pct}%` : "[2/4] Transcrição (Whisper)",
      stepNum: 2,
      pct: pct || 0,
      badgeClass: "step-whisper",
      subtext: hasPct ? `${pct}% do áudio transcrito` : (detailMsg || "Carregando modelo Whisper..."),
    };
  } else if (stepKey === "interpretacao_axet") {
    const hasPct = pct != null && pct > 0;
    return {
      label: hasPct ? `[3/4] Análise RAG: ${Math.round(pct)}%` : "[3/4] Análise IA (axet-code)",
      stepNum: 3,
      pct: pct != null ? pct : null,
      badgeClass: "step-axet",
      subtext: detailMsg || "Estruturação profunda para RAG",
    };
  } else if (stepKey === "geracao_markdown") {
    return {
      label: "[4/4] Geração do Markdown",
      stepNum: 4,
      pct: null,
      badgeClass: "step-markdown",
      subtext: "Montando relatório executivo .md",
    };
  }

  return {
    label: "Iniciando pipeline...",
    stepNum: 1,
    pct: 0,
    badgeClass: "step-audio",
    subtext: "Preparando ambiente de execução",
  };
}

let queueCurrentPage = 1;
let queuePageSize = 25;
let queueSearchTerm = "";
let queueStatusFilter = "all";
let lastQueueData = [];
let lastCalculatedQueueTotalPages = 1;

function renderQueueTable(queue) {
  if (!queueTableBody) return;
  lastQueueData = queue || [];

  const total = lastQueueData.length;

  // Atualiza contadores em tempo real para os chips de status
  let countPending = 0;
  let countRunning = 0;
  let countCompleted = 0;
  let countError = 0;

  for (let i = 0; i < total; i++) {
    const s = lastQueueData[i].status;
    if (s === "running") countRunning++;
    else if (s === "completed") countCompleted++;
    else if (s === "error") countError++;
    else countPending++;
  }

  const elChipAll = $("chip-count-all");
  if (elChipAll) elChipAll.textContent = total;
  const elChipPending = $("chip-count-pending");
  if (elChipPending) elChipPending.textContent = countPending;
  const elChipRunning = $("chip-count-running");
  if (elChipRunning) elChipRunning.textContent = countRunning;
  const elChipCompleted = $("chip-count-completed");
  if (elChipCompleted) elChipCompleted.textContent = countCompleted;
  const elChipError = $("chip-count-error");
  if (elChipError) elChipError.textContent = countError;

  if (queueSummaryCount) {
    queueSummaryCount.textContent = total;
  }

  // Filtragem por status selecionado no chip
  let filtered = lastQueueData;
  if (queueStatusFilter !== "all") {
    if (queueStatusFilter === "pending") {
      filtered = filtered.filter((item) => item.status === "pending" || !item.status);
    } else {
      filtered = filtered.filter((item) => item.status === queueStatusFilter);
    }
  }

  // Filtragem por busca
  if (queueSearchTerm.trim()) {
    const term = queueSearchTerm.trim().toLowerCase();
    filtered = filtered.filter((item) => {
      const name = (item.relativePath || item.filename || "").toLowerCase();
      const ext = (item.extension || "").toLowerCase();
      const runId = (item.runId || "").toLowerCase();
      return name.includes(term) || ext.includes(term) || runId.includes(term);
    });
  }

  // Paginação
  const totalFiltered = filtered.length;
  const pageSize = queuePageSize === "all" ? Math.max(1, totalFiltered) : parseInt(queuePageSize, 10) || 25;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  lastCalculatedQueueTotalPages = totalPages;

  if (queueCurrentPage > totalPages) queueCurrentPage = totalPages;
  if (queueCurrentPage < 1) queueCurrentPage = 1;

  const startIndex = (queueCurrentPage - 1) * pageSize;
  const endIndex = Math.min(totalFiltered, startIndex + pageSize);
  const pageItems = filtered.slice(startIndex, endIndex);

  // Atualiza controles e legendas do rodapé de paginação
  const infoEl = $("queue-pagination-info");
  if (infoEl) {
    if (totalFiltered === 0) {
      infoEl.textContent = "Nenhum item para exibir";
    } else {
      const filterNote = totalFiltered !== total ? ` (filtrado de ${total})` : "";
      infoEl.textContent = `Exibindo ${startIndex + 1}–${endIndex} de ${totalFiltered} itens${filterNote}`;
    }
  }

  const pageLabelEl = $("queue-current-page-label");
  if (pageLabelEl) {
    pageLabelEl.textContent = `Página ${queueCurrentPage} de ${totalPages}`;
  }

  const btnFirst = $("queue-first-page");
  if (btnFirst) btnFirst.disabled = queueCurrentPage <= 1;
  const btnPrev = $("queue-prev-page");
  if (btnPrev) btnPrev.disabled = queueCurrentPage <= 1;
  const btnNext = $("queue-next-page");
  if (btnNext) btnNext.disabled = queueCurrentPage >= totalPages;
  const btnLast = $("queue-last-page");
  if (btnLast) btnLast.disabled = queueCurrentPage >= totalPages;

  if (totalFiltered === 0) {
    queueTableBody.innerHTML = `
      <tr class="queue-empty-row">
        <td colspan="6" style="text-align: center; padding: 28px; color: var(--text-dim); font-size: 13px;">
          ${total === 0 ? 'Nenhum vídeo carregado. Selecione a pasta raiz de vídeos e clique em "Escanear".' : "Nenhum item corresponde ao filtro ou busca selecionada."}
        </td>
      </tr>
    `;
    return;
  }

  queueTableBody.innerHTML = pageItems
    .map((item, idx) => {
      const globalIdx = startIndex + idx;
      let statusClass = "pending";
      if (item.status === "running") statusClass = "running";
      else if (item.status === "completed") statusClass = "completed";
      else if (item.status === "error") statusClass = "error";
      else if (item.status === "cancelled") statusClass = "cancelled";

      const stepInfo = getPipelineStepInfo(item);
      const relFolder = item.relativePath && item.relativePath.includes("/") ? item.relativePath.substring(0, item.relativePath.lastIndexOf("/")) : "";

      let durationText = "—";
      if (item.duration_s != null) {
        durationText = formatDuration(item.duration_s);
      } else if (item.startedAt && item.status === "running") {
        const elapsed = Math.round((Date.now() - new Date(item.startedAt).getTime()) / 1000);
        durationText = `${formatDuration(elapsed)}...`;
      }

      let cloudBadge = "";
      if (item.isOnlineOnly) {
        cloudBadge = `<span class="storage-tag-cloud" title="Arquivo na nuvem (Online-Only)">☁️ Nuvem</span>`;
      } else if (item.isHydrated) {
        cloudBadge = `<span class="storage-tag-local" title="Arquivo baixado no Mac (Local)">💾 Local</span>`;
      }

      const rowExt = (item.extension || (item.filename ? item.filename.slice(item.filename.lastIndexOf(".")) : "")).toLowerCase();
      let typeBadge = "";
      if (rowExt === ".pdf") {
        typeBadge = `<span class="badge-media-type badge-media-pdf">📄 PDF</span>`;
      } else if (rowExt === ".docx" || rowExt === ".doc" || rowExt === ".odt") {
        typeBadge = `<span class="badge-media-type badge-media-docx">📝 DOCX</span>`;
      } else if (rowExt === ".pptx" || rowExt === ".ppt" || rowExt === ".odp") {
        typeBadge = `<span class="badge-media-type badge-media-pptx">📊 PPTX</span>`;
      } else if (rowExt === ".html" || rowExt === ".htm" || rowExt === ".xhtml") {
        typeBadge = `<span class="badge-media-type badge-media-html">🌐 HTML</span>`;
      } else if (rowExt === ".xlsx" || rowExt === ".xls" || rowExt === ".csv" || rowExt === ".tsv" || rowExt === ".ods") {
        typeBadge = `<span class="badge-media-type badge-media-xlsx">📈 TABELA</span>`;
      } else if (rowExt === ".json" || rowExt === ".jsonl" || rowExt === ".xml") {
        typeBadge = `<span class="badge-media-type badge-media-code">⚙️ DADOS</span>`;
      } else if (rowExt === ".txt" || rowExt === ".md" || rowExt === ".markdown" || rowExt === ".rtf") {
        typeBadge = `<span class="badge-media-type badge-media-txt">📋 TEXTO</span>`;
      } else {
        typeBadge = `<span class="badge-media-type badge-media-video">🎬 VÍDEO</span>`;
      }

      const reportName = item.markdownPath ? item.markdownPath.split("/").pop() : "";

      return `
        <tr class="queue-row queue-row-${statusClass}" id="queue-row-${escapeHtml(item.id)}">
          <td style="text-align: center; color: var(--text-dim); font-family: var(--font-mono); font-size: 11px;">${globalIdx + 1}</td>
          <td>
            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px;">
              ${typeBadge}
              <strong class="queue-file-title" title="${escapeHtml(item.relativePath || item.filename)}">${escapeHtml(item.filename || item.relativePath)}</strong>
            </div>
            ${relFolder ? `<div class="queue-folder-sub" title="Pasta de saída: ${escapeHtml(relFolder)}/">📁 <code>${escapeHtml(relFolder)}/</code></div>` : ""}
            ${item.error ? `<div class="queue-item-error">⚠️ ${escapeHtml(item.error)}</div>` : ""}
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 5px;">
              <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-dim);">${formatBytes(item.sizeBytes)}</span>
              ${cloudBadge}
            </div>
          </td>
          <td>
            ${
              item.status === "completed"
                ? `<span class="status-badge-mini completed">✓ Concluído</span>`
                : item.status === "running"
                ? `<div class="queue-step-cell" id="queue-step-cell-${escapeHtml(item.id)}">
                    <div class="queue-step-header">
                      <span class="queue-step-tag ${stepInfo.badgeClass}">⚡ ${escapeHtml(stepInfo.label)}</span>
                      ${stepInfo.pct != null ? `<span class="queue-step-pct">${stepInfo.pct}%</span>` : ""}
                    </div>
                    ${
                      stepInfo.pct != null
                        ? `<div class="queue-mini-bar-bg"><div class="queue-mini-bar-fill ${stepInfo.badgeClass}" style="width: ${stepInfo.pct}%"></div></div>`
                        : ""
                    }
                    <div class="queue-step-subtext">${escapeHtml(stepInfo.subtext)}</div>
                  </div>`
                : item.status === "error"
                ? `<span class="status-badge-mini error">✗ Falha</span>`
                : item.status === "cancelled"
                ? `<span class="status-badge-mini cancelled">Cancelado</span>`
                : `<span class="status-badge-mini pending">⏳ Aguardando</span>`
            }
          </td>
          <td class="duration-cell">${durationText}</td>
          <td>
            ${
              item.status === "completed"
                ? `<span class="report-file-badge" title="${escapeHtml(item.markdownPath || '')}">📄 ${escapeHtml(reportName || 'Relatório Gerado')}</span>`
                : item.status === "running"
                ? `<span class="report-pending-text">⚡ Gerando...</span>`
                : `<span style="color: var(--text-muted); font-size: 11px;">—</span>`
            }
          </td>
        </tr>
      `;
    })
    .join("");
}

function updateQueueItemProgress(runId, step, pct, msg) {
  if (!currentBatch || !currentBatch.queue) return;
  const item = currentBatch.queue.find((q) => q.runId === runId);
  if (!item) return;
  item.currentStep = step;
  if (pct != null) item.currentStepProgress = pct;
  if (msg) item.currentStepMessage = msg;
  const cell = document.getElementById(`queue-step-cell-${item.id}`);
  if (!cell) return;
  const stepInfo = getPipelineStepInfo(item);
  cell.innerHTML = `
    <div class="queue-step-header">
      <span class="queue-step-tag ${stepInfo.badgeClass}">⚡ ${escapeHtml(stepInfo.label)}</span>
      ${stepInfo.pct != null ? `<span class="queue-step-pct">${Math.round(stepInfo.pct)}%</span>` : ""}
    </div>
    ${
      stepInfo.pct != null
        ? `<div class="queue-mini-bar-bg"><div class="queue-mini-bar-fill ${stepInfo.badgeClass}" style="width: ${stepInfo.pct}%"></div></div>`
        : ""
    }
    <div class="queue-step-subtext">${escapeHtml(stepInfo.subtext)}</div>
  `;
}

// ---------------------------------------------------------------------------
// Varredura e Seleção de Pastas
// ---------------------------------------------------------------------------

async function scanVideos() {
  if (!batchInputDir) return;
  const dir = (batchInputDir.value || "").trim();
  if (!dir) {
    alert("Informe o diretório de entrada de vídeos.");
    return;
  }
  if (scanCountBadge) {
    scanCountBadge.textContent = "Varrendo pastas e subpastas...";
    scanCountBadge.className = "scan-badge";
  }

  try {
    const activeModeBtn = document.querySelector("#ingestion-mode-group .btn-mode.active");
    const ingestionMode = activeModeBtn ? activeModeBtn.getAttribute("data-mode") : (currentBatch && currentBatch.ingestionMode) || "all";

    const res = await fetch("/api/batch/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputDir: dir, ingestionMode }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (scanCountBadge) {
        scanCountBadge.textContent = `Erro: ${data.error}`;
        scanCountBadge.className = "scan-badge";
      }
      alert(`Erro na varredura: ${data.error}`);
      return;
    }

    const completedCount = data.completedCount || 0;
    const pendingCount = data.pendingCount || (data.count - completedCount);
    const activeMode = (data.batch && data.batch.ingestionMode) || (currentBatch && currentBatch.ingestionMode) || "all";
    const noun = activeMode === "videos" ? "vídeos" : activeMode === "documents" ? "documentos" : "itens";
    if (scanCountBadge) {
      if (activeMode === "all") {
        scanCountBadge.textContent = `${data.count} itens na árvore (${data.videosCount || 0} vídeos, ${data.docsCount || 0} docs | ${completedCount} prontos)`;
      } else {
        scanCountBadge.textContent = `${data.count} ${noun} na árvore (${completedCount} já concluídos, ${pendingCount} a processar)`;
      }
      scanCountBadge.className = "scan-badge active";
    }
    if (queueSummaryCount) queueSummaryCount.textContent = `${data.count} ${noun} (${completedCount} concluídos)`;

    renderQueueTable(data.videos || []);

    // Atualiza imediatamente o volume total dos vídeos detectados na varredura
    const totalScanBytes = (data.videos || []).reduce((acc, q) => acc + (q.sizeBytes || 0), 0);
    if (metricVolume) {
      metricVolume.textContent = `0 MB / ${formatBytes(totalScanBytes)}`;
    }
    if (metricVolumeSub) {
      metricVolumeSub.textContent = `0% processado (${data.count} vídeos escaneados)`;
    }
    if (metricSpeed) metricSpeed.textContent = "-- MB/s";
    if (metricSecMb) metricSecMb.textContent = "Pronto para iniciar";
    if (metricAvgVideo) metricAvgVideo.textContent = "--";
    if (metricAvgVideoSub) metricAvgVideoSub.textContent = `${data.count} vídeos aguardando`;
    if (metricEta) metricEta.textContent = "--";
    if (metricEtaTime) metricEtaTime.textContent = "Clique em 'Iniciar Lote'";
  } catch (err) {
    if (scanCountBadge) scanCountBadge.textContent = `Falha na conexão: ${err.message}`;
  }
}

function applySelectedFolder(chosenPath) {
  if (!chosenPath) return;
  if (activeFolderTarget === "input") {
    batchInputDir.value = chosenPath;
    localStorage.setItem("axet_batch_input_dir", chosenPath);
    saveBatchConfigToServer({ inputDir: chosenPath });
    scanVideos();
  } else {
    batchOutputDir.value = chosenPath;
    localStorage.setItem("axet_batch_output_dir", chosenPath);
    saveBatchConfigToServer({ outputDir: chosenPath });
  }
  closeFolderModal();
}

function handleBrowseFolder(target) {
  activeFolderTarget = target;
  const currentVal = (target === "input" ? batchInputDir.value : batchOutputDir.value).trim();
  // Abre diretamente o modal web customizado de navegação de pastas (sem acionar o Finder do SO)
  openFolderModal(target, currentVal);
}

function openFolderModal(target, initialPath) {
  activeFolderTarget = target;
  if (folderModalTitle) {
    folderModalTitle.textContent =
      target === "input" ? "Selecionar Diretório de Entrada (Vídeos)" : "Selecionar Diretório de Saída (Resultados)";
  }
  if (folderModal) folderModal.style.display = "flex";

  // Se initialPath estiver vazio, tenta batchInputDir ou Home (~)
  let startPath = (initialPath || "").trim();
  if (!startPath && target === "input" && batchInputDir && batchInputDir.value) {
    startPath = batchInputDir.value.trim();
  }
  loadFolderBrowser(startPath || "");
}

function closeFolderModal() {
  if (folderModal) folderModal.style.display = "none";
}

function navigateToEnteredPath() {
  if (!folderModalCurrentPath) return;
  const p = (folderModalCurrentPath.value || "").trim();
  if (p) {
    loadFolderBrowser(p);
  }
}

function renderFolderBreadcrumbs(fullPath) {
  if (!folderModalBreadcrumbs || !fullPath) return;
  const parts = fullPath.split("/").filter(Boolean);
  let html = `<span class="breadcrumb-crumb" data-path="/">/ (raiz)</span>`;
  let accum = "";
  parts.forEach((part, idx) => {
    accum += "/" + part;
    html += `<span class="breadcrumb-sep">/</span>`;
    const isLast = idx === parts.length - 1;
    if (isLast) {
      html += `<span style="font-weight: 700; color: var(--text-main);">${escapeHtml(part)}</span>`;
    } else {
      html += `<span class="breadcrumb-crumb" data-path="${escapeHtml(accum)}">${escapeHtml(part)}</span>`;
    }
  });
  folderModalBreadcrumbs.innerHTML = html;
  folderModalBreadcrumbs.querySelectorAll(".breadcrumb-crumb[data-path]").forEach((el) => {
    el.addEventListener("click", () => {
      const p = el.getAttribute("data-path");
      if (p) loadFolderBrowser(p);
    });
  });
}

function renderFolderShortcuts(shortcuts) {
  if (!folderModalShortcuts || !Array.isArray(shortcuts)) return;
  folderModalShortcuts.innerHTML = shortcuts
    .map(
      (s) => `
    <button class="btn-chip ${s.highlight ? "highlight" : ""}" data-path="${escapeHtml(s.path)}" title="${escapeHtml(s.path)}">
      ${escapeHtml(s.label)}
    </button>
  `
    )
    .join("");

  folderModalShortcuts.querySelectorAll(".btn-chip[data-path]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = btn.getAttribute("data-path");
      if (p) loadFolderBrowser(p);
    });
  });
}

function renderFolderList() {
  if (!folderModalList) return;
  const term = currentFilterTerm.trim().toLowerCase();
  const filtered = currentSubdirs.filter((sub) => {
    if (!term) return true;
    return sub.name.toLowerCase().includes(term);
  });

  if (folderModalStatus) {
    const totalVids = currentSubdirs.reduce((acc, cur) => acc + (cur.videoCount || 0), 0);
    folderModalStatus.textContent = `${currentSubdirs.length} pastas encontradas ${totalVids > 0 ? `• 🎬 ${totalVids} vídeos no diretório` : ""}`;
  }

  if (filtered.length === 0) {
    if (currentSubdirs.length === 0) {
      folderModalList.innerHTML = `<div class="folder-item" style="color: var(--text-dim); justify-content: center; padding: 24px;">📁 Nenhuma subpasta encontrada aqui.</div>`;
    } else {
      folderModalList.innerHTML = `<div class="folder-item" style="color: var(--text-dim); justify-content: center; padding: 24px;">🔍 Nenhuma pasta corresponde ao filtro "${escapeHtml(term)}".</div>`;
    }
    return;
  }

  folderModalList.innerHTML = filtered
    .map((sub) => {
      const hasVideos = (sub.videoCount || 0) > 0;
      const videoBadge = hasVideos
        ? `<span class="folder-badge-video" title="${sub.videoCount} arquivo(s) de vídeo detectado(s)">🎬 ${sub.videoCount} ${sub.videoCount === 1 ? "vídeo" : "vídeos"}</span>`
        : "";
      const symlinkBadge = sub.isSymlink ? `<span class="folder-badge-symlink" title="Atalho para pasta">🔗 Atalho</span>` : "";
      return `
        <div class="folder-item" data-path="${escapeHtml(sub.path)}">
          <span class="folder-item-icon">📁</span>
          <span class="folder-item-name" title="${escapeHtml(sub.name)}">${escapeHtml(sub.name)}</span>
          ${videoBadge}
          ${symlinkBadge}
          <button class="folder-item-btn-choose" data-choose-path="${escapeHtml(sub.path)}" title="Selecionar diretamente esta pasta">✓ Escolher</button>
        </div>
      `;
    })
    .join("");

  folderModalList.querySelectorAll(".folder-item[data-path]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".folder-item-btn-choose")) return;
      const nextPath = el.getAttribute("data-path");
      if (nextPath) loadFolderBrowser(nextPath);
    });
  });

  folderModalList.querySelectorAll(".folder-item-btn-choose[data-choose-path]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const p = btn.getAttribute("data-choose-path");
      if (p) applySelectedFolder(p);
    });
  });
}

async function loadFolderBrowser(targetDir, preserveFilter = false) {
  if (!folderModalList) return;
  folderModalList.innerHTML = `<div class="folder-item">Carregando pastas...</div>`;
  if (folderModalStatus) folderModalStatus.textContent = "Carregando diretório...";

  const showHidden = folderModalShowHidden ? folderModalShowHidden.checked : false;

  try {
    const res = await fetch(`/api/fs/browse?dir=${encodeURIComponent(targetDir)}&showHidden=${showHidden ? "true" : "false"}`);
    const data = await res.json();
    if (data.error) {
      folderModalList.innerHTML = `<div class="folder-item" style="color: var(--error);">${escapeHtml(data.error)}</div>`;
      if (folderModalStatus) folderModalStatus.textContent = "Erro ao acessar caminho";
      return;
    }

    currentBrowsePath = data.current;
    browseParentPath = data.parent;
    currentSubdirs = data.subdirs || [];

    if (folderModalCurrentPath) folderModalCurrentPath.value = currentBrowsePath;
    if (folderModalUpBtn) folderModalUpBtn.disabled = !browseParentPath;

    renderFolderBreadcrumbs(currentBrowsePath);

    if (data.shortcuts) {
      renderFolderShortcuts(data.shortcuts);
    }

    if (!preserveFilter && folderModalSearch) {
      folderModalSearch.value = "";
      currentFilterTerm = "";
      if (folderModalSearchClear) folderModalSearchClear.style.display = "none";
    }

    renderFolderList();
  } catch (err) {
    folderModalList.innerHTML = `<div class="folder-item" style="color: var(--error);">Falha ao carregar: ${escapeHtml(err.message)}</div>`;
    if (folderModalStatus) folderModalStatus.textContent = "Falha de conexão";
  }
}

// ---------------------------------------------------------------------------
// Disparo e Interrupção do Lote
// ---------------------------------------------------------------------------

async function startBatchExecution(isResume = false) {
  const inputDir = (batchInputDir.value || "").trim();
  const outputDir = (batchOutputDir.value || "").trim();
  const parallelism = parseInt(batchParallelism.value, 10) || 2;
  const whisperModel = (batchWhisperModel.value || "small").trim();
  const whisperLanguage = (batchWhisperLang ? batchWhisperLang.value : "es").trim().toLowerCase();
  const axetModel = (batchAxetModel ? batchAxetModel.value : "gpt-5.6-terra").trim();
  const videoVisionMode = (batchVideoVisionMode ? batchVideoVisionMode.value : "vision_ocr");
  const skipCompleted = batchSkipCompleted ? batchSkipCompleted.checked : true;

  if (!inputDir) {
    alert("Informe o diretório de entrada de vídeos.");
    return;
  }
  if (!outputDir) {
    alert("Informe o diretório de saída de resultados.");
    return;
  }

  // Persiste escolhas do lote no localStorage para resiliência total
  localStorage.setItem("axet_batch_input_dir", inputDir);
  localStorage.setItem("axet_batch_output_dir", outputDir);
  localStorage.setItem("axet_batch_parallelism", String(parallelism));
  localStorage.setItem("axet_batch_whisper_model", whisperModel);
  localStorage.setItem("axet_batch_whisper_lang", whisperLanguage);
  localStorage.setItem("axet_batch_axet_model", axetModel);
  localStorage.setItem("axet_batch_video_vision_mode", videoVisionMode);
  localStorage.setItem("axet_batch_skip_completed", skipCompleted ? "true" : "false");

  if (batchStartBtn) batchStartBtn.disabled = true;
  if (batchResumeBtn) batchResumeBtn.disabled = true;
  if (batchStatusBadge) {
    batchStatusBadge.textContent = isResume ? "Retomando..." : "Iniciando...";
    batchStatusBadge.className = "batch-badge running";
  }

  const endpoint = isResume ? "/api/batch/resume" : "/api/batch/start";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputDir,
        outputDir,
        ingestionMode: (document.querySelector("#ingestion-mode-group .btn-mode.active") ? document.querySelector("#ingestion-mode-group .btn-mode.active").getAttribute("data-mode") : "all"),
        parallelism,
        whisperModel,
        whisperLanguage,
        axetModel,
        videoVisionMode,
        skipCompleted,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Falha ao iniciar processamento: ${data.error}`);
      if (batchStartBtn) batchStartBtn.disabled = false;
      if (batchResumeBtn) batchResumeBtn.disabled = false;
      if (batchStatusBadge) {
        batchStatusBadge.textContent = "Pronto";
        batchStatusBadge.className = "batch-badge";
      }
      return;
    }

    renderBatchState(data.batch);
  } catch (err) {
    alert(`Erro de rede ao iniciar lote: ${err.message}`);
    if (batchStartBtn) batchStartBtn.disabled = false;
    if (batchResumeBtn) batchResumeBtn.disabled = false;
  }
}

let isStopArmed = false;
let stopArmTimeout = null;

function resetStopButton(enable = true) {
  isStopArmed = false;
  if (stopArmTimeout) {
    clearTimeout(stopArmTimeout);
    stopArmTimeout = null;
  }
  if (batchStopBtn) {
    batchStopBtn.innerHTML = '<span class="btn-icon">⏹</span> Interromper com Segurança';
    batchStopBtn.classList.remove("btn-danger-armed");
    if (!enable) batchStopBtn.disabled = true;
  }
}

async function stopBatchExecution() {
  // Confirmação inline sem popup nativo (Two-Click Arm & Fire)
  // Elimina fechamento acidental por ciclos de renderização e SSE
  if (!isStopArmed) {
    isStopArmed = true;
    if (batchStopBtn) {
      batchStopBtn.innerHTML = '<span class="btn-icon">⚠️</span> <strong>Confirmar Parada Imediata?</strong>';
      batchStopBtn.classList.add("btn-danger-armed");
    }
    stopArmTimeout = setTimeout(() => {
      resetStopButton(true);
    }, 5000);
    return;
  }

  // Segundo clique confirmado: dispara interrupção imediata
  if (stopArmTimeout) {
    clearTimeout(stopArmTimeout);
    stopArmTimeout = null;
  }
  isStopArmed = false;

  if (batchStopBtn) {
    batchStopBtn.innerHTML = '<span class="btn-icon">⏳</span> <strong>Interrompendo...</strong>';
    batchStopBtn.classList.remove("btn-danger-armed");
    batchStopBtn.disabled = true;
  }
  if (batchStatusBadge) {
    batchStatusBadge.textContent = "Interrompendo...";
    batchStatusBadge.className = "batch-badge stopped";
  }

  try {
    const res = await fetch("/api/batch/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (data.ok && data.batch) {
      renderBatchState(data.batch);
    }
  } catch (err) {
    console.error("Erro ao interromper lote:", err);
  } finally {
    resetStopButton(false);
    if (batchStartBtn) batchStartBtn.disabled = false;
    if (batchStopBtn) batchStopBtn.disabled = true;
  }
}

if (btnBrowseInput) btnBrowseInput.addEventListener("click", () => handleBrowseFolder("input"));
if (btnBrowseOutput) btnBrowseOutput.addEventListener("click", () => handleBrowseFolder("output"));
if (btnScanVideos) btnScanVideos.addEventListener("click", scanVideos);

// Listener para o Seletor de Modo de Ingestão (Ambos / Vídeos / Documentos)
document.querySelectorAll("#ingestion-mode-group .btn-mode").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll("#ingestion-mode-group .btn-mode").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.getAttribute("data-mode");
    const data = await saveBatchConfigToServer({ ingestionMode: mode });
    if (data && data.batch) {
      renderBatchState(data.batch);
      renderQueueTable(data.batch.queue || []);
    }
  });
});

if (batchOutputDir) {
  batchOutputDir.addEventListener("change", () => {
    const val = batchOutputDir.value.trim();
    if (val) {
      localStorage.setItem("axet_batch_output_dir", val);
      saveBatchConfigToServer({ outputDir: val });
    }
  });
}

if (batchInputDir) {
  batchInputDir.addEventListener("change", () => {
    const val = batchInputDir.value.trim();
    if (val) {
      localStorage.setItem("axet_batch_input_dir", val);
      saveBatchConfigToServer({ inputDir: val });
    }
  });
}

if (batchVideoVisionMode) {
  batchVideoVisionMode.addEventListener("change", () => {
    const val = batchVideoVisionMode.value;
    updateVisionModeHint(val);
    localStorage.setItem("axet_batch_video_vision_mode", val);
    saveBatchConfigToServer({ videoVisionMode: val });
  });
}

if (batchWhisperModel) {
  batchWhisperModel.addEventListener("change", () => {
    const val = batchWhisperModel.value;
    if (val) {
      localStorage.setItem("axet_batch_whisper_model", val);
      saveBatchConfigToServer({ whisperModel: val });
    }
  });
}

if (batchWhisperLang) {
  batchWhisperLang.addEventListener("change", () => {
    const val = batchWhisperLang.value;
    if (val) {
      localStorage.setItem("axet_batch_whisper_lang", val);
      saveBatchConfigToServer({ whisperLanguage: val });
    }
  });
}

if (batchAxetModel) {
  batchAxetModel.addEventListener("change", () => {
    const val = batchAxetModel.value;
    if (val) {
      localStorage.setItem("axet_batch_axet_model", val);
      saveBatchConfigToServer({ axetModel: val });
    }
  });
}

if (batchSkipCompleted) {
  batchSkipCompleted.addEventListener("change", () => {
    localStorage.setItem("axet_batch_skip_completed", batchSkipCompleted.checked ? "true" : "false");
  });
}

if (btnDecPar) {
  btnDecPar.addEventListener("click", () => {
    let val = parseInt(batchParallelism.value, 10) || 2;
    if (val > 1) {
      val--;
      batchParallelism.value = val;
      updateParallelismHint(val);
      localStorage.setItem("axet_batch_parallelism", String(val));
      saveBatchConfigToServer({ parallelism: val });
    }
  });
}

if (btnIncPar) {
  btnIncPar.addEventListener("click", () => {
    let val = parseInt(batchParallelism.value, 10) || 2;
    if (val < 8) {
      val++;
      batchParallelism.value = val;
      updateParallelismHint(val);
      localStorage.setItem("axet_batch_parallelism", String(val));
      saveBatchConfigToServer({ parallelism: val });
    }
  });
}

if (batchParallelism) {
  batchParallelism.addEventListener("input", () => {
    let val = parseInt(batchParallelism.value, 10) || 2;
    if (val < 1) val = 1;
    if (val > 8) val = 8;
    updateParallelismHint(val);
    localStorage.setItem("axet_batch_parallelism", String(val));
    saveBatchConfigToServer({ parallelism: val });
  });
}

if (batchStartBtn) batchStartBtn.addEventListener("click", () => startBatchExecution(false));
if (batchRetryErrorsBtn) {
  batchRetryErrorsBtn.addEventListener("click", async () => {
    try {
      batchRetryErrorsBtn.disabled = true;
      const res = await fetch("/api/batch/retry-failed", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        console.log(`[batch] ${data.retriedCount} falhas reenfileiradas com sucesso.`);
      }
    } catch (err) {
      console.error("[batch] Erro ao reenfileirar falhas:", err);
    } finally {
      batchRetryErrorsBtn.disabled = false;
    }
  });
}
if (batchResumeBtn) batchResumeBtn.addEventListener("click", () => startBatchExecution(true));
if (batchStopBtn) batchStopBtn.addEventListener("click", stopBatchExecution);

if (folderModalClose) folderModalClose.addEventListener("click", closeFolderModal);
if (folderModalCancel) folderModalCancel.addEventListener("click", closeFolderModal);
if (folderModalUpBtn) {
  folderModalUpBtn.addEventListener("click", () => {
    if (browseParentPath) loadFolderBrowser(browseParentPath);
  });
}
if (folderModalGoBtn) {
  folderModalGoBtn.addEventListener("click", navigateToEnteredPath);
}
if (folderModalCurrentPath) {
  folderModalCurrentPath.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      navigateToEnteredPath();
    }
  });
}
if (folderModalSearch) {
  folderModalSearch.addEventListener("input", () => {
    currentFilterTerm = folderModalSearch.value;
    if (folderModalSearchClear) {
      folderModalSearchClear.style.display = currentFilterTerm ? "block" : "none";
    }
    renderFolderList();
  });
}
if (folderModalSearchClear) {
  folderModalSearchClear.addEventListener("click", () => {
    folderModalSearch.value = "";
    currentFilterTerm = "";
    folderModalSearchClear.style.display = "none";
    renderFolderList();
    folderModalSearch.focus();
  });
}
if (folderModalShowHidden) {
  folderModalShowHidden.addEventListener("change", () => {
    if (currentBrowsePath) loadFolderBrowser(currentBrowsePath, true);
  });
}
if (folderModalSelect) {
  folderModalSelect.addEventListener("click", () => {
    if (currentBrowsePath) {
      applySelectedFolder(currentBrowsePath);
    }
  });
}

// ---------------------------------------------------------------------------
// Ações de Configuração e Navegação
// ---------------------------------------------------------------------------

const btnToggleSettings = $("btn-toggle-settings");
const btnCfgStart = $("btn-cfg-start");
const btnCfgResume = $("btn-cfg-resume");
const btnCfgRetry = $("btn-cfg-retry");
const btnCfgStop = $("btn-cfg-stop");
const btnCfgGotoQueue = $("btn-cfg-goto-queue");

if (btnToggleSettings) {
  btnToggleSettings.addEventListener("click", () => {
    if (currentCockpitTab === "config") {
      switchCockpitTab("queue");
    } else {
      switchCockpitTab("config");
    }
  });
}

if (btnCfgStart) {
  btnCfgStart.addEventListener("click", async () => {
    if (batchStartBtn && !batchStartBtn.disabled) {
      await startBatchExecution(false);
      switchCockpitTab("queue");
    }
  });
}

if (btnCfgResume) {
  btnCfgResume.addEventListener("click", async () => {
    if (batchResumeBtn && !batchResumeBtn.disabled) {
      await startBatchExecution(true);
      switchCockpitTab("queue");
    }
  });
}

if (btnCfgRetry) {
  btnCfgRetry.addEventListener("click", () => {
    if (batchRetryErrorsBtn && !batchRetryErrorsBtn.disabled) {
      batchRetryErrorsBtn.click();
    }
  });
}

if (btnCfgStop) {
  btnCfgStop.addEventListener("click", () => {
    if (batchStopBtn && !batchStopBtn.disabled) {
      stopBatchExecution();
    }
  });
}

if (btnCfgGotoQueue) {
  btnCfgGotoQueue.addEventListener("click", () => {
    switchCockpitTab("queue");
  });
}

// ---------------------------------------------------------------------------
// Controles de Busca, Filtros e Paginação da Fila e Histórico
// ---------------------------------------------------------------------------

const queueSearchInput = $("queue-search-input");
const queueSearchClear = $("queue-search-clear");

if (queueSearchInput) {
  queueSearchInput.addEventListener("input", (e) => {
    queueSearchTerm = e.target.value || "";
    if (queueSearchClear) {
      queueSearchClear.style.display = queueSearchTerm ? "block" : "none";
    }
    queueCurrentPage = 1;
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  });
}

if (queueSearchClear) {
  queueSearchClear.addEventListener("click", () => {
    if (queueSearchInput) queueSearchInput.value = "";
    queueSearchTerm = "";
    queueSearchClear.style.display = "none";
    queueCurrentPage = 1;
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  });
}

// Filtros de Status da Fila
document.querySelectorAll("#tab-panel-queue .filter-chip[data-filter]").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#tab-panel-queue .filter-chip[data-filter]").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    queueStatusFilter = chip.getAttribute("data-filter") || "all";
    queueCurrentPage = 1;
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  });
});

// Filtros de Status do Histórico (img2: Todos, Sucesso, Com Erro)
document.querySelectorAll("[data-hist-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-hist-filter]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    historyStatusFilter = btn.getAttribute("data-hist-filter") || "all";
    historyCurrentPage = 1;
    renderHistory();
  });
});

const queuePageSizeSelect = $("queue-page-size");
if (queuePageSizeSelect) {
  queuePageSizeSelect.addEventListener("change", (e) => {
    queuePageSize = e.target.value;
    queueCurrentPage = 1;
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  });
}

const queueFirstBtn = $("queue-first-page");
const queuePrevBtn = $("queue-prev-page");
const queueNextBtn = $("queue-next-page");
const queueLastBtn = $("queue-last-page");

if (queueFirstBtn) {
  queueFirstBtn.addEventListener("click", () => {
    queueCurrentPage = 1;
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  });
}
if (queuePrevBtn) {
  queuePrevBtn.addEventListener("click", () => {
    if (queueCurrentPage > 1) {
      queueCurrentPage--;
      if (currentBatch && currentBatch.queue) {
        renderQueueTable(currentBatch.queue);
      }
    }
  });
}
if (queueNextBtn) {
  queueNextBtn.addEventListener("click", () => {
    queueCurrentPage++;
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  });
}
if (queueLastBtn) {
  queueLastBtn.addEventListener("click", () => {
    queueCurrentPage = lastCalculatedQueueTotalPages || 1;
    if (currentBatch && currentBatch.queue) {
      renderQueueTable(currentBatch.queue);
    }
  });
}

const historySearchInput = $("history-search-input");
const historySearchClear = $("history-search-clear");
const historyPageSizeSelect = $("history-page-size");
const historyFirstBtn = $("history-first-page");
const historyPrevBtn = $("history-prev-page");
const historyNextBtn = $("history-next-page");
const historyLastBtn = $("history-last-page");

if (historySearchInput) {
  historySearchInput.addEventListener("input", (e) => {
    historySearchTerm = e.target.value || "";
    if (historySearchClear) {
      historySearchClear.style.display = historySearchTerm ? "block" : "none";
    }
    historyCurrentPage = 1;
    renderHistory();
  });
}

if (historySearchClear) {
  historySearchClear.addEventListener("click", () => {
    if (historySearchInput) historySearchInput.value = "";
    historySearchTerm = "";
    historySearchClear.style.display = "none";
    historyCurrentPage = 1;
    renderHistory();
  });
}

if (historyPageSizeSelect) {
  historyPageSizeSelect.addEventListener("change", (e) => {
    historyPageSize = e.target.value;
    historyCurrentPage = 1;
    renderHistory();
  });
}

if (historyFirstBtn) {
  historyFirstBtn.addEventListener("click", () => {
    if (historyCurrentPage !== 1) {
      historyCurrentPage = 1;
      renderHistory();
    }
  });
}

if (historyPrevBtn) {
  historyPrevBtn.addEventListener("click", () => {
    if (historyCurrentPage > 1) {
      historyCurrentPage--;
      renderHistory();
    }
  });
}

if (historyNextBtn) {
  historyNextBtn.addEventListener("click", () => {
    historyCurrentPage++;
    renderHistory();
  });
}

if (historyLastBtn) {
  historyLastBtn.addEventListener("click", () => {
    if (historyCurrentPage !== lastCalculatedHistoryTotalPages) {
      historyCurrentPage = lastCalculatedHistoryTotalPages || 1;
      renderHistory();
    }
  });
}

// Interatividade dos Chips de Progresso Geral (img5)
const chipSucc = $("kpi-chip-success");
if (chipSucc) {
  chipSucc.addEventListener("click", () => {
    switchCockpitTab("history");
    const btn = document.querySelector('[data-hist-filter="success"]');
    if (btn) btn.click();
  });
}
const chipRun = $("kpi-chip-running");
if (chipRun) {
  chipRun.addEventListener("click", () => {
    switchCockpitTab("active-runs");
  });
}
const chipErr = $("kpi-chip-error");
if (chipErr) {
  chipErr.addEventListener("click", () => {
    switchCockpitTab("history");
    const btn = document.querySelector('[data-hist-filter="error"]');
    if (btn) btn.click();
  });
}

// Botão Abrir Pasta de Saída no Finder/Sistema (img4)
const btnOpenOut = $("btn-open-output-folder");
if (btnOpenOut) {
  btnOpenOut.addEventListener("click", async () => {
    const outDir = batchOutputDir ? batchOutputDir.value.trim() : "";
    if (!outDir) return;
    try {
      await fetch("/api/fs/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: outDir }),
      });
    } catch (_) {}
  });
}

// Autenticação Corporativa Okta SSO & Gateway (:3001)
const authBadge = $("header-auth-badge");
const ssoModal = $("sso-modal-overlay");
const ssoClose = $("sso-modal-close");
const ssoOk = $("sso-modal-ok");
const ssoRefreshBtn = $("sso-btn-refresh-token");

if (authBadge && ssoModal) {
  authBadge.addEventListener("click", () => {
    ssoModal.classList.add("open");
  });
}
if (ssoClose && ssoModal) {
  ssoClose.addEventListener("click", () => {
    ssoModal.classList.remove("open");
  });
}
if (ssoOk && ssoModal) {
  ssoOk.addEventListener("click", () => {
    ssoModal.classList.remove("open");
  });
}
if (ssoModal) {
  ssoModal.addEventListener("click", (e) => {
    if (e.target === ssoModal) ssoModal.classList.remove("open");
  });
}
async function syncAuthStatus() {
  try {
    const res = await fetch("/api/auth/status");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.user) {
      const u = data.user;
      const gw = data.gateway || {};
      const headerName = $("header-auth-name");
      const headerAvatar = $("header-auth-avatar");
      const modalUser = $("sso-modal-user");
      const modalEmail = $("sso-modal-email");
      const modalOrg = $("sso-modal-org");
      const modalAvatar = $("sso-modal-avatar");
      const modalLogin = $("sso-modal-login");
      const modalOktaId = $("sso-modal-okta-id");
      const modalIdp = $("sso-modal-idp");
      const modalTokenTtl = $("sso-modal-token-ttl");
      const modalGwStatus = $("sso-modal-gw-status");

      const firstName = u.firstName || (u.name || "").split(" ")[0];
      const words = (u.name || "").split(" ").filter(Boolean);
      const initials = words.length > 1
        ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
        : (words[0] ? words[0].slice(0, 2).toUpperCase() : "GB");

      if (headerName) headerName.textContent = firstName ? `${firstName} B.` : (u.name || "Gustavo B.");
      if (headerAvatar) headerAvatar.textContent = initials;
      if (modalUser) modalUser.textContent = u.name || "Gustavo Costa Berbert";
      if (modalEmail) modalEmail.textContent = u.email || "gustavo.costa.berbert@nttdata.com";
      if (modalOrg && u.org) modalOrg.textContent = `${u.org}${u.tenant ? " (" + u.tenant + ")" : ""} • ${u.role || "RAG Pipeline Architect"}`;
      if (modalAvatar) modalAvatar.textContent = initials;

      if (modalLogin && u.login) {
        modalLogin.textContent = u.login;
      }
      if (modalOktaId && u.oktaId) {
        modalOktaId.textContent = u.oktaId;
      }
      if (modalIdp) {
        modalIdp.textContent = `Okta Enterprise OIDC (${u.tenant || "OneNTT"})`;
      }

      if (modalTokenTtl) {
        if (typeof gw.remainingSeconds === "number" && gw.remainingSeconds > 0) {
          const mins = Math.floor(gw.remainingSeconds / 60);
          const secs = gw.remainingSeconds % 60;
          modalTokenTtl.innerHTML = `<span style="color: #059669;">🟢 Ativo</span> (~${mins}m ${secs}s restantes)`;
        } else {
          modalTokenTtl.innerHTML = `<span style="color: #059669;">🟢 Ativo (Sessão Válida)</span>`;
        }
      }

      if (modalGwStatus) {
        const isOnline = gw.gateway8766Online || gw.gateway3001Online || gw.status === "connected";
        if (isOnline) {
          modalGwStatus.innerHTML = `<span style="color: #059669;">🟢 Online</span> (API Gateway :8766 / :3001)`;
        } else {
          modalGwStatus.innerHTML = `<span style="color: #eab308;">🟡 Standalone</span> (Modo Local)`;
        }
      }
    }
    const syncTime = $("sso-last-sync-time");
    if (syncTime) syncTime.textContent = new Date().toLocaleTimeString("pt-BR");
  } catch (_) {}
}

if (ssoRefreshBtn) {
  ssoRefreshBtn.addEventListener("click", async () => {
    ssoRefreshBtn.disabled = true;
    ssoRefreshBtn.textContent = "Renovando...";
    try {
      await fetch("/api/auth/refresh", { method: "POST" });
      await syncAuthStatus();
      ssoRefreshBtn.textContent = "✓ Sessão Sincronizada";
      setTimeout(() => {
        ssoRefreshBtn.disabled = false;
        ssoRefreshBtn.textContent = "🔄 Sincronizar Sessão";
      }, 1500);
    } catch (_) {
      ssoRefreshBtn.disabled = false;
      ssoRefreshBtn.textContent = "🔄 Tentar Novamente";
    }
  });
}

// Sincronização inicial e auto-refresh silencioso de token (a cada 60s em background)
syncAuthStatus();
setInterval(syncAuthStatus, 60000);

// ---------------------------------------------------------------------------
// Conexão SSE + snapshot inicial
// ---------------------------------------------------------------------------

function setConnectionStatus(connected) {
  if (connected) {
    connDot.classList.add("connected");
    connDot.classList.remove("disconnected");
    connStatus.textContent = "conectado";
  } else {
    connDot.classList.add("disconnected");
    connDot.classList.remove("connected");
    connStatus.textContent = "desconectado — tentando reconectar...";
  }
}

async function loadAxetModels() {
  try {
    const res = await fetch("/api/axet/models");
    const data = await res.json();
    if (data.ok && Array.isArray(data.models) && data.models.length > 0 && batchAxetModel) {
      const savedAxet = localStorage.getItem("axet_batch_axet_model");
      const selectedVal = savedAxet || (currentBatch && currentBatch.axetModel) || batchAxetModel.value || "gpt-5.6-terra";
      batchAxetModel.innerHTML = data.models
        .map(
          (m) =>
            `<option value="${escapeHtml(m.id)}"${
              m.id === selectedVal ? " selected" : ""
            }>${escapeHtml(m.name)}</option>`
        )
        .join("");
      if (selectedVal) batchAxetModel.value = selectedVal;
    }
  } catch (e) {
    console.warn("Não foi possível carregar modelos axet-code:", e);
  }
}

async function loadInitialState() {
  await loadAxetModels();
  try {
    const res = await fetch("/state");
    const data = await res.json();
    allRuns = data.runs || {};
    runOrderList = data.order || Object.keys(allRuns);

    syncActiveRunCards();
    Object.keys(runCardEls).forEach((runId) => {
      renderRunCardInfo(runId);
      renderStepCardsForRun(runId);
      renderInitialLogsForRun(runId);
    });
    renderHistory();
  } catch (e) {
    console.error("Falha ao carregar /state:", e);
  }

  try {
    const savedOut = localStorage.getItem("axet_batch_output_dir");
    if (savedOut && batchOutputDir) {
      batchOutputDir.value = savedOut;
      saveBatchConfigToServer({ outputDir: savedOut });
    }
    const savedIn = localStorage.getItem("axet_batch_input_dir");
    if (savedIn && batchInputDir) {
      batchInputDir.value = savedIn;
      saveBatchConfigToServer({ inputDir: savedIn });
    }
    const savedWhisper = localStorage.getItem("axet_batch_whisper_model");
    if (savedWhisper && batchWhisperModel) {
      batchWhisperModel.value = savedWhisper;
      saveBatchConfigToServer({ whisperModel: savedWhisper });
    }
    const savedLang = localStorage.getItem("axet_batch_whisper_lang");
    if (savedLang && batchWhisperLang) {
      batchWhisperLang.value = savedLang;
      saveBatchConfigToServer({ whisperLanguage: savedLang });
    }
    const savedAxet = localStorage.getItem("axet_batch_axet_model");
    if (savedAxet && batchAxetModel) {
      batchAxetModel.value = savedAxet;
      saveBatchConfigToServer({ axetModel: savedAxet });
    }
    const savedPar = localStorage.getItem("axet_batch_parallelism");
    if (savedPar && batchParallelism) {
      const p = parseInt(savedPar, 10);
      if (p >= 1 && p <= 8) {
        batchParallelism.value = p;
        updateParallelismHint(p);
        saveBatchConfigToServer({ parallelism: p });
      }
    }
    const savedVision = localStorage.getItem("axet_batch_video_vision_mode");
    if (savedVision && batchVideoVisionMode) {
      batchVideoVisionMode.value = savedVision;
      updateVisionModeHint(savedVision);
      saveBatchConfigToServer({ videoVisionMode: savedVision });
    }
    const savedSkip = localStorage.getItem("axet_batch_skip_completed");
    if (savedSkip !== null && batchSkipCompleted) {
      batchSkipCompleted.checked = savedSkip === "true";
    }

    const batchRes = await fetch("/api/batch/status");
    const batchData = await batchRes.json();
    if (batchData.ok && batchData.batch) {
      renderBatchState(batchData.batch);
    }
  } catch (e) {
    console.error("Falha ao carregar /api/batch/status:", e);
  }

  try {
    const sysRes = await fetch("/api/system/metrics");
    const sysData = await sysRes.json();
    if (sysData.ok && sysData.metrics) {
      updateSystemMetrics(sysData.metrics);
    }
  } catch (e) {
    console.warn("Falha ao carregar métricas de sistema iniciais:", e);
  }
}

function connectSSE() {
  const es = new EventSource("/events");

  es.onopen = () => setConnectionStatus(true);
  es.onerror = () => setConnectionStatus(false);

  es.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data);
      applyEventLocally(evt);
    } catch (e) {
      console.error("Evento SSE inválido:", e, msg.data);
    }
  };
}

// ---------------------------------------------------------------------------
// Ticker Dinâmico de Tempo Real (1s) para Runs e Etapas em Execução
// ---------------------------------------------------------------------------

function tickActiveTimers() {
  const now = Date.now();

  // 1. Atualiza cronômetro de cada execução ativa na interface
  Object.keys(runCardEls).forEach((runId) => {
    const run = allRuns[runId];
    const els = runCardEls[runId];
    if (!run || !els || run.status !== "running") return;

    // Atualiza tempo total decorrido do card no topo
    if (run.started_at && els.cardMetaEl) {
      const totalElap = Math.max(0, (now - new Date(run.started_at).getTime()) / 1000);
      const metaDurEl = els.cardMetaEl.querySelector(".meta-dur");
      if (metaDurEl) {
        metaDurEl.textContent = `${formatDuration(totalElap)} (ativo)`;
      }
    }

    // Atualiza tempo decorrido do step ativo (running) segundo a segundo
    if (run.steps) {
      Object.entries(run.steps).forEach(([stepKey, stepData]) => {
        if (stepData && stepData.status === "running" && stepData.started_at) {
          const stepElap = Math.max(0, (now - new Date(stepData.started_at).getTime()) / 1000);
          const durText = formatDuration(stepElap);

          const card = els.stepsEl.querySelector(`.step-card[data-step="${stepKey}"]`);
          if (card) {
            const durStrong = card.querySelector('[data-role="timing-dur"]');
            if (durStrong) {
              durStrong.textContent = durText;
              const durSpan = durStrong.closest(".timing-dur");
              if (durSpan) durSpan.style.display = "";
              const sep = card.querySelector(".timing-dur-sep");
              if (sep) sep.style.display = "";
            }
          }
        }
      });
    }
  });

  // 2. Se a fila de lote estiver renderizada com itens em execução, atualiza tempo decorrido
  if (currentBatch && currentBatch.queue && currentBatch.queue.length > 0) {
    currentBatch.queue.forEach((it) => {
      if (it.status === "running" && it.started_at) {
        const rowEl = document.querySelector(`tr[data-batch-id="${it.id}"] .batch-item-dur`);
        if (rowEl) {
          const elap = Math.max(0, (now - new Date(it.started_at).getTime()) / 1000);
          rowEl.textContent = formatDuration(elap);
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Inicialização e Redraw Periódico
// ---------------------------------------------------------------------------

window.addEventListener("resize", () => {
  if (currentCockpitTab === "storage") {
    drawCpuRamChart();
  }
});

// Mantém animação do gráfico fluida e timer ao vivo a cada segundo
setInterval(() => {
  if (currentCockpitTab === "storage") {
    drawCpuRamChart();
  }
  tickActiveTimers();
}, 1000);

renderActiveRunsEmptyState();
loadInitialState().then(() => {
  connectSSE();
  drawCpuRamChart();
});
