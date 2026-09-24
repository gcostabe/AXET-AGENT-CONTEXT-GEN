#!/usr/bin/env node
/**
 * dashboard/server.js
 *
 * Servidor HTTP + SSE (Server-Sent Events) em Node.js puro (sem dependências
 * externas) para receber telemetria dos scripts do pipeline AXET Video
 * Pipeline e retransmitir em tempo real para o dashboard (cockpit) no
 * navegador.
 *
 * Endpoints:
 *   GET  /            -> serve o dashboard (index.html)
 *   GET  /app.js       -> serve o JS do dashboard
 *   GET  /style.css    -> serve o CSS do dashboard
 *   GET  /events       -> conexão SSE (stream de eventos de telemetria)
 *   GET  /state         -> snapshot atual (JSON) do estado de todos os runs
 *   POST /telemetry     -> recebe um evento de telemetria (JSON) dos scripts
 *
 * Uso:
 *   node dashboard/server.js [porta]
 *
 * Variável de ambiente:
 *   PORT (default 4545)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { execSync, spawn, spawnSync } = require("child_process");
const os = require("os");

const PORT = parseInt(process.argv[2] || process.env.PORT || "4545", 10);
const PUBLIC_DIR = __dirname;
const ROOT_DIR = path.resolve(__dirname, "..");
const MAX_HISTORY = 50; // número máximo de runs mantidos no histórico

// ---------------------------------------------------------------------------
// Estado em memória
// ---------------------------------------------------------------------------

/**
 * runs: Map<run_id, RunState>
 * RunState = {
 *   run_id, video, whisper_model, axet_model, started_at,
 *   status: 'running' | 'success' | 'error',
 *   finished_at, duration_total_s,
 *   steps: { [nome_etapa]: { status, started_at, finished_at, duration_s, detalhes } },
 *   logs: [ { ts, level, step, message } ]  (buffer limitado)
 * }
 */
const runs = new Map();
const runOrder = []; // ordem de chegada dos run_ids (para limitar histórico)

// clientes SSE conectados
const sseClients = new Set();

const MAX_LOG_LINES_PER_RUN = 500;

// ---------------------------------------------------------------------------
// Telemetria do Sistema em Tempo Real (CPU e Memória RAM)
// ---------------------------------------------------------------------------

let lastCpuSample = null;

function getCpuUsagePct() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }
  if (!lastCpuSample) {
    lastCpuSample = { idle, total };
    return 0;
  }
  const idleDelta = idle - lastCpuSample.idle;
  const totalDelta = total - lastCpuSample.total;
  lastCpuSample = { idle, total };
  if (totalDelta <= 0) return 0;
  const pct = Math.round(100 - (100 * idleDelta) / totalDelta);
  return Math.max(0, Math.min(100, pct));
}

function getSystemMetrics() {
  const total = os.totalmem();
  let used = 0;
  let memPct = 0;
  let cachedBytes = 0;
  let freeBytes = os.freemem();

  try {
    const vmOut = execSync("vm_stat", { timeout: 1000 }).toString();
    const stats = {};
    for (const line of vmOut.split("\n")) {
      const parts = line.split(":");
      if (parts.length === 2) {
        stats[parts[0].trim()] = parseInt(parts[1].trim().replace(".", ""), 10);
      }
    }
    const pageSizeMatch = vmOut.match(/page size of (\d+) bytes/i);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : (process.arch === "arm64" ? 16384 : 4096);

    const anonymous = (stats["Anonymous pages"] || 0) * pageSize;
    const wired = (stats["Pages wired down"] || 0) * pageSize;
    const compressed = (stats["Pages occupied by compressor"] || 0) * pageSize;
    const purgeable = (stats["Pages purgeable"] || 0) * pageSize;
    const fileBacked = (stats["File-backed pages"] || 0) * pageSize;
    const freePages = (stats["Pages free"] || 0) * pageSize;

    // Cálculo oficial do Activity Monitor da Apple:
    // Memória Real Usada = App (Anonymous - Purgeable) + Wired + Compressed
    // O restante é cache de arquivos e memória inativa livre sob demanda.
    const appMem = Math.max(0, anonymous - purgeable);
    used = appMem + wired + compressed;
    cachedBytes = fileBacked + purgeable;
    freeBytes = freePages;
    memPct = total > 0 ? Math.round((used / total) * 100) : 0;
  } catch (e) {
    used = Math.max(0, total - os.freemem());
    memPct = total > 0 ? Math.round((used / total) * 100) : 0;
  }

  const cpuPct = getCpuUsagePct();
  const cpus = os.cpus() || [];
  return {
    cpu_pct: cpuPct,
    cpu_cores: cpus.length,
    cpu_model: cpus[0] ? cpus[0].model : "Apple Silicon",
    mem_used_bytes: used,
    mem_total_bytes: total,
    mem_free_bytes: freeBytes,
    mem_cached_bytes: cachedBytes,
    mem_pct: Math.min(100, Math.max(0, memPct)),
    mem_used_gb: (used / (1024 ** 3)).toFixed(1),
    mem_total_gb: (total / (1024 ** 3)).toFixed(1),
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Watchdog de runs "zumbis"
// ---------------------------------------------------------------------------
// Se um processo do pipeline morrer (kill -9, crash, terminal fechado, etc.)
// sem nunca emitir o evento `run_end`, o run ficaria com status "running"
// para sempre e o card correspondente nunca sairia da tela do dashboard.
// Para evitar isso, guardamos `last_event_at` em cada run e periodicamente
// verificamos se algum run "running" está sem nenhum evento (nem log/step)
// por mais tempo que STALE_TIMEOUT_MS. Se sim, encerramos ele artificialmente
// com status "error", o que aciona no cliente (app.js) o linger de remoção
// automática do card ativo.
/**
 * Verifica se um processo com o PID informado ainda está ativo no sistema operacional.
 * Usa process.kill(pid, 0), que não envia sinal real, mas valida a existência do processo.
 */
function isProcessAlive(pid) {
  const numPid = typeof pid === "number" ? pid : parseInt(pid, 10);
  if (!numPid || isNaN(numPid) || numPid <= 0) return false;
  try {
    process.kill(numPid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Timeout configurável via env (padrão 10 minutos para tarefas com IA/Whisper em CPU)
const STALE_TIMEOUT_MS = parseInt(process.env.STALE_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const STALE_CHECK_INTERVAL_MS = 15 * 1000;
const MAX_ALIVE_TIMEOUT_MS = parseInt(process.env.MAX_ALIVE_TIMEOUT_MS || String(60 * 60 * 1000), 10); // 1h se processo vivo
const DEAD_PROCESS_GRACE_MS = 15 * 1000; // 15s após processo morrer sem emitir run_end

/**
 * Retorna os PIDs filhos diretos de um processo, usando `pgrep -P`.
 * Necessário porque process.kill(pid, 'SIGTERM') mata apenas o processo
 * bash principal do pipeline, mas não seus filhos (ffmpeg, whisper,
 * axet-code), que continuariam rodando "zumbis" em background após um
 * cancelamento manual pelo dashboard.
 */
function getChildPids(pid) {
  try {
    const out = execSync(`pgrep -P ${pid}`, { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch (_) {
    // pgrep retorna exit code != 0 quando não há filhos — não é um erro real
    return [];
  }
}

/**
 * Mata um processo e toda a sua árvore de descendentes (filhos, netos etc.),
 * garantindo que ao cancelar um run pelo dashboard, ffmpeg/whisper/axet-code
 * em execução naquele momento sejam encerrados junto com o script bash pai.
 */
function killProcessTree(pid, signal) {
  const visited = new Set();
  const queue = [pid];
  const allPids = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    allPids.push(current);
    queue.push(...getChildPids(current));
  }
  // mata primeiro os processos mais "filhos" (folhas) e por último o pai,
  // evitando que filhos fiquem órfãos e escapem do encerramento.
  for (const p of allPids.reverse()) {
    try {
      process.kill(p, signal);
    } catch (_) {
      // processo já pode ter terminado
    }
  }
}

// ---------------------------------------------------------------------------
// Processamento em Lote (Batch), Varredura Recursiva e Seletor de Pastas
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".m4v", ".ts", ".wmv"
]);

const DOCUMENT_EXTENSIONS = new Set([
  // PDFs & Documentos de Texto / Office
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".odt", ".odp", ".ods",
  // Web & Hipertexto
  ".html", ".htm", ".xhtml", ".xml",
  // Texto Plano & Markdown
  ".txt", ".md", ".markdown", ".rtf",
  // Planilhas & Dados Tabulares
  ".xlsx", ".xls", ".csv", ".tsv",
  // Dados Estruturados
  ".json", ".jsonl"
]);

const IGNORED_DIRS = new Set([
  ".git", ".venv", ".agent", ".cache", "node_modules", "scratch", ".system_generated"
]);

const IGNORED_FILES = new Set([
  "batch_manifest.json",
  "frames_manifest.json",
  "package.json",
  "package-lock.json",
  ".ds_store",
]);

function getMediaType(item) {
  if (!item) return "video";
  const ext = path.extname(item.filename || item.name || item.relativePath || "").toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (item.mediaType === "document" || (item.id && String(item.id).startsWith("doc_"))) return "document";
  return "video";
}

function getItemExtension(item) {
  if (!item) return "";
  return path.extname(item.filename || item.name || item.relativePath || "").toLowerCase();
}

/**
 * Remove duplicatas da lista de itens com base em mesmo nome de arquivo (normalizado em NFC)
 * e mesmo tamanho em bytes (sizeBytes > 0).
 * Se houver itens duplicados, prioriza o item já concluído ('completed') ou com markdownPath válido.
 */
function deduplicateItems(items) {
  if (!Array.isArray(items) || items.length <= 1) return items || [];

  const dedupMap = new Map();
  for (const item of items) {
    const rawName = item.filename || item.name || (item.relativePath ? path.basename(item.relativePath) : "");
    const filename = rawName.normalize("NFC").toLowerCase();
    const size = item.sizeBytes || 0;
    const key = size > 0 ? `${filename}:::${size}` : `path:::${item.relativePath || item.id}`;

    if (!dedupMap.has(key)) {
      dedupMap.set(key, item);
    } else {
      const existing = dedupMap.get(key);
      const isExistingCompleted = existing.status === "completed" || !!existing.markdownPath;
      const isNewCompleted = item.status === "completed" || !!item.markdownPath;

      if (!isExistingCompleted && isNewCompleted) {
        dedupMap.set(key, item);
      } else if (!isExistingCompleted && !isNewCompleted) {
        const existingDepth = (existing.relativePath || "").split("/").length;
        const newDepth = (item.relativePath || "").split("/").length;
        if (newDepth < existingDepth) {
          dedupMap.set(key, item);
        }
      }
    }
  }

  return Array.from(dedupMap.values());
}

/**
 * Varre recursivamente um diretório raiz e todas as suas subpastas
 * em busca de arquivos de vídeo suportados.
 */
function scanFilesRecursively(dirPath, rootDir = dirPath, ingestionMode = batchState.ingestionMode || "all") {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return results;
  } catch (_) {
    return results;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (IGNORED_DIRS.has(lower)) continue;
      if (batchState.outputDir && path.resolve(fullPath) === path.resolve(batchState.outputDir)) continue;
      results.push(...scanFilesRecursively(fullPath, rootDir, ingestionMode));
    } else if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name.toLowerCase())) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const isVideo = VIDEO_EXTENSIONS.has(ext);
      const isDoc = DOCUMENT_EXTENSIONS.has(ext);

      let include = false;
      if (ingestionMode === "videos" && isVideo) include = true;
      else if (ingestionMode === "documents" && isDoc) include = true;
      else if (ingestionMode === "all" && (isVideo || isDoc)) include = true;

      if (include) {
        let sizeBytes = 0;
        let allocatedBytes = 0;
        try {
          const st = fs.statSync(fullPath);
          sizeBytes = st.size;
          allocatedBytes = (st.blocks || 0) * 512;
        } catch (_) {}
        const isHydrated = allocatedBytes >= (sizeBytes * 0.9);
        const isOnlineOnly = allocatedBytes === 0 || allocatedBytes < 65536;
        const mediaType = isDoc ? "document" : "video";
        const prefix = isDoc ? "doc_" : "vid_";

        results.push({
          id: `${prefix}${Buffer.from(path.relative(rootDir, fullPath)).toString("base64").replace(/=/g, "")}`,
          fullPath,
          relativePath: path.relative(rootDir, fullPath),
          filename: entry.name,
          mediaType,
          extension: ext,
          sizeBytes,
          allocatedBytes,
          isHydrated,
          isOnlineOnly,
        });
      }
    }
  }

  const sorted = results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (dirPath === rootDir) {
    return deduplicateItems(sorted);
  }
  return sorted;
}

function scanVideosRecursively(dirPath, rootDir = dirPath) {
  return scanFilesRecursively(dirPath, rootDir, batchState.ingestionMode || "all");
}

/**
 * Diálogo nativo do sistema operacional (desativado em favor do modal customizado web).
 */
function chooseFolderNative(_defaultDir) {
  return { ok: false, customOnly: true, error: "Diálogo nativo desativado; utilize o seletor customizado web." };
}

/**
 * Lista subpastas para o navegador de arquivos web embutido no cockpit.
 * Suporta expansão de ~, resolução de links simbólicos (ex.: OneDrive), contagem de vídeos e atalhos rápidos.
 */
function browseDirectory(targetDir, showHidden = false) {
  let input = (targetDir || "").trim();
  if (input.startsWith("~/")) {
    input = path.join(os.homedir(), input.slice(2));
  } else if (input === "~") {
    input = os.homedir();
  }
  const resolved = path.resolve(input || os.homedir());

  if (!fs.existsSync(resolved)) {
    return { error: `Diretório não encontrado: ${resolved}`, current: resolved };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return { error: `Não foi possível acessar ${resolved}: ${err.message}`, current: resolved };
  }
  if (!stat.isDirectory()) {
    return { error: "O caminho informado não é um diretório", current: resolved };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (err) {
    return { error: `Erro ao ler diretório: ${err.message}`, current: resolved };
  }

  const subdirs = [];
  for (const ent of entries) {
    if (!showHidden && ent.name.startsWith(".")) continue;

    let isDir = ent.isDirectory();
    let isSymlink = ent.isSymbolicLink();

    // Se for link simbólico, valida se o destino é um diretório real
    if (!isDir && isSymlink) {
      try {
        const targetStat = fs.statSync(path.join(resolved, ent.name));
        if (targetStat.isDirectory()) {
          isDir = true;
        }
      } catch (_) {}
    }

    if (!isDir) continue;
    if (IGNORED_DIRS.has(ent.name.toLowerCase())) continue;

    // Contagem rasa de vídeos e arquivos no subdiretório para feedback imediato
    let videoCount = 0;
    let fileCount = 0;
    let hasSubdirs = false;
    try {
      const childEnts = fs.readdirSync(path.join(resolved, ent.name), { withFileTypes: true });
      for (const ce of childEnts) {
        if (ce.name.startsWith(".")) continue;
        let ceIsDir = ce.isDirectory();
        if (!ceIsDir && ce.isSymbolicLink()) {
          try {
            ceIsDir = fs.statSync(path.join(resolved, ent.name, ce.name)).isDirectory();
          } catch (_) {}
        }
        if (ceIsDir) {
          hasSubdirs = true;
        } else {
          fileCount++;
          const ext = path.extname(ce.name).toLowerCase();
          if (VIDEO_EXTENSIONS.has(ext)) {
            videoCount++;
          }
        }
      }
    } catch (_) {}

    subdirs.push({
      name: ent.name,
      path: path.join(resolved, ent.name),
      isSymlink,
      videoCount,
      fileCount,
      hasSubdirs,
    });
  }
  subdirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  // Atalhos rápidos inteligentes do sistema
  const homeDir = os.homedir();
  const devDir = path.join(homeDir, "dev");
  const desktopDir = path.join(homeDir, "Desktop");
  const downloadsDir = path.join(homeDir, "Downloads");

  let onedriveDir = null;
  const possibleOnedrive = [
    path.join(homeDir, "OneDrive - NTT DATA EMEAL"),
    path.join(homeDir, "Library", "CloudStorage", "OneDrive-NTTDATAEMEAL"),
  ];
  for (const p of possibleOnedrive) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        onedriveDir = p;
        break;
      }
    } catch (_) {}
  }
  if (!onedriveDir) {
    try {
      const cs = path.join(homeDir, "Library", "CloudStorage");
      if (fs.existsSync(cs)) {
        const csEnts = fs.readdirSync(cs);
        const od = csEnts.find((e) => e.toLowerCase().includes("onedrive"));
        if (od) onedriveDir = path.join(cs, od);
      }
    } catch (_) {}
  }

  const shortcuts = [];
  shortcuts.push({ id: "home", label: "🏠 Home (~)", path: homeDir });

  // Destaque para pasta de teste recente do usuário
  const testeMarcioPath = path.join(homeDir, "TESTE VIDEO MARCIO");
  if (fs.existsSync(testeMarcioPath)) {
    shortcuts.push({ id: "teste_marcio", label: "🎬 TESTE VIDEO MARCIO", path: testeMarcioPath, highlight: true });
  }

  if (onedriveDir) {
    shortcuts.push({ id: "onedrive", label: "☁️ OneDrive", path: onedriveDir });
  }
  if (fs.existsSync(devDir)) {
    shortcuts.push({ id: "dev", label: "💻 dev/", path: devDir });
  }
  shortcuts.push({ id: "ws", label: "📂 Workspace", path: ROOT_DIR });
  shortcuts.push({ id: "videos", label: "🎬 videos/", path: path.join(ROOT_DIR, "videos") });
  if (fs.existsSync(downloadsDir)) {
    shortcuts.push({ id: "downloads", label: "📥 Downloads", path: downloadsDir });
  }
  if (fs.existsSync(desktopDir)) {
    shortcuts.push({ id: "desktop", label: "🖥️ Desktop", path: desktopDir });
  }
  shortcuts.push({ id: "output", label: "📤 output/", path: path.join(ROOT_DIR, "output") });

  return {
    current: resolved,
    parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
    subdirs,
    shortcuts,
    home: homeDir,
    workspace: ROOT_DIR,
    defaultVideos: path.join(ROOT_DIR, "videos"),
    defaultOutput: path.join(ROOT_DIR, "output"),
    onedrive: onedriveDir,
  };
}

let cachedAxetModels = null;
let cachedAxetModelsTs = 0;

function getAvailableAxetModels() {
  const now = Date.now();
  if (cachedAxetModels && now - cachedAxetModelsTs < 300000) {
    return cachedAxetModels;
  }

  const defaultModels = [
    { id: "gpt-5.6-terra", name: "gpt-5.6-terra (padrão / recomendado)", provider: "openai" },
    { id: "gpt-5.6-luna", name: "gpt-5.6-luna", provider: "openai" },
    { id: "gpt-5.4-2026-03-05", name: "gpt-5.4-2026-03-05", provider: "openai" },
    { id: "gpt-5.2", name: "gpt-5.2", provider: "openai" },
    { id: "gpt-5.1", name: "gpt-5.1", provider: "openai" },
    { id: "gpt-4.1", name: "gpt-4.1", provider: "openai" },
    { id: "gpt-4o", name: "gpt-4o", provider: "openai" },
    { id: "gpt-5-mini", name: "gpt-5-mini (rápido)", provider: "openai" },
    { id: "gpt-4o-mini", name: "gpt-4o-mini", provider: "openai" },
    { id: "eu.anthropic.claude-sonnet-5", name: "claude-sonnet-5", provider: "aws_anthropic" },
    { id: "eu.anthropic.claude-sonnet-4-6", name: "claude-sonnet-4-6", provider: "aws_anthropic" },
    { id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0", name: "claude-haiku-4-5", provider: "aws_anthropic" },
  ];

  try {
    const stdout = execSync("axet-code models 2>&1", { encoding: "utf-8", timeout: 4000 });
    const parsed = [];
    let currentProvider = "openai";
    const lines = stdout.split("\n");
    for (const line of lines) {
      const clean = line.replace(/[│├└─]/g, "").trim();
      if (!clean || clean.startsWith("202") || clean.startsWith("INFO")) continue;
      if (clean === "aws_anthropic" || clean === "openai") {
        currentProvider = clean;
      } else {
        const modelId = clean.replace(/^(openai|aws_anthropic)\//, "");
        const modelName = modelId.replace(/^eu\.anthropic\./, "");
        const isTerra = modelId === "gpt-5.6-terra";
        parsed.push({
          id: modelId,
          rawId: clean,
          name: isTerra ? `${modelName} (recomendado)` : modelName,
          provider: currentProvider,
        });
      }
    }
    if (parsed.length > 0) {
      cachedAxetModels = parsed;
      cachedAxetModelsTs = now;
      return parsed;
    }
  } catch (_) {}

  cachedAxetModels = defaultModels;
  cachedAxetModelsTs = now;
  return defaultModels;
}

// ---------------------------------------------------------------------------
// Estado e Controle do Lote (BatchQueueManager)
// ---------------------------------------------------------------------------

const batchState = {
  status: "idle", // 'idle' | 'scanning' | 'running' | 'stopping' | 'stopped' | 'completed'
  inputDir: path.join(ROOT_DIR, "videos"),
  outputDir: path.join(ROOT_DIR, "output"),
  ingestionMode: "all", // 'all' | 'videos' | 'documents'
  parallelism: 2,
  whisperModel: "small",
  whisperLanguage: "es",
  axetModel: "gpt-5.6-terra",
  videoVisionMode: "vision_ocr", // 'vision_ocr' (OCR + Visão Multimodal) | 'audio_only' (Apenas Áudio)
  queue: [], // itens da fila
  stats: { total: 0, pending: 0, running: 0, completed: 0, errors: 0, cancelled: 0 },
  diskSafetyLimitGb: 3, // Salvaguarda padrão reduzida para 3 GB para evitar bloqueio com 15.5 GB livres
  statusMessage: null,
  startedAt: null,
  finishedAt: null,
};

// Map de workerId -> { item, pid, child }
const activeBatchWorkers = new Map();

let masterQueue = [];

function syncMasterQueueFromState() {
  if (masterQueue.length === 0 && batchState.queue.length > 0) {
    masterQueue = batchState.queue.map((item) => ({
      ...item,
      mediaType: getMediaType(item),
      extension: item.extension || getItemExtension(item),
    }));
    return;
  }
  const queueMap = new Map();
  for (const item of batchState.queue) {
    const key = item.id || item.relativePath;
    if (key) queueMap.set(key, item);
  }
  for (let i = 0; i < masterQueue.length; i++) {
    const key = masterQueue[i].id || masterQueue[i].relativePath;
    if (key && queueMap.has(key)) {
      masterQueue[i] = {
        ...masterQueue[i],
        ...queueMap.get(key),
        mediaType: getMediaType(queueMap.get(key)),
        extension: queueMap.get(key).extension || getItemExtension(queueMap.get(key)),
      };
    }
  }
}

function filterQueueByMode(mode = batchState.ingestionMode || "all") {
  if (!Array.isArray(masterQueue) || masterQueue.length === 0) {
    if (batchState.queue.length > 0) {
      masterQueue = batchState.queue.map((item) => ({
        ...item,
        mediaType: getMediaType(item),
        extension: item.extension || getItemExtension(item),
      }));
    } else {
      return [];
    }
  }
  if (mode === "videos") {
    return masterQueue.filter((item) => getMediaType(item) === "video");
  }
  if (mode === "documents") {
    return masterQueue.filter((item) => getMediaType(item) === "document");
  }
  return [...masterQueue];
}

function updateBatchStats() {
  syncMasterQueueFromState();

  const stats = {
    total: batchState.queue.length,
    pending: 0,
    running: 0,
    completed: 0,
    errors: 0,
    cancelled: 0,
    videosCount: 0,
    docsCount: 0,
    completedVideos: 0,
    completedDocs: 0,
    pendingVideos: 0,
    pendingDocs: 0,
  };

  for (const item of batchState.queue) {
    const mType = getMediaType(item);
    item.mediaType = mType;
    item.extension = item.extension || getItemExtension(item);

    if (mType === "document") {
      stats.docsCount++;
    } else {
      stats.videosCount++;
    }

    if (item.status === "pending") {
      stats.pending++;
      if (mType === "document") stats.pendingDocs++;
      else stats.pendingVideos++;
    } else if (item.status === "running") {
      stats.running++;
    } else if (item.status === "completed") {
      stats.completed++;
      if (mType === "document") stats.completedDocs++;
      else stats.completedVideos++;
    } else if (item.status === "error") {
      stats.errors++;
    } else if (item.status === "cancelled") {
      stats.cancelled++;
    }
  }

  if (masterQueue.length > 0) {
    let mVids = 0, mDocs = 0, mCompVids = 0, mCompDocs = 0;
    for (const m of masterQueue) {
      const isD = getMediaType(m) === "document";
      if (isD) {
        mDocs++;
        if (m.status === "completed") mCompDocs++;
      } else {
        mVids++;
        if (m.status === "completed") mCompVids++;
      }
    }
    stats.masterTotal = masterQueue.length;
    stats.masterVideosCount = mVids;
    stats.masterDocsCount = mDocs;
    stats.masterCompletedVideos = mCompVids;
    stats.masterCompletedDocs = mCompDocs;
  }

  batchState.stats = stats;
  saveBatchManifest(false);
}

// ---------------------------------------------------------------------------
// Persistência de Manifesto e Detecção Dual de Vídeos Concluídos
// ---------------------------------------------------------------------------

const MANIFEST_WORKSPACE_PATH = path.join(ROOT_DIR, ".agent/batch_manifest.json");
const MANIFEST_FILENAME = "batch_manifest.json";
let manifestSaveTimeout = null;

/**
 * Verifica se um relatório Markdown final de um vídeo existe em disco e é válido (> 150 bytes).
 * Compara nomes normalizados em NFC para suportar acentos no macOS/OneDrive e verifica tanto
 * o caminho canônico quanto caminhos aninhados de execuções legadas.
 */
function checkItemCompletedOnDisk(item, outputDir) {
  const baseOutDir = outputDir || batchState.outputDir;
  if (!baseOutDir || !fs.existsSync(baseOutDir)) return { completed: false };

  const filename = item.filename || item.name || "";
  const baseNameNoExt = path.parse(filename).name;
  if (!baseNameNoExt) return { completed: false };

  const normBaseName = baseNameNoExt.normalize("NFC").toLowerCase();
  const relDir = path.dirname(item.relativePath || "");

  const candidateDirs = [];
  if (item.targetOutputDir) {
    candidateDirs.push(item.targetOutputDir);
  }

  const canonicalDir = relDir && relDir !== "."
    ? path.join(baseOutDir, relDir, baseNameNoExt)
    : path.join(baseOutDir, baseNameNoExt);
  candidateDirs.push(canonicalDir);

  if (relDir && relDir !== ".") {
    candidateDirs.push(path.join(canonicalDir, relDir, baseNameNoExt));
    candidateDirs.push(path.join(baseOutDir, relDir));
  }

  function testFileValid(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const base = path.basename(filePath);
      if (!base.endsWith(".md")) return null;
      const st = fs.statSync(filePath);
      if (st.isFile() && st.size >= 500) {
        return { markdownPath: filePath, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      }
    } catch (_) {}
    return null;
  }

  function searchDirForMd(dirPath) {
    if (!fs.existsSync(dirPath)) return null;
    try {
      const files = fs.readdirSync(dirPath);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const normF = f.normalize("NFC").toLowerCase();
        if (normF.startsWith(normBaseName) || normF.includes("_resumo_") || normF.includes("_rag_") || normF.startsWith("resumo_") || normF.startsWith("rag_")) {
          const full = path.join(dirPath, f);
          const valid = testFileValid(full);
          if (valid) return valid;
        }
      }
    } catch (_) {}
    return null;
  }

  for (const cDir of candidateDirs) {
    const found = searchDirForMd(cDir);
    if (found) return { completed: true, ...found, foundInDir: cDir };
  }

  // Busca recursiva limitada (profundidade até 3) em cada candidato existente
  function walkSearch(currentDir, depth = 0) {
    if (depth > 3 || !fs.existsSync(currentDir)) return null;
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(currentDir, ent.name);
        if (ent.isDirectory()) {
          const res = walkSearch(full, depth + 1);
          if (res) return res;
        } else if (ent.isFile() && ent.name.endsWith(".md")) {
          const normF = ent.name.normalize("NFC").toLowerCase();
          if (normF.startsWith(normBaseName) || normF.includes(normBaseName)) {
            const valid = testFileValid(full);
            if (valid) return { ...valid, foundInDir: currentDir };
          }
        }
      }
    } catch (_) {}
    return null;
  }

  for (const cDir of candidateDirs) {
    const found = walkSearch(cDir, 0);
    if (found) return { completed: true, ...found };
  }

  return { completed: false };
}

function saveBatchManifest(immediate = false) {
  const doSave = () => {
    manifestSaveTimeout = null;
    try {
      syncMasterQueueFromState();
      const itemsToSave = masterQueue.length > 0 ? masterQueue : batchState.queue;

      const manifest = {
        updatedAt: new Date().toISOString(),
        status: batchState.status,
        inputDir: batchState.inputDir,
        outputDir: batchState.outputDir,
        ingestionMode: batchState.ingestionMode || "all",
        parallelism: batchState.parallelism,
        whisperModel: batchState.whisperModel,
        whisperLanguage: batchState.whisperLanguage || "es",
        axetModel: batchState.axetModel || "gpt-5.6-terra",
        videoVisionMode: batchState.videoVisionMode || "vision_ocr",
        startedAt: batchState.startedAt,
        finishedAt: batchState.finishedAt,
        stats: { ...batchState.stats },
        queue: itemsToSave.map((q) => ({
          id: q.id,
          mediaType: getMediaType(q),
          extension: q.extension || getItemExtension(q),
          relativePath: q.relativePath,
          filename: q.filename,
          sizeBytes: q.sizeBytes,
          allocatedBytes: q.allocatedBytes != null ? q.allocatedBytes : 0,
          isHydrated: !!q.isHydrated,
          isOnlineOnly: !!q.isOnlineOnly,
          targetOutputDir: q.targetOutputDir,
          markdownPath: q.markdownPath || null,
          status: q.status,
          runId: q.runId,
          pid: q.pid,
          currentStep: q.currentStep,
          currentStepProgress: q.currentStepProgress,
          currentStepMessage: q.currentStepMessage,
          startedAt: q.startedAt,
          finishedAt: q.finishedAt,
          duration_s: q.duration_s,
          error: q.error,
        })),
      };

      const payload = JSON.stringify(manifest, null, 2);

      // 1. Grava no workspace (.agent/batch_manifest.json)
      try {
        const agentDir = path.join(ROOT_DIR, ".agent");
        if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
        const tmpFile = `${MANIFEST_WORKSPACE_PATH}.tmp_${Date.now()}`;
        fs.writeFileSync(tmpFile, payload, "utf8");
        fs.renameSync(tmpFile, MANIFEST_WORKSPACE_PATH);
      } catch (err) {
        console.error("[manifest] Erro ao gravar .agent/batch_manifest.json:", err.message);
      }

      // 2. Grava na pasta de saída (outputDir/batch_manifest.json)
      if (batchState.outputDir && fs.existsSync(batchState.outputDir)) {
        try {
          const outManifestPath = path.join(batchState.outputDir, MANIFEST_FILENAME);
          const tmpOut = `${outManifestPath}.tmp_${Date.now()}`;
          fs.writeFileSync(tmpOut, payload, "utf8");
          fs.renameSync(tmpOut, outManifestPath);
        } catch (err) {
          console.error("[manifest] Erro ao gravar batch_manifest.json na pasta de saída:", err.message);
        }
      }
    } catch (e) {
      console.error("[manifest] Falha geral ao salvar manifesto:", e.message);
    }
  };

  if (immediate) {
    if (manifestSaveTimeout) {
      clearTimeout(manifestSaveTimeout);
      manifestSaveTimeout = null;
    }
    doSave();
  } else {
    if (!manifestSaveTimeout) {
      manifestSaveTimeout = setTimeout(doSave, 1000);
    }
  }
}

function loadBatchManifest() {
  const candidatePaths = [
    MANIFEST_WORKSPACE_PATH,
    path.join(ROOT_DIR, ".agent/batch_state_snapshot.json"),
    batchState.outputDir ? path.join(batchState.outputDir, MANIFEST_FILENAME) : null,
  ].filter(Boolean);

  let loadedData = null;
  let sourcePath = null;

  for (const cPath of candidatePaths) {
    if (fs.existsSync(cPath)) {
      try {
        const raw = fs.readFileSync(cPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.queue) && parsed.queue.length > 0) {
          loadedData = parsed;
          sourcePath = cPath;
          break;
        }
      } catch (_) {}
    }
  }

  if (!loadedData) return false;

  console.log(`[manifest] Carregando manifesto persistido de ${sourcePath} (${loadedData.queue.length} itens)...`);

  if (loadedData.inputDir && fs.existsSync(loadedData.inputDir)) {
    batchState.inputDir = loadedData.inputDir;
  }
  if (loadedData.outputDir) {
    batchState.outputDir = loadedData.outputDir;
  }
  if (loadedData.ingestionMode) {
    batchState.ingestionMode = loadedData.ingestionMode;
  }
  if (loadedData.parallelism) {
    batchState.parallelism = Math.max(1, Math.min(8, parseInt(loadedData.parallelism, 10)));
  }
  if (loadedData.whisperModel) {
    batchState.whisperModel = loadedData.whisperModel;
  }
  if (loadedData.whisperLanguage) {
    batchState.whisperLanguage = loadedData.whisperLanguage;
  }
  if (loadedData.axetModel) {
    batchState.axetModel = loadedData.axetModel;
  }
  if (loadedData.videoVisionMode) {
    batchState.videoVisionMode = loadedData.videoVisionMode;
  }

  if (loadedData.status === "running") {
    batchState.status = "stopped";
  } else {
    batchState.status = loadedData.status || "idle";
  }
  batchState.startedAt = loadedData.startedAt || null;
  batchState.finishedAt = loadedData.finishedAt || null;

  // Reconcilia cada item com o disco e elimina duplicatas de mesmo nome e tamanho
  masterQueue = deduplicateItems(loadedData.queue.map((q) => {
    const item = { ...q };
    item.mediaType = getMediaType(item);
    item.extension = item.extension || getItemExtension(item);
    if (!item.fullPath && item.relativePath && batchState.inputDir) {
      item.fullPath = path.join(batchState.inputDir, item.relativePath);
    }
    const diskCheck = checkItemCompletedOnDisk(item, batchState.outputDir);
    if (diskCheck.completed || item.status === "completed") {
      item.status = "completed";
      item.currentStep = "concluido";
      item.currentStepProgress = 100;
      if (diskCheck.markdownPath) {
        item.markdownPath = diskCheck.markdownPath;
      }
      if (!item.currentStepMessage || !item.currentStepMessage.includes("Relatório:")) {
        item.currentStepMessage = item.markdownPath
          ? `Relatório validado: ${path.basename(item.markdownPath)}`
          : "Relatório gerado com sucesso";
      }
      item.error = null;
    }
    return item;
  }));

  batchState.queue = filterQueueByMode(batchState.ingestionMode);
  updateBatchStats();
  console.log(`[manifest] Manifesto carregado: ${batchState.stats.completed} concluídos (${batchState.stats.completedVideos} vídeos, ${batchState.stats.completedDocs} docs), ${batchState.stats.pending} pendentes (${batchState.stats.pendingVideos} vídeos, ${batchState.stats.pendingDocs} docs). Total: ${batchState.stats.total} (${batchState.stats.videosCount} vídeos, ${batchState.stats.docsCount} docs).`);
  saveBatchManifest(true);
  return true;
}

// ---------------------------------------------------------------------------
// Telemetria de Armazenamento e Hidratação OneDrive
// ---------------------------------------------------------------------------

const storageTelemetry = {
  diskFreeBytes: 0,
  diskFreeGb: 0,
  diskTotalBytes: 0,
  diskTotalGb: 0,
  diskFreePct: 0,
  tempWorkspaceBytes: 0,
  tempWorkspaceMb: 0,
  inputLogicalBytes: 0,
  inputLogicalGb: 0,
  inputAllocatedBytes: 0,
  inputAllocatedGb: 0,
  hydrationPct: 0,
  onlineOnlyCount: 0,
  hydratedCount: 0,
  totalFilesCount: 0,
  diskSafetyAlert: false,
  isHydrating: false,
  lastAllocatedBytes: 0,
  lastUpdated: null,
};

function getDirectorySizeFast(dirPath) {
  let bytes = 0;
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(dirPath, ent.name);
      if (ent.isDirectory()) {
        bytes += getDirectorySizeFast(p);
      } else if (ent.isFile()) {
        try {
          bytes += fs.statSync(p).size;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return bytes;
}

function updateStorageTelemetry() {
  try {
    // 1. Espaço livre e total no disco local do Mac (SSD)
    if (fs.statfsSync) {
      const rootStat = fs.statfsSync("/");
      const bsize = rootStat.bsize || 4096;
      const freeBytes = (rootStat.bavail || 0) * bsize;
      const totalBytes = (rootStat.blocks || 0) * bsize;
      storageTelemetry.diskFreeBytes = freeBytes;
      storageTelemetry.diskTotalBytes = totalBytes;
      storageTelemetry.diskFreeGb = parseFloat((freeBytes / (1024 ** 3)).toFixed(1));
      storageTelemetry.diskTotalGb = parseFloat((totalBytes / (1024 ** 3)).toFixed(1));
      storageTelemetry.diskFreePct = totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 100) : 0;
      const safetyLimit = Math.max(1, batchState.diskSafetyLimitGb || 3);
      storageTelemetry.safetyThresholdGb = safetyLimit;
      storageTelemetry.diskSafetyAlert = storageTelemetry.diskFreeGb < safetyLimit;
    }
  } catch (err) {
    console.error("[storage] Erro ao obter fs.statfsSync:", err.message);
  }

  try {
    // 2. Tamanho da área temporária de trabalho (/tmp/axet-workspace)
    const tempDir = "/tmp/axet-workspace";
    const tempBytes = getDirectorySizeFast(tempDir);
    storageTelemetry.tempWorkspaceBytes = tempBytes;
    storageTelemetry.tempWorkspaceMb = parseFloat((tempBytes / (1024 * 1024)).toFixed(1));
  } catch (_) {}

  try {
    // 3. Medição de Hidratação do OneDrive / Fila de Entrada
    let totalLogical = 0;
    let totalAllocated = 0;
    let onlineOnly = 0;
    let hydrated = 0;

    for (const q of batchState.queue) {
      const logical = q.sizeBytes || 0;
      totalLogical += logical;
      let allocated = q.allocatedBytes != null ? q.allocatedBytes : 0;

      // Amostra periodicamente o estado do arquivo se o lote estiver em execução ou se não foi amostrado
      if (batchState.status === "running" || q.allocatedBytes == null) {
        try {
          if (fs.existsSync(q.fullPath)) {
            const st = fs.statSync(q.fullPath);
            allocated = (st.blocks || 0) * 512;
            q.allocatedBytes = allocated;
            q.isHydrated = allocated >= (logical * 0.9);
            q.isOnlineOnly = allocated === 0 || allocated < 65536;
          }
        } catch (_) {}
      }

      totalAllocated += allocated;
      if (q.isOnlineOnly || allocated === 0 || (logical > 0 && allocated < logical * 0.1)) {
        onlineOnly++;
      } else {
        hydrated++;
      }
    }

    storageTelemetry.inputLogicalBytes = totalLogical;
    storageTelemetry.inputLogicalGb = parseFloat((totalLogical / (1024 ** 3)).toFixed(2));
    storageTelemetry.inputAllocatedBytes = totalAllocated;
    storageTelemetry.inputAllocatedGb = parseFloat((totalAllocated / (1024 ** 3)).toFixed(2));
    storageTelemetry.hydrationPct = totalLogical > 0 ? parseFloat(((totalAllocated / totalLogical) * 100).toFixed(1)) : 0;
    storageTelemetry.onlineOnlyCount = onlineOnly;
    storageTelemetry.hydratedCount = hydrated;
    storageTelemetry.totalFilesCount = batchState.queue.length;

    // Detecta se novos dados foram hidratados (baixados) pelo OneDrive durante o lote
    if (batchState.status === "running") {
      if (storageTelemetry.lastAllocatedBytes > 0 && totalAllocated > storageTelemetry.lastAllocatedBytes + 10 * 1024 * 1024) {
        storageTelemetry.isHydrating = true;
      } else if (activeBatchWorkers.size === 0) {
        storageTelemetry.isHydrating = false;
      }
      storageTelemetry.lastAllocatedBytes = totalAllocated;
    } else {
      storageTelemetry.isHydrating = false;
    }

    storageTelemetry.lastUpdated = new Date().toISOString();
  } catch (err) {
    console.error("[storage] Erro ao calcular telemetria de hidratação:", err.message);
  }
}

function calculateBatchTelemetry() {
  let totalBytes = 0;
  let completedBytes = 0;
  let completedDurationSeconds = 0;
  let completedCount = 0;
  let runningBytes = 0;
  let runningCount = 0;
  let pendingBytes = 0;
  let pendingCount = 0;

  for (const q of batchState.queue) {
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

  const avgVideoDurationSeconds = completedCount > 0
    ? Math.round(completedDurationSeconds / completedCount)
    : null;

  let etaSeconds = null;
  let estimatedFinishIso = null;
  const isRunning = batchState.status === "running";
  const parallelism = Math.max(1, batchState.parallelism || 2);
  const remainingVideos = pendingCount + runningCount;

  if (batchState.status === "completed" || (totalBytes > 0 && remainingVideos === 0 && completedCount === batchState.queue.length)) {
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
    storage: { ...storageTelemetry },
  };
}

function getBatchSnapshot() {
  const telemetry = calculateBatchTelemetry();
  return {
    status: batchState.status,
    inputDir: batchState.inputDir,
    outputDir: batchState.outputDir,
    ingestionMode: batchState.ingestionMode || "all",
    parallelism: batchState.parallelism,
    whisperModel: batchState.whisperModel,
    whisperLanguage: batchState.whisperLanguage || "es",
    axetModel: batchState.axetModel || "gpt-5.6-terra",
    videoVisionMode: batchState.videoVisionMode || "vision_ocr",
    stats: { ...batchState.stats },
    statusMessage: batchState.statusMessage,
    diskSafetyLimitGb: batchState.diskSafetyLimitGb || 3,
    telemetry,
    storage: { ...storageTelemetry, safetyThresholdGb: batchState.diskSafetyLimitGb || 3 },
    startedAt: batchState.startedAt,
    finishedAt: batchState.finishedAt,
    activeWorkersCount: activeBatchWorkers.size,
    queue: batchState.queue.map((q) => ({
      id: q.id,
      mediaType: getMediaType(q),
      extension: q.extension || getItemExtension(q),
      relativePath: q.relativePath,
      filename: q.filename,
      sizeBytes: q.sizeBytes,
      allocatedBytes: q.allocatedBytes != null ? q.allocatedBytes : 0,
      isHydrated: !!q.isHydrated,
      isOnlineOnly: !!q.isOnlineOnly,
      targetOutputDir: q.targetOutputDir || (q.relativePath ? path.join(batchState.outputDir, path.dirname(q.relativePath), path.parse(q.filename).name) : path.join(batchState.outputDir, path.parse(q.filename).name)),
      markdownPath: q.markdownPath || null,
      status: q.status,
      runId: q.runId,
      pid: q.pid,
      currentStep: q.currentStep || null,
      currentStepProgress: q.currentStepProgress != null ? q.currentStepProgress : null,
      currentStepMessage: q.currentStepMessage || null,
      startedAt: q.startedAt,
      finishedAt: q.finishedAt,
      duration_s: q.duration_s,
      error: q.error,
    })),
  };
}

let batchBroadcastTimer = null;
let lastBatchBroadcastTs = 0;
const BATCH_BROADCAST_THROTTLE_MS = 1000;

function broadcastBatchState(immediate = false) {
  if (immediate) {
    if (batchBroadcastTimer) {
      clearTimeout(batchBroadcastTimer);
      batchBroadcastTimer = null;
    }
    lastBatchBroadcastTs = Date.now();
    broadcast({
      type: "batch_update",
      batch: getBatchSnapshot(),
      ts: new Date().toISOString(),
    });
    return;
  }

  if (batchBroadcastTimer) return;

  const now = Date.now();
  const elapsed = now - lastBatchBroadcastTs;
  if (elapsed >= BATCH_BROADCAST_THROTTLE_MS) {
    lastBatchBroadcastTs = now;
    broadcast({
      type: "batch_update",
      batch: getBatchSnapshot(),
      ts: new Date().toISOString(),
    });
  } else {
    batchBroadcastTimer = setTimeout(() => {
      batchBroadcastTimer = null;
      lastBatchBroadcastTs = Date.now();
      broadcast({
        type: "batch_update",
        batch: getBatchSnapshot(),
        ts: new Date().toISOString(),
      });
    }, BATCH_BROADCAST_THROTTLE_MS - elapsed);
  }
}

function linkRunToBatchItem(runId, videoName, pid) {
  if (!videoName || batchState.status !== "running") return;
  const item = batchState.queue.find(
    (q) => q.status === "running" && q.filename === videoName && (!q.runId || q.runId === runId)
  );
  if (item) {
    item.runId = runId;
    if (pid && !item.pid) item.pid = pid;
    const run = runs.get(runId);
    if (run) {
      run.media_type = item.mediaType || getMediaType(item);
    }
    broadcastBatchState(false);
  }
}

function updateBatchItemStep(runId, step, progressPct, message, shouldBroadcast = false) {
  if (!runId || !step) return;
  const item = batchState.queue.find((q) => q.runId === runId);
  if (item && item.status === "running") {
    item.currentStep = step;
    if (progressPct != null) item.currentStepProgress = progressPct;
    if (message != null) item.currentStepMessage = message;
    if (shouldBroadcast) {
      broadcastBatchState(false);
    }
  }
}

function finishBatchItemFromRun(runId, status, duration_s) {
  if (!runId) return;
  const item = batchState.queue.find((q) => q.runId === runId);
  if (item && item.status === "running") {
    if (status === "success") {
      item.status = "completed";
      item.currentStep = "concluido";
      item.currentStepProgress = 100;
      const diskCheck = checkItemCompletedOnDisk(item, batchState.outputDir);
      if (diskCheck.completed && diskCheck.markdownPath) {
        item.markdownPath = diskCheck.markdownPath;
      }
    } else if (status === "error") {
      item.status = "error";
    } else if (status === "cancelled") {
      item.status = "cancelled";
    }
    if (duration_s != null) item.duration_s = duration_s;
    item.finishedAt = new Date().toISOString();
    updateBatchStats();
    saveBatchManifest(true);
    broadcastBatchState();
  }
}

function pumpBatchQueue() {
  if (batchState.status !== "running") return;

  // Atualiza telemetria de armazenamento antes de despachar
  updateStorageTelemetry();

  // REGRA GLOBAL DE SALVAGUARDA DE DISCO (DISK_FREE_MINIMUM_GB = 3 GB):
  // Se o SSD do Mac estiver com menos de 3 GB livres, pausa novos downloads/despachos
  // para garantir a estabilidade do sistema e evitar esgotamento de disco.
  const DISK_FREE_MINIMUM_GB = Math.max(1, batchState.diskSafetyLimitGb || 3);
  if (storageTelemetry.diskFreeGb > 0 && storageTelemetry.diskFreeGb < DISK_FREE_MINIMUM_GB) {
    storageTelemetry.diskSafetyAlert = true;
    batchState.statusMessage = `Pausado: SSD com ${storageTelemetry.diskFreeGb} GB livres (mínimo de segurança: ${DISK_FREE_MINIMUM_GB} GB).`;
    console.warn(`[STORAGE SAFETY] Espaço livre em disco no Mac está abaixo de ${DISK_FREE_MINIMUM_GB} GB (${storageTelemetry.diskFreeGb} GB livres). Pausando novos despachos.`);
    broadcastBatchState();
    return;
  }
  if (batchState.statusMessage && batchState.statusMessage.includes("salvaguarda de SSD")) {
    batchState.statusMessage = null;
  }

  const freeSlots = Math.max(0, batchState.parallelism - activeBatchWorkers.size);
  if (freeSlots <= 0) return;

  const currentMode = batchState.ingestionMode || "all";
  for (let i = 0; i < freeSlots; i++) {
    if (activeBatchWorkers.size >= batchState.parallelism) break;
    const nextItem = batchState.queue.find((item) => {
      if (item.status !== "pending") return false;
      const mType = getMediaType(item);
      if (currentMode === "videos" && mType !== "video") return false;
      if (currentMode === "documents" && mType !== "document") return false;
      return true;
    });

    if (!nextItem) {
      if (activeBatchWorkers.size === 0) {
        batchState.status = "completed";
        batchState.finishedAt = new Date().toISOString();
        updateBatchStats();
        broadcastBatchState();
      }
      break;
    }

    startWorkerForItem(nextItem);
  }
}

function startWorkerForItem(item) {
  item.status = "running";
  item.startedAt = new Date().toISOString();
  item.error = null;

  if (!item.fullPath && item.relativePath && batchState.inputDir) {
    item.fullPath = path.join(batchState.inputDir, item.relativePath);
  }

  // Espelha a estrutura de pastas e cria pasta dedicada com o nome do vídeo
  const relativeDir = path.dirname(item.relativePath || "");
  const videoFolderName = path.parse(item.filename || item.name || "").name;
  const targetOutputDir = relativeDir && relativeDir !== "."
    ? path.join(batchState.outputDir, relativeDir, videoFolderName)
    : path.join(batchState.outputDir, videoFolderName);

  try {
    if (!fs.existsSync(targetOutputDir)) {
      fs.mkdirSync(targetOutputDir, { recursive: true });
    }
  } catch (err) {
    console.error(`[batch] Erro ao criar subpasta espelhada de saída ${targetOutputDir}:`, err);
  }
  item.targetOutputDir = targetOutputDir;

  updateBatchStats();
  broadcastBatchState();

  const ext = path.extname(item.filename || "").toLowerCase();
  const isDoc = item.mediaType === "document" || DOCUMENT_EXTENSIONS.has(ext);
  const scriptPath = isDoc
    ? path.join(ROOT_DIR, "scripts/process_document.sh")
    : path.join(ROOT_DIR, "scripts/process_video.sh");

  const whisperLang = batchState.whisperLanguage || "es";
  const args = isDoc
    ? [item.fullPath, batchState.axetModel || "gpt-5.6-terra"]
    : [item.fullPath, batchState.whisperModel, whisperLang];

  const env = {
    ...process.env,
    OUTPUT_DIR: targetOutputDir,
    INPUT_DIR: batchState.inputDir,
    AXET_MODEL: batchState.axetModel || "gpt-5.6-terra",
    VIDEO_VISION_MODE: batchState.videoVisionMode || "vision_ocr",
    LLM_GATEWAY_URL: process.env.LLM_GATEWAY_URL || "http://localhost:8766",
    DASHBOARD_PORT: String(PORT),
    PYTHONUNBUFFERED: "1",
  };

  const bashBin = fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
  const child = spawn(bashBin, [scriptPath, ...args], {
    cwd: ROOT_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const workerId = `w_${Date.now()}_${child.pid}`;
  item.pid = child.pid;

  activeBatchWorkers.set(workerId, {
    item,
    pid: child.pid,
    child,
    workerId,
  });

  let stderrBuffer = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer = (stderrBuffer + text).slice(-8192);
    console.error(`[worker ${item.id} stderr]:`, text.trim());
  });

  child.on("close", (code, signal) => {
    activeBatchWorkers.delete(workerId);
    if (!item.finishedAt) {
      item.finishedAt = new Date().toISOString();
      if (item.startedAt) {
        item.duration_s = Math.round((new Date(item.finishedAt) - new Date(item.startedAt)) / 1000);
      }
    }

    if (item.status === "cancelled" || signal === "SIGTERM" || signal === "SIGKILL") {
      item.status = "cancelled";
    } else if (code === 0) {
      item.status = "completed";
      item.currentStep = "concluido";
      item.currentStepProgress = 100;
      const diskCheck = checkItemCompletedOnDisk(item, batchState.outputDir);
      if (diskCheck.completed && diskCheck.markdownPath) {
        item.markdownPath = diskCheck.markdownPath;
      }
    } else if (item.status === "running") {
      item.status = "error";
      const cleanErr = stderrBuffer.trim().split("\n").filter(Boolean).pop();
      item.error = cleanErr || `Processo encerrou com código ${code}`;
    }

    updateBatchStats();
    saveBatchManifest(true);
    broadcastBatchState();

    if (batchState.status === "running") {
      pumpBatchQueue();
    } else if (batchState.status === "stopping" && activeBatchWorkers.size === 0) {
      batchState.status = "stopped";
      batchState.finishedAt = new Date().toISOString();
      updateBatchStats();
      saveBatchManifest(true);
      broadcastBatchState();
    }
  });

  child.on("error", (err) => {
    activeBatchWorkers.delete(workerId);
    item.status = "error";
    item.error = err.message;
    item.finishedAt = new Date().toISOString();
    updateBatchStats();
    saveBatchManifest(true);
    broadcastBatchState();
    if (batchState.status === "running") {
      pumpBatchQueue();
    }
  });
}

function stopBatch() {
  console.log("[batch] Interrupção de emergência solicitada. Encerrando todos os processos...");
  batchState.status = "stopped";
  batchState.finishedAt = new Date().toISOString();

  // 1. Cancela todos os itens na fila (pendentes e em execução)
  for (const item of batchState.queue) {
    if (item.status === "pending" || item.status === "running") {
      item.status = "cancelled";
    }
  }

  // 2. Encerra imediatamente todos os workers ativos do lote com SIGTERM seguido de SIGKILL
  for (const [, worker] of activeBatchWorkers.entries()) {
    if (worker.item) worker.item.status = "cancelled";
    if (worker.pid) {
      try {
        killProcessTree(worker.pid, "SIGKILL");
      } catch (_) {}
    }
    if (worker.child) {
      try {
        worker.child.kill("SIGKILL");
      } catch (_) {}
    }
  }
  activeBatchWorkers.clear();

  // 3. Encerra e marca como cancelados quaisquer runs ativos no cockpit
  const now = new Date().toISOString();
  for (const [runId, run] of runs.entries()) {
    if (run.status === "running") {
      if (run.pid) {
        try {
          killProcessTree(run.pid, "SIGKILL");
        } catch (_) {}
      }
      run.status = "cancelled";
      run.finished_at = now;
      const endEvt = {
        run_id: runId,
        type: "run_end",
        status: "cancelled",
        ts: now,
        duration_s: 0,
        message: "Lote interrompido pelo usuário",
      };
      broadcast(endEvt);
    }
  }

  // 4. Mata qualquer subprocesso órfão do pipeline restante no sistema operacional
  try {
    execSync('pkill -9 -f "process_video.sh" 2>/dev/null || true');
    execSync('pkill -9 -f "process_document.sh" 2>/dev/null || true');
    execSync('pkill -9 -f "extract_document.py" 2>/dev/null || true');
    execSync('pkill -9 -f "whisper-cli" 2>/dev/null || true');
    execSync('pkill -9 -f "axet-code run" 2>/dev/null || true');
    execSync('pkill -9 -f "ffmpeg -y -i" 2>/dev/null || true');
  } catch (_) {}

  updateBatchStats();
  saveBatchManifest(true);
  broadcastBatchState();
  console.log("[batch] Lote totalmente interrompido com sucesso.");
}

function getOrCreateRun(runId) {
  if (!runs.has(runId)) {
    runs.set(runId, {
      run_id: runId,
      video: null,
      media_type: null,
      whisper_model: null,
      axet_model: null,
      started_at: new Date().toISOString(),
      status: "running",
      finished_at: null,
      duration_total_s: null,
      pid: null,
      steps: {},
      logs: [],
      last_event_at: Date.now(),
    });
    runOrder.push(runId);
    // limita histórico
    while (runOrder.length > MAX_HISTORY) {
      const oldest = runOrder.shift();
      runs.delete(oldest);
    }
  }
  return runs.get(runId);
}

function checkStaleRuns() {
  const now = Date.now();
  for (const [runId, run] of runs) {
    if (run.status !== "running") continue;
    const lastEvent = run.last_event_at || 0;
    const elapsed = now - lastEvent;

    let isStale = false;
    let staleReason = "";

    if (run.pid) {
      const alive = isProcessAlive(run.pid);
      if (alive) {
        // Processo comprovadamente vivo no sistema operacional:
        // NÃO marcamos erro por timeout curto (Whisper/Axet em CPU).
        // Só marcamos se ultrapassar o teto máximo de segurança (MAX_ALIVE_TIMEOUT_MS).
        if (elapsed > MAX_ALIVE_TIMEOUT_MS) {
          isStale = true;
          staleReason = `Processo vivo (PID ${run.pid}), mas sem atividade por mais de ${Math.round(MAX_ALIVE_TIMEOUT_MS / 60000)} minutos`;
        }
      } else {
        // PID registrado, mas o processo NÃO existe mais no SO (morreu sem emitir run_end).
        if (elapsed > DEAD_PROCESS_GRACE_MS) {
          isStale = true;
          staleReason = `Processo (PID ${run.pid}) encerrou inesperadamente no SO`;
        }
      }
    } else {
      // Sem PID registrado: aguarda o timeout padrão
      if (elapsed > STALE_TIMEOUT_MS) {
        isStale = true;
        staleReason = `Run sem atividade por mais de ${Math.round(STALE_TIMEOUT_MS / 1000)}s`;
      }
    }

    if (isStale) {
      const timestamp = new Date().toISOString();
      run.status = "error";
      run.finished_at = timestamp;
      run.duration_total_s = run.started_at
        ? (new Date(timestamp) - new Date(run.started_at)) / 1000
        : null;

      for (const stepKey of Object.keys(run.steps)) {
        if (run.steps[stepKey].status === "running") {
          run.steps[stepKey].status = "error";
          run.steps[stepKey].finished_at = timestamp;
          run.steps[stepKey].detalhes = `Timeout (watchdog): ${staleReason}`;
        }
      }

      run.logs.push({
        ts: timestamp,
        level: "ERROR",
        step: null,
        message: `Watchdog: ${staleReason} — marcado como falho.`,
      });
      while (run.logs.length > MAX_LOG_LINES_PER_RUN) {
        run.logs.shift();
      }

      const logEvt = {
        run_id: runId,
        type: "log",
        level: "ERROR",
        message: `Watchdog: ${staleReason} — marcado como falho.`,
        ts: timestamp,
      };
      broadcast(logEvt);

      const endEvt = {
        run_id: runId,
        type: "run_end",
        status: "error",
        duration_s: run.duration_total_s,
        ts: timestamp,
      };
      broadcast(endEvt);
    }
  }
}

setInterval(checkStaleRuns, STALE_CHECK_INTERVAL_MS);

// Amostra e transmite métricas de CPU e Memória a cada 1.5s
setInterval(() => {
  if (sseClients.size > 0) {
    const metrics = getSystemMetrics();
    broadcast({
      type: "system_metrics",
      metrics,
    });
  }
}, 1500);

// Amostra e atualiza telemetria de Armazenamento e Hidratação OneDrive a cada 3s
setInterval(() => {
  updateStorageTelemetry();
  if (sseClients.size > 0 && batchState.queue.length > 0) {
    broadcastBatchState();
  }
}, 3000);

// Watchdog da fila do lote: a cada 5s, se o lote estiver em execução e houver slots livres
// com itens pendentes, aciona pumpBatchQueue() para evitar starvation caso os workers
// tenham chegado a zero durante salvaguarda de disco ou pausas temporárias.
setInterval(() => {
  if (batchState.status === "running" && activeBatchWorkers.size < batchState.parallelism) {
    const hasPending = batchState.queue.some((item) => item.status === "pending");
    if (hasPending) {
      pumpBatchQueue();
    }
  }
}, 5000);

function broadcast(event) {
  let payload = null;
  for (const res of sseClients) {
    try {
      // Proteção de memória / backpressure: se o cliente SSE estiver acumulando buffer no socket
      // (ex: navegador ocupado ou conexão lenta), descarta frames repetitivos para não causar OOM
      if (res.socket && typeof res.socket.writableLength === "number" && res.socket.writableLength > 512 * 1024) {
        if (event.type === "step_progress" || event.type === "batch_update") {
          continue;
        }
      }
      if (!payload) {
        payload = `data: ${JSON.stringify(event)}\n\n`;
      }
      res.write(payload);
    } catch (_) {
      /* cliente desconectado, será limpo no 'close' */
    }
  }
}

function applyEvent(evt) {
  const {
    run_id,
    type, // 'run_start' | 'step_start' | 'step_end' | 'log' | 'run_end'
    step,
    status, // 'running' | 'success' | 'error'
    ts,
    duration_s,
    message,
    level,
    video,
    whisper_model,
    axet_model,
  } = evt;

  if (!run_id) return;
  const run = getOrCreateRun(run_id);
  const timestamp = ts || new Date().toISOString();
  run.last_event_at = Date.now();

  // Auto-recuperação (Self-Healing):
  // Se o run havia sido marcado como "error" pelo watchdog (falso alarme),
  // mas recebemos atividade legítima do pipeline (novo step, progresso, log, heartbeat),
  // restauramos imediatamente o status para "running"!
  const isRevivalEvent =
    type === "step_start" ||
    type === "step_progress" ||
    type === "step_end" ||
    type === "heartbeat" ||
    (type === "log" && level !== "ERROR");

  if (run.status === "error" && isRevivalEvent) {
    run.status = "running";
    run.finished_at = null;
    run.duration_total_s = null;
    for (const stepKey of Object.keys(run.steps)) {
      if (run.steps[stepKey].status === "error" && (run.steps[stepKey].detalhes || "").includes("Timeout (watchdog)")) {
        run.steps[stepKey].status = "running";
        run.steps[stepKey].finished_at = null;
        run.steps[stepKey].detalhes = null;
      }
    }
    if (step && run.steps[step] && run.steps[step].status === "error") {
      run.steps[step].status = "running";
      run.steps[step].finished_at = null;
      run.steps[step].detalhes = null;
    }
    const reviveEvt = {
      run_id: run_id,
      type: "run_status",
      status: "running",
      ts: timestamp,
    };
    broadcast(reviveEvt);
  }

  switch (type) {
    case "heartbeat":
      // apenas atualiza last_event_at (já realizado acima)
      break;

    case "run_status":
      run.status = evt.status || run.status;
      if (run.status === "running") {
        run.finished_at = null;
        run.duration_total_s = null;
      }
      break;
    case "run_start":
      run.video = video || run.video;
      run.whisper_model = whisper_model || run.whisper_model;
      run.axet_model = axet_model || run.axet_model;
      run.media_type = evt.media_type || (run.video ? getMediaType({ filename: run.video }) : null) || run.media_type || "video";
      if (evt.pid != null) {
        run.pid = typeof evt.pid === "number" ? evt.pid : parseInt(evt.pid, 10);
      }
      run.status = "running";
      run.started_at = timestamp;
      linkRunToBatchItem(run_id, run.video, run.pid);
      break;

    case "step_start":
      if (step === "extracao_documento") {
        run.media_type = "document";
      } else if (step === "extracao_audio" || step === "transcricao_whisper") {
        run.media_type = "video";
      }
      run.steps[step] = run.steps[step] || {};
      run.steps[step].status = "running";
      run.steps[step].started_at = timestamp;
      run.steps[step].finished_at = null;
      run.steps[step].duration_s = null;
      run.steps[step].progress_pct = 0;
      if (message || evt.detalhes) {
        run.steps[step].detalhes = message || evt.detalhes;
      }
      updateBatchItemStep(run_id, step, 0, message || evt.detalhes || null, true);
      break;

    case "step_progress":
      run.steps[step] = run.steps[step] || {};
      run.steps[step].progress_pct = evt.pct != null ? evt.pct : run.steps[step].progress_pct;
      if (message || evt.detalhes) {
        run.steps[step].detalhes = message || evt.detalhes;
      }
      // Atualiza estado local na memória do item, mas NÃO dispara broadcastBatchState completo a cada timestamp
      updateBatchItemStep(run_id, step, run.steps[step].progress_pct, run.steps[step].detalhes || null, false);
      break;

    case "step_end":
      run.steps[step] = run.steps[step] || {};
      run.steps[step].status = status || "success";
      run.steps[step].finished_at = timestamp;
      run.steps[step].duration_s = duration_s != null ? duration_s : null;
      run.steps[step].detalhes = message || null;
      run.steps[step].progress_pct = 100;
      updateBatchItemStep(run_id, step, 100, message || null, true);
      break;

    case "log":
      run.logs.push({
        ts: timestamp,
        level: level || "INFO",
        step: step || null,
        message: message || "",
      });
      while (run.logs.length > MAX_LOG_LINES_PER_RUN) {
        run.logs.shift();
      }
      break;

    case "run_pid":
      if (evt.pid != null) {
        run.pid = typeof evt.pid === "number" ? evt.pid : parseInt(evt.pid, 10);
        linkRunToBatchItem(run_id, run.video, run.pid);
      }
      break;

    case "run_end":
      run.status = status || "success";
      run.finished_at = timestamp;
      run.duration_total_s = duration_s != null ? duration_s : null;
      finishBatchItemFromRun(run_id, run.status, run.duration_total_s);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Servidor de arquivos estáticos simples
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function serveStatic(filename, res) {
  const filePath = path.join(PUBLIC_DIR, filename);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req, cb) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 5 * 1024 * 1024) {
      req.destroy(); // proteção simples contra payloads gigantes
    }
  });
  req.on("end", () => cb(body));
}

// ---------------------------------------------------------------------------
// Handler HTTP
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS simples (permite chamar de qualquer origem local)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Rota estática de logos da NTT DATA
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/logos/")) {
    const filename = pathname.replace(/^\/logos\//, "");
    const logoPath = path.join(ROOT_DIR, "logos", filename);
    fs.readFile(logoPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Logo não encontrado");
        return;
      }
      const ext = path.extname(logoPath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "image/png" });
      res.end(data);
    });
    return;
  }

  // Favicon
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/favicon.ico" || pathname === "/favicon.png")) {
    const favPath = path.join(ROOT_DIR, "logos", pathname.slice(1));
    fs.readFile(favPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const ext = path.extname(favPath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "image/x-icon" });
      res.end(data);
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
    serveStatic("index.html", res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/app.js" || pathname === "/style.css")) {
    serveStatic(pathname.slice(1), res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/state") {
    // Sincroniza itens completados/com erro de batchState.queue que ainda não estejam no mapa runs
    if (batchState.queue && Array.isArray(batchState.queue)) {
      for (const item of batchState.queue) {
        if (item.status === "completed" || item.status === "error") {
          const runId = item.runId || `item_${item.id}`;
          if (!runs.has(runId)) {
            const ext = path.extname(item.filename || "").toLowerCase();
            const isDoc = item.mediaType === "document" || DOCUMENT_EXTENSIONS.has(ext);
            runs.set(runId, {
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
              axet_model: batchState.axetModel || "gpt-5.6-terra",
              whisper_model: batchState.whisperModel || "small",
              steps: {
                extracao_audio: { status: isDoc ? "skipped" : "success", duration_s: 1 },
                transcricao_whisper: { status: isDoc ? "skipped" : "success", duration_s: Math.round((item.duration_s || 30) * 0.4) },
                extracao_documento: { status: isDoc ? "success" : "skipped", duration_s: 1 },
                interpretacao_axet: { status: item.status === "error" ? "error" : "success", duration_s: Math.round((item.duration_s || 30) * 0.5) },
                geracao_markdown: { status: item.status === "error" ? "error" : "success", duration_s: 1 },
              },
              fromBatchQueue: true,
            });
            if (!runOrder.includes(runId)) {
              runOrder.push(runId);
            }
          }
        }
      }
    }

    const snapshot = {
      order: runOrder,
      runs: Object.fromEntries(runs),
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(snapshot));
    return;
  }

  // Endpoints de Autenticação Corporativa Okta SSO & API Gateway
  function decodeJwtPayload(token) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const raw = Buffer.from(parts[1], "base64url").toString("utf-8");
      return JSON.parse(raw);
    } catch (_) {
      try {
        const raw = Buffer.from(parts[1], "base64").toString("utf-8");
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    }
  }

  async function resolveOktaIdentity() {
    const home = os.homedir();
    const localIdFile = path.join(__dirname, "..", "gateway", "user_identity.json");
    const localTokFile = path.join(__dirname, "..", "gateway", "tokens.json");
    const externalIdFile = path.join(home, "dev/local-ai-gateway/gateway/user_identity.json");
    const externalTokFile = path.join(home, "dev/local-ai-gateway/gateway/tokens.json");

    const idFile = fs.existsSync(localIdFile) ? localIdFile : externalIdFile;
    const tokFile = fs.existsSync(localTokFile) ? localTokFile : externalTokFile;

    let identityData = {};
    let tokenData = {};
    let accessClaims = null;
    let idClaims = null;

    try {
      if (fs.existsSync(idFile)) {
        identityData = JSON.parse(fs.readFileSync(idFile, "utf-8"));
      }
    } catch (_) {}

    try {
      if (fs.existsSync(tokFile)) {
        tokenData = JSON.parse(fs.readFileSync(tokFile, "utf-8"));
        accessClaims = decodeJwtPayload(tokenData.access_token);
        idClaims = decodeJwtPayload(tokenData.id_token);
      }
    } catch (_) {}

    let name = (idClaims && idClaims.name) ||
               (accessClaims && (accessClaims.displayName || (accessClaims.firstName ? `${accessClaims.firstName} ${accessClaims.lastName || ""}`.trim() : null))) ||
               identityData.display_name;

    let email = (accessClaims && accessClaims.email) ||
                identityData.email;

    let login = (accessClaims && accessClaims.login) ||
                identityData.login ||
                (idClaims && idClaims.preferred_username);

    let oktaId = (accessClaims && accessClaims.okta_id) ||
                 identityData.okta_id ||
                 (idClaims && idClaims.sub);

    let employeeNumber = (accessClaims && accessClaims.employeeNumber);
    let tenant = (accessClaims && accessClaims.okta_tenant) || "onentt";
    let region = (accessClaims && accessClaims.region) || "emeal-onentt";

    if (!name) {
      try {
        const gitName = execSync("git config user.name", { encoding: "utf-8" }).trim();
        if (gitName) name = gitName;
      } catch (_) {}
    }
    if (!email) {
      try {
        const gitEmail = execSync("git config user.email", { encoding: "utf-8" }).trim();
        if (gitEmail) email = gitEmail;
      } catch (_) {}
    }
    if (!name) name = "Gustavo Costa Berbert";
    if (!email) email = "gustavo.costa.berbert@nttdata.com";
    if (!login) login = "gcostabe@emeal.nttdata.com";
    if (!oktaId) oktaId = "00u9pq4pchFsGiPHG417";

    let gateway8766Online = false;
    let remainingSeconds = 0;
    let expiresAtIso = null;

    if (accessClaims && accessClaims.exp) {
      remainingSeconds = Math.max(0, accessClaims.exp - Math.floor(Date.now() / 1000));
      expiresAtIso = new Date(accessClaims.exp * 1000).toISOString();
    }

    try {
      const gwRes = await fetch("http://127.0.0.1:8766/auth/status", { signal: AbortSignal.timeout(1200) });
      if (gwRes.ok) {
        const gwData = await gwRes.json();
        gateway8766Online = (gwData.status === "ok" && gwData.authenticated);
        if (typeof gwData.remaining_seconds === "number") {
          remainingSeconds = gwData.remaining_seconds;
        }
        if (gwData.expires_at) {
          expiresAtIso = new Date(gwData.expires_at * 1000).toISOString();
        }
      }
    } catch (_) {}

    let gateway3001Online = false;
    try {
      const res3001 = await fetch("http://127.0.0.1:3001/", { method: "HEAD", signal: AbortSignal.timeout(1200) });
      gateway3001Online = res3001.ok;
    } catch (_) {}

    return {
      ok: true,
      authenticated: true,
      user: {
        name,
        firstName: (accessClaims && accessClaims.firstName) || name.split(" ")[0],
        lastName: (accessClaims && accessClaims.lastName) || name.split(" ").slice(1).join(" "),
        email,
        login,
        oktaId,
        employeeNumber,
        tenant,
        region,
        org: "NTT DATA EMEAL",
        role: "RAG Pipeline Architect",
      },
      provider: "okta",
      ssoActive: true,
      gateway: {
        port: 3001,
        url: "http://localhost:3001",
        gatewayHostUrl: "http://localhost:8766",
        status: (gateway8766Online || gateway3001Online) ? "connected" : "standalone",
        gateway8766Online,
        gateway3001Online,
        remainingSeconds,
        autoRefresh: true,
      },
      expiresAt: expiresAtIso || new Date(Date.now() + 86400000).toISOString(),
      lastSync: new Date().toISOString(),
    };
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/auth/status") {
    resolveOktaIdentity().then((authStatus) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(authStatus));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/refresh") {
    resolveOktaIdentity().then((authStatus) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        refreshed: true,
        ...authStatus,
        timestamp: new Date().toISOString(),
      }));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    });
    return;
  }

  // Abrir pasta no Finder / Sistema Operacional
  if (req.method === "POST" && pathname === "/api/fs/open") {
    readBody(req, (body) => {
      let data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (_) {}
      const targetPath = data.path || batchState.outputDir;
      if (targetPath && fs.existsSync(targetPath)) {
        try {
          spawn("open", [targetPath], { detached: true, stdio: "ignore" }).unref();
        } catch (_) {}
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, path: targetPath }));
    });
    return;
  }

  if (req.method === "GET" && pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    sseClients.add(res);

    // envia estado inicial do batch e métricas do sistema para clientes recém-conectados
    try {
      res.write(`data: ${JSON.stringify({ type: "batch_update", batch: getBatchSnapshot(), ts: new Date().toISOString() })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "system_metrics", metrics: getSystemMetrics() })}\n\n`);
    } catch (_) {}

    // heartbeat para manter a conexão viva através de proxies
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch (_) {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  // -------------------------------------------------------------------------
  // APIs do Processamento em Lote (Batch) e Sistema de Arquivos
  // -------------------------------------------------------------------------

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/system/metrics") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, metrics: getSystemMetrics() }));
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/axet/models") {
    const models = getAvailableAxetModels();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, models }));
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/batch/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, batch: getBatchSnapshot() }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/batch/config") {
    readBody(req, (body) => {
      let data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (_) {}

      if (data.outputDir) {
        batchState.outputDir = path.resolve(data.outputDir);
      }
      if (data.ingestionMode && ["all", "videos", "documents"].includes(data.ingestionMode)) {
        batchState.ingestionMode = data.ingestionMode;
      }
      if (data.inputDir) {
        batchState.inputDir = path.resolve(data.inputDir);
      }
      if (data.parallelism) {
        batchState.parallelism = Math.max(1, Math.min(8, parseInt(data.parallelism, 10)));
      }
      if (data.whisperModel) {
        batchState.whisperModel = String(data.whisperModel).trim();
      }
      if (data.whisperLanguage) {
        batchState.whisperLanguage = String(data.whisperLanguage).trim().toLowerCase();
      }
      if (data.axetModel) {
        batchState.axetModel = String(data.axetModel).trim();
      }
      if (data.videoVisionMode && ["vision_ocr", "audio_only"].includes(data.videoVisionMode)) {
        batchState.videoVisionMode = data.videoVisionMode;
      }
      if (data.diskSafetyLimitGb != null) {
        batchState.diskSafetyLimitGb = Math.max(1, parseFloat(data.diskSafetyLimitGb) || 3);
      }

      if (batchState.status !== "running") {
        batchState.queue = filterQueueByMode(batchState.ingestionMode);
        updateBatchStats();
      }

      saveBatchManifest(true);
      broadcastBatchState();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, batch: getBatchSnapshot() }));
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/batch/scan") {
    readBody(req, (body) => {
      let data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (_) {}
      const targetDir = path.resolve(data.inputDir || batchState.inputDir || path.join(ROOT_DIR, "videos"));
      if (!fs.existsSync(targetDir)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: `Diretório não encontrado: ${targetDir}` }));
        return;
      }
      if (data.ingestionMode && ["all", "videos", "documents"].includes(data.ingestionMode)) {
        batchState.ingestionMode = data.ingestionMode;
      }
      const mode = data.ingestionMode || batchState.ingestionMode || "all";
      const scannedFiles = scanFilesRecursively(targetDir, targetDir, mode);
      batchState.inputDir = targetDir;

      // Mapeia histórico existente por caminho relativo normalizado (NFC)
      const existingMap = new Map();
      const allExisting = masterQueue.length > 0 ? masterQueue : batchState.queue;
      for (const item of allExisting) {
        if (item.relativePath) {
          existingMap.set(item.relativePath.normalize("NFC"), item);
        }
      }

      let completedCount = 0;
      let pendingCount = 0;

      const scannedItems = deduplicateItems(scannedFiles.map((v) => {
        const normRel = (v.relativePath || "").normalize("NFC");
        const existing = existingMap.get(normRel);
        const diskCheck = checkItemCompletedOnDisk(v, batchState.outputDir);
        const isCompleted = diskCheck.completed || (existing && existing.status === "completed");
        const mediaType = getMediaType(v);
        const extension = v.extension || getItemExtension(v);

        if (isCompleted) {
          completedCount++;
          return {
            id: v.id,
            mediaType,
            extension,
            relativePath: v.relativePath,
            fullPath: v.fullPath,
            filename: v.filename,
            sizeBytes: v.sizeBytes,
            allocatedBytes: v.allocatedBytes || 0,
            isHydrated: !!v.isHydrated,
            isOnlineOnly: !!v.isOnlineOnly,
            targetOutputDir: existing ? existing.targetOutputDir : null,
            markdownPath: diskCheck.markdownPath || (existing ? existing.markdownPath : null),
            status: "completed",
            runId: existing ? existing.runId : null,
            pid: null,
            currentStep: "concluido",
            currentStepProgress: 100,
            currentStepMessage: diskCheck.markdownPath
              ? `Relatório validado: ${path.basename(diskCheck.markdownPath)}`
              : (existing && existing.currentStepMessage ? existing.currentStepMessage : "Relatório validado no disco"),
            startedAt: existing ? existing.startedAt : null,
            finishedAt: existing ? existing.finishedAt : null,
            duration_s: existing ? existing.duration_s : null,
            error: null,
          };
        } else {
          pendingCount++;
          return {
            id: v.id,
            mediaType,
            extension,
            relativePath: v.relativePath,
            fullPath: v.fullPath,
            filename: v.filename,
            sizeBytes: v.sizeBytes,
            allocatedBytes: v.allocatedBytes || 0,
            isHydrated: !!v.isHydrated,
            isOnlineOnly: !!v.isOnlineOnly,
            targetOutputDir: existing ? existing.targetOutputDir : null,
            markdownPath: null,
            status: "pending",
            runId: null,
            pid: null,
            currentStep: null,
            currentStepProgress: null,
            currentStepMessage: null,
            startedAt: null,
            finishedAt: null,
            duration_s: null,
            error: existing && existing.status === "error" ? existing.error : null,
          };
        }
      }));

      if (batchState.status === "idle" || batchState.status === "stopped" || batchState.status === "completed") {
        if (mode === "all") {
          masterQueue = scannedItems;
        } else {
          const scannedMap = new Map();
          for (const s of scannedItems) {
            scannedMap.set(s.id, s);
          }
          masterQueue = masterQueue.map((m) => {
            if (scannedMap.has(m.id)) {
              const res = scannedMap.get(m.id);
              scannedMap.delete(m.id);
              return res;
            }
            return m;
          });
          for (const remaining of scannedMap.values()) {
            masterQueue.push(remaining);
          }
        }
        batchState.queue = filterQueueByMode(mode);
        updateBatchStats();
        updateStorageTelemetry();
        saveBatchManifest(true);
        broadcastBatchState();
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        dir: targetDir,
        count: scannedItems.length,
        videosCount: batchState.stats.videosCount,
        docsCount: batchState.stats.docsCount,
        completedCount: batchState.stats.completed,
        pendingCount: batchState.stats.pending,
        videos: batchState.queue,
        storage: storageTelemetry,
      }));
    });
    return;
  }

  if (req.method === "POST" && (pathname === "/api/batch/start" || pathname === "/api/batch/resume")) {
    readBody(req, (body) => {
      if (batchState.status === "running") {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Um processamento em lote já está em andamento." }));
        return;
      }

      let data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (_) {}

      const inputDir = path.resolve(data.inputDir || batchState.inputDir);
      const outputDir = path.resolve(data.outputDir || batchState.outputDir);
      const parallelism = Math.max(1, Math.min(8, parseInt(data.parallelism || batchState.parallelism || "2", 10)));
      const whisperModel = String(data.whisperModel || batchState.whisperModel || "small").trim();
      const whisperLanguage = String(data.whisperLanguage || batchState.whisperLanguage || "es").trim().toLowerCase();
      const axetModel = String(data.axetModel || batchState.axetModel || "gpt-5.6-terra").trim();
      const videoVisionMode = (data.videoVisionMode && ["vision_ocr", "audio_only"].includes(data.videoVisionMode))
        ? data.videoVisionMode
        : (batchState.videoVisionMode || "vision_ocr");
      const skipCompleted = data.skipCompleted !== false; // Padrão: true (Retomada Inteligente)

      if (!fs.existsSync(inputDir)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: `Diretório de entrada não existe: ${inputDir}` }));
        return;
      }

      try {
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: `Falha ao criar diretório de saída: ${err.message}` }));
        return;
      }

      if (data.ingestionMode && ["all", "videos", "documents"].includes(data.ingestionMode)) {
        batchState.ingestionMode = data.ingestionMode;
      }
      const mode = data.ingestionMode || batchState.ingestionMode || "all";
      const videos = scanFilesRecursively(inputDir, inputDir, mode);
      if (videos.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Nenhum arquivo compatível encontrado na pasta e subpastas informadas." }));
        return;
      }

      batchState.inputDir = inputDir;
      batchState.outputDir = outputDir;
      batchState.parallelism = parallelism;
      batchState.whisperModel = whisperModel;
      batchState.whisperLanguage = whisperLanguage;
      batchState.axetModel = axetModel;
      batchState.videoVisionMode = videoVisionMode;

      // Mapeia histórico existente por caminho relativo normalizado (NFC)
      const existingMap = new Map();
      for (const item of batchState.queue) {
        if (item.relativePath) {
          existingMap.set(item.relativePath.normalize("NFC"), item);
        }
      }

      batchState.queue = deduplicateItems(videos.map((v) => {
        const normRel = (v.relativePath || "").normalize("NFC");
        const existing = existingMap.get(normRel);
        const diskCheck = checkItemCompletedOnDisk(v, outputDir);
        const isCompleted = (existing && existing.status === "completed") || diskCheck.completed;
        const mediaType = getMediaType(v);
        const extension = v.extension || getItemExtension(v);

        if (skipCompleted && isCompleted) {
          // Mantém 100% como concluído, preservando metadados e relatório gerado
          return {
            id: v.id,
            mediaType,
            extension,
            relativePath: v.relativePath,
            fullPath: v.fullPath,
            filename: v.filename,
            sizeBytes: v.sizeBytes,
            allocatedBytes: v.allocatedBytes || 0,
            isHydrated: !!v.isHydrated,
            isOnlineOnly: !!v.isOnlineOnly,
            targetOutputDir: existing ? existing.targetOutputDir : null,
            markdownPath: diskCheck.markdownPath || (existing ? existing.markdownPath : null),
            status: "completed",
            runId: existing ? existing.runId : null,
            pid: null,
            currentStep: "concluido",
            currentStepProgress: 100,
            currentStepMessage: diskCheck.markdownPath
              ? `Relatório validado: ${path.basename(diskCheck.markdownPath)}`
              : (existing && existing.currentStepMessage ? existing.currentStepMessage : "Relatório validado no disco"),
            startedAt: existing ? existing.startedAt : null,
            finishedAt: existing ? existing.finishedAt : null,
            duration_s: existing ? existing.duration_s : null,
            error: null,
          };
        }

        // Reprocessamento ou novo item: define como pending
        return {
          id: v.id,
          mediaType,
          extension,
          relativePath: v.relativePath,
          fullPath: v.fullPath,
          filename: v.filename,
          sizeBytes: v.sizeBytes,
          allocatedBytes: v.allocatedBytes || 0,
          isHydrated: !!v.isHydrated,
          isOnlineOnly: !!v.isOnlineOnly,
          targetOutputDir: existing ? existing.targetOutputDir : null,
          markdownPath: null,
          status: "pending",
          runId: null,
          pid: null,
          currentStep: null,
          currentStepProgress: null,
          currentStepMessage: null,
          startedAt: null,
          finishedAt: null,
          duration_s: null,
          error: null,
        };
      }));
      syncMasterQueueFromState();

      batchState.status = "running";
      batchState.startedAt = new Date().toISOString();
      batchState.finishedAt = null;
      updateBatchStats();
      updateStorageTelemetry();
      saveBatchManifest(true);
      broadcastBatchState(true);

      // Dispara os primeiros workers respeitando o limite de paralelismo
      pumpBatchQueue();

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, batch: getBatchSnapshot() }));
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/batch/stop") {
    stopBatch();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, message: "Lote interrompido com segurança", batch: getBatchSnapshot() }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/batch/retry-failed") {
    let retriedCount = 0;
    for (const item of batchState.queue) {
      if (item.status === "error") {
        item.status = "pending";
        item.error = null;
        item.currentStep = null;
        item.currentStepProgress = null;
        item.currentStepMessage = null;
        item.startedAt = null;
        item.finishedAt = null;
        item.duration_s = null;
        retriedCount++;
      }
    }
    syncMasterQueueFromState();
    updateBatchStats();
    saveBatchManifest(true);
    broadcastBatchState();

    if (batchState.status === "running") {
      pumpBatchQueue();
    }

    console.log(`[batch] ${retriedCount} itens com erro foram redefinidos para pendente e recolocados na fila.`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, retriedCount, batch: getBatchSnapshot() }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/fs/choose-folder") {
    readBody(req, (body) => {
      let data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (_) {}
      const defaultDir = data.defaultDir || ROOT_DIR;
      const resData = chooseFolderNative(defaultDir);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(resData));
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/fs/browse") {
    const targetDir = parsed.query.dir ? String(parsed.query.dir) : os.homedir();
    const showHidden = parsed.query.showHidden === "true" || parsed.query.showHidden === "1";
    const browseData = browseDirectory(targetDir, showHidden);
    res.writeHead(browseData.error ? 400 : 200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(browseData));
    return;
  }

  if (req.method === "POST" && pathname === "/api/fs/validate-dir") {
    readBody(req, (body) => {
      let data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (_) {}
      const targetDir = path.resolve(data.path || "");
      let exists = fs.existsSync(targetDir);
      let created = false;
      if (!exists && data.createIfMissing) {
        try {
          fs.mkdirSync(targetDir, { recursive: true });
          exists = true;
          created = true;
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, path: targetDir, exists, created }));
    });
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/cancel/")) {
    const runId = decodeURIComponent(pathname.slice("/cancel/".length));
    readBody(req, () => {
      const run = runId ? runs.get(runId) : null;
      if (!run) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "run_id não encontrado" }));
        return;
      }
      if (!run.pid) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "PID do processo não disponível para este run" }));
        return;
      }
      try {
        killProcessTree(run.pid, "SIGTERM");
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Falha ao encerrar processo: ${String(e)}` }));
        return;
      }

      const timestamp = new Date().toISOString();
      const logEvt = {
        run_id: runId,
        type: "log",
        level: "WARN",
        message: `Run cancelado manualmente pelo usuário (SIGTERM enviado para PID ${run.pid}).`,
        ts: timestamp,
      };
      applyEvent(logEvt);
      broadcast(logEvt);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "POST" && pathname === "/telemetry") {
    readBody(req, (body) => {
      let evt;
      try {
        evt = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "JSON inválido" }));
        return;
      }
      try {
        applyEvent(evt);
        broadcast(evt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Carrega o manifesto persistido na inicialização do servidor
loadBatchManifest();

server.listen(PORT, () => {
  console.log(`[axet-cockpit] Dashboard de telemetria rodando em http://localhost:${PORT}`);
  console.log(`[axet-cockpit] Endpoint de telemetria: POST http://localhost:${PORT}/telemetry`);
  console.log(`[axet-cockpit] Stream SSE:              GET  http://localhost:${PORT}/events`);
});
