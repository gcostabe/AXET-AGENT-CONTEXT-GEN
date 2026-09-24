#!/usr/bin/env bash
#
# process_video.sh
#
# Pipeline não-interativo para:
#   1. Extrair áudio de um vídeo (ffmpeg)
#   2. Transcrever o áudio (openai-whisper, modelo local)
#   3. Interpretar/humanizar a transcrição via axet-code (sem alucinações)
#   4. Gerar um relatório final em Markdown
#
# Telemetria (opcional):
#   Se houver um dashboard de telemetria rodando (dashboard/server.js),
#   este script envia eventos de progresso via HTTP POST para
#   http://localhost:$DASHBOARD_PORT/telemetry, permitindo acompanhar a
#   execução em tempo real no cockpit visual. Se o dashboard não estiver
#   ativo, os envios falham silenciosamente e o pipeline continua normal.
#
# Uso:
#   ./scripts/process_video.sh <caminho_do_video> [modelo_whisper] [idioma]
#
# Exemplos:
#   ./scripts/process_video.sh videos/aula.mp4
#   ./scripts/process_video.sh videos/aula.mp4 small pt
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuração / argumentos
# ---------------------------------------------------------------------------
VIDEO_PATH="${1:-}"
WHISPER_MODEL="${2:-small}"     # tiny, base, small, medium, large
LANGUAGE="${3:-es}"             # idioma padrão do pipeline (es = espanhol REEF/Mapfre, pt, en, etc.)

if [[ -z "$VIDEO_PATH" ]]; then
  echo "Uso: $0 <caminho_do_video> [modelo_whisper] [idioma]" >&2
  exit 1
fi

if [[ ! -f "$VIDEO_PATH" ]]; then
  echo "Erro: arquivo de vídeo não encontrado: $VIDEO_PATH" >&2
  exit 1
fi

# Diretório raiz do projeto (um nível acima de scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/output}"
PROMPT_TEMPLATE="${PROMPT_TEMPLATE:-$ROOT_DIR/prompts/analise_transcricao_avancada.md}"

VENV_WHISPER="$ROOT_DIR/.venv/bin/whisper"
WHISPER_CPP_BIN="$(command -v whisper-cli 2>/dev/null || echo "/opt/homebrew/bin/whisper-cli")"
GGML_MODEL_DIR="$ROOT_DIR/models"

BASENAME="$(basename "$VIDEO_PATH")"
FILENAME_NOEXT="${BASENAME%.*}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# Diretório de saída dedicado para este vídeo específico
# Se OUTPUT_DIR foi fornecido explicitamente pelo dashboard server, usa-o diretamente como destino final
if [[ -n "${OUTPUT_DIR:-}" && "$OUTPUT_DIR" != "$ROOT_DIR/output" ]]; then
  VIDEO_OUTPUT_DIR="$OUTPUT_DIR"
else
  OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/output}"
  # Caso contrário (execução direta via CLI), espelha subpastas caso INPUT_DIR esteja definido
  if [[ -n "${INPUT_DIR:-}" && "$VIDEO_PATH" == "$INPUT_DIR"* ]]; then
    _REL_PATH="${VIDEO_PATH#$INPUT_DIR/}"
    _REL_DIR="$(dirname "$_REL_PATH")"
    if [[ "$_REL_DIR" != "." && -n "$_REL_DIR" && "$_REL_DIR" != "/" ]]; then
      OUTPUT_DIR="$OUTPUT_DIR/$_REL_DIR"
    fi
  fi
  VIDEO_OUTPUT_DIR="$OUTPUT_DIR/$FILENAME_NOEXT"
fi

mkdir -p "$VIDEO_OUTPUT_DIR"
mkdir -p "$VIDEO_OUTPUT_DIR/logs"

AXET_MODEL_LABEL="${AXET_MODEL:-gpt-5.6-terra}"
VIDEO_VISION_MODE="${VIDEO_VISION_MODE:-vision_ocr}"
LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8766}"
PROMPT_MULTIMODAL="${PROMPT_MULTIMODAL:-$ROOT_DIR/prompts/analise_video_multimodal.md}"

# ---------------------------------------------------------------------------
# Telemetria: helpers
# ---------------------------------------------------------------------------
DASHBOARD_PORT="${DASHBOARD_PORT:-4545}"
TELEMETRY_URL="http://localhost:${DASHBOARD_PORT}/telemetry"
# RUN_ID inclui timestamp + PID do processo, garantindo unicidade mesmo
# quando o MESMO vídeo é processado em paralelo (ex: testando modelos
# diferentes ao mesmo tempo). Todos os arquivos intermediários usam este
# ID para evitar colisão/sobrescrita entre execuções concorrentes.
RUN_ID="run_${TIMESTAMP}_$$"

# ---------------------------------------------------------------------------
# Área Temporária de Trabalho Segura (/tmp/axet-workspace)
# Garante que vídeos e arquivos intermediários possam ser manipulados em /tmp
# e limpos imediatamente, mantendo o OneDrive 100% intocado.
# ---------------------------------------------------------------------------
TEMP_WORKSPACE="/tmp/axet-workspace/${RUN_ID}"
FRAMES_DIR="$TEMP_WORKSPACE/frames"
mkdir -p "$TEMP_WORKSPACE"

# Salvaguarda de Segurança Absoluta contra deleção acidental no OneDrive
assert_safe_path_for_deletion() {
  local target="$1"
  if [[ "$target" == *"OneDrive"* || "$target" == *"CloudStorage"* || "$target" != /tmp/* ]]; then
    echo "ERRO DE SEGURANÇA: Tentativa de remoção fora de /tmp detectada e bloqueada: $target" >&2
    emit_log "ERROR" "" "Tentativa de remoção fora de /tmp bloqueada por salvaguarda de segurança: $target"
    return 1
  fi
  return 0
}

safe_cleanup_temp() {
  if [[ -n "${TEMP_WORKSPACE:-}" && "$TEMP_WORKSPACE" == /tmp/axet-workspace/* && -d "$TEMP_WORKSPACE" ]]; then
    rm -rf "$TEMP_WORKSPACE" 2>/dev/null || true
  fi
}

AUDIO_PATH="$VIDEO_OUTPUT_DIR/${FILENAME_NOEXT}_${RUN_ID}_audio.wav"
TRANSCRIPT_TXT="$VIDEO_OUTPUT_DIR/${FILENAME_NOEXT}_${RUN_ID}.txt"
FINAL_MD="$VIDEO_OUTPUT_DIR/${FILENAME_NOEXT}_resumo_${RUN_ID}.md"

# Salvaguarda de limite de caminho do OneDrive (máx 400 caracteres no macOS / SharePoint)
if [[ ${#FINAL_MD} -gt 300 ]]; then
  AUDIO_PATH="$VIDEO_OUTPUT_DIR/audio_${RUN_ID}.wav"
  TRANSCRIPT_TXT="$VIDEO_OUTPUT_DIR/transcricao_${RUN_ID}.txt"
  FINAL_MD="$VIDEO_OUTPUT_DIR/resumo_${RUN_ID}.md"
fi

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Envia um evento JSON para o dashboard. Falha silenciosamente se o
# dashboard não estiver rodando (não deve interromper o pipeline).
emit_telemetry() {
  local json_payload="$1"
  curl -s -m 2 -X POST "$TELEMETRY_URL" \
    -H "Content-Type: application/json" \
    -d "$json_payload" >/dev/null 2>&1 || true
}

emit_run_start() {
  emit_telemetry "$(cat <<EOF
{"type":"run_start","run_id":"$RUN_ID","ts":"$(now_iso)","video":"$BASENAME","whisper_model":"$WHISPER_MODEL","axet_model":"$AXET_MODEL_LABEL","vision_mode":"$VIDEO_VISION_MODE"}
EOF
)"
}

emit_step_start() {
  local step="$1"
  local message="${2:-}"
  local safe_message="${message//\"/\\\"}"
  emit_telemetry "$(cat <<EOF
{"type":"step_start","run_id":"$RUN_ID","step":"$step","message":"$safe_message","ts":"$(now_iso)"}
EOF
)"
}

emit_step_end() {
  local step="$1"
  local status="$2"
  local duration_s="$3"
  local message="$4"
  emit_telemetry "$(cat <<EOF
{"type":"step_end","run_id":"$RUN_ID","step":"$step","status":"$status","duration_s":$duration_s,"message":"$message","ts":"$(now_iso)"}
EOF
)"
}

emit_log() {
  local level="$1"
  local step="$2"
  local message="$3"
  # escapa aspas duplas simples para não quebrar o JSON
  local safe_message="${message//\"/\\\"}"
  emit_telemetry "$(cat <<EOF
{"type":"log","run_id":"$RUN_ID","level":"$level","step":"$step","message":"$safe_message","ts":"$(now_iso)"}
EOF
)"
}

emit_run_end() {
  local status="$1"
  local duration_s="$2"
  emit_telemetry "$(cat <<EOF
{"type":"run_end","run_id":"$RUN_ID","status":"$status","duration_s":$duration_s,"ts":"$(now_iso)"}
EOF
)"
}

emit_run_pid() {
  local pid="$1"
  emit_telemetry "$(cat <<EOF
{"type":"run_pid","run_id":"$RUN_ID","pid":$pid,"ts":"$(now_iso)"}
EOF
)"
}

emit_step_progress() {
  local step="$1"
  local pct="$2"
  local msg="${3:-}"
  local escaped_msg=""
  if [[ -n "$msg" ]]; then
    escaped_msg="$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
  emit_telemetry "$(cat <<EOF
{"type":"step_progress","run_id":"$RUN_ID","step":"$step","pct":$pct,"message":"$escaped_msg","ts":"$(now_iso)"}
EOF
)"
}

# ---------------------------------------------------------------------------
# Heartbeat em background para evitar timeouts em etapas longas
# (carga do modelo Whisper na memória, inferência sob alta carga de CPU, etc.)
# ---------------------------------------------------------------------------
HEARTBEAT_PID=""

start_heartbeat() {
  stop_heartbeat
  (
    # Executa em background enquanto o processo pai ($$) estiver vivo
    while kill -0 "$$" 2>/dev/null; do
      sleep 20
      emit_telemetry "{\"type\":\"heartbeat\",\"run_id\":\"$RUN_ID\",\"ts\":\"$(now_iso)\"}"
    done
  ) &
  HEARTBEAT_PID=$!
}

stop_heartbeat() {
  if [[ -n "${HEARTBEAT_PID:-}" ]] && kill -0 "$HEARTBEAT_PID" 2>/dev/null; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  HEARTBEAT_PID=""
}

# Converte um timestamp no formato "MM:SS.mmm" ou "HH:MM:SS.mmm" (como
# impresso pelo whisper com --verbose True) para segundos inteiros.
# Usado apenas para calcular percentual de progresso (precisão de segundo
# é suficiente; frações de milissegundo são descartadas).
timestamp_to_seconds() {
  local ts="$1"
  local colon_count
  colon_count=$(awk -F':' '{print NF-1}' <<< "$ts")
  if [[ "$colon_count" -eq 1 ]]; then
    ts="00:$ts"
  fi
  awk -F'[:.]' '{ printf "%d", ($1*3600)+($2*60)+$3 }' <<< "$ts"
}

PIPELINE_START_TS=$(date +%s)
CANCELLED=0

# Trata cancelamento manual via SIGTERM (enviado pelo endpoint POST /cancel
# do dashboard). Marca a flag CANCELLED antes de deixar o `set -e`/trap EXIT
# tratar a saída, para que o run_end seja emitido com status "cancelled" em
# vez de "error".
on_sigterm_trap() {
  stop_heartbeat
  safe_cleanup_temp
  CANCELLED=1
  emit_log "WARN" "" "Pipeline recebeu sinal de cancelamento (SIGTERM). Área temporária limpa."
  exit 143
}
trap on_sigterm_trap TERM INT

CURRENT_STEP=""
LAST_ERROR_MSG=""

# Garante que, em caso de erro em qualquer etapa, o run_end seja emitido
# como "error" (ou "cancelled", se cancelado manualmente) para o dashboard
# não ficar travado em "running".
on_error_trap() {
  local exit_code=$?
  stop_heartbeat
  safe_cleanup_temp
  if [[ $exit_code -ne 0 ]]; then
    local total_dur=$(( $(date +%s) - PIPELINE_START_TS ))
    if [[ "$CANCELLED" -eq 1 ]]; then
      emit_log "WARN" "" "Pipeline cancelado manualmente pelo usuário."
      emit_run_end "cancelled" "$total_dur"
    else
      local err_desc="${LAST_ERROR_MSG:-Pipeline finalizado com erro (exit code $exit_code).}"
      if [[ -n "$CURRENT_STEP" ]]; then
        emit_step_end "$CURRENT_STEP" "error" 0 "$err_desc"
        emit_log "ERROR" "$CURRENT_STEP" "$err_desc"
      else
        emit_log "ERROR" "" "$err_desc"
      fi
      emit_run_end "error" "$total_dur"
    fi
  fi
}
trap on_error_trap EXIT

echo "=============================================================="
echo " AXET Video Pipeline"
echo "=============================================================="
echo "Vídeo de entrada : $VIDEO_PATH"
echo "Modelo Whisper   : $WHISPER_MODEL"
echo "Idioma           : $LANGUAGE"
echo "Modo de Visão    : $VIDEO_VISION_MODE"
echo "Saída            : $VIDEO_OUTPUT_DIR"
echo "Run ID           : $RUN_ID"
echo "=============================================================="

emit_run_start
emit_run_pid "$$"
start_heartbeat
emit_log "INFO" "" "Pipeline iniciado para o vídeo '$BASENAME'."

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 1. Extração de áudio com ffmpeg
# ---------------------------------------------------------------------------
STEP1_START=$(date +%s)
CURRENT_STEP="extracao_audio"
echo
echo "[1/4] Extraindo áudio do vídeo com ffmpeg..."
emit_step_start "extracao_audio"
emit_log "INFO" "extracao_audio" "Iniciando extração de áudio com ffmpeg."

# Diagnóstico prévio de integridade (OneDrive / CloudStorage Dataless)
IS_DATALESS=false
if ls -lO "$VIDEO_PATH" 2>/dev/null | grep -q "dataless"; then
  IS_DATALESS=true
elif ! head -c 1 "$VIDEO_PATH" >/dev/null 2>&1; then
  IS_DATALESS=true
fi

if [[ "$IS_DATALESS" == true ]]; then
  LAST_ERROR_MSG="Vídeo no OneDrive está como 'dataless' (apenas na nuvem / 0 bytes locais). Baixe o arquivo no Finder ('Sempre manter neste dispositivo') antes de processar."
  echo "ERRO [extracao_audio]: $LAST_ERROR_MSG" >&2
  emit_log "ERROR" "extracao_audio" "$LAST_ERROR_MSG"
  emit_step_end "extracao_audio" "error" 0 "$LAST_ERROR_MSG"
  exit 196
fi

EFFECTIVE_VIDEO_PATH="$VIDEO_PATH"
IS_TMP_VIDEO=false

if [[ "${STAGE_VIDEO_TO_TMP:-false}" == "true" ]]; then
  TEMP_VIDEO_FILE="$TEMP_WORKSPACE/$BASENAME"
  emit_log "INFO" "extracao_audio" "Copiando vídeo para área temporária de trabalho (/tmp/axet-workspace)..."
  if ! cp "$VIDEO_PATH" "$TEMP_VIDEO_FILE" 2>"$TEMP_WORKSPACE/cp_error.log"; then
    CP_ERR="$(head -n 2 "$TEMP_WORKSPACE/cp_error.log" 2>/dev/null | tr '
' ' ')"
    LAST_ERROR_MSG="Falha ao copiar vídeo do OneDrive: ${CP_ERR:-erro de I/O}"
    echo "ERRO [extracao_audio]: $LAST_ERROR_MSG" >&2
    emit_log "ERROR" "extracao_audio" "$LAST_ERROR_MSG"
    emit_step_end "extracao_audio" "error" 0 "$LAST_ERROR_MSG"
    exit 1
  fi
  EFFECTIVE_VIDEO_PATH="$TEMP_VIDEO_FILE"
  IS_TMP_VIDEO=true
fi

FFMPEG_ERR_LOG="$TEMP_WORKSPACE/ffmpeg_stderr.log"
if ! ffmpeg -y -nostdin -i "$EFFECTIVE_VIDEO_PATH" -vn -acodec pcm_s16le -ar 16000 -ac 1 "$AUDIO_PATH" \
  -loglevel error 2>"$FFMPEG_ERR_LOG" </dev/null; then
  STEP1_DUR=$(( $(date +%s) - STEP1_START ))
  FFMPEG_ERR_TEXT="$(tr '
' ' ' < "$FFMPEG_ERR_LOG" 2>/dev/null | sed 's/  */ /g' | head -c 250)"
  if [[ "$FFMPEG_ERR_TEXT" == *"Operation timed out"* ]]; then
    LAST_ERROR_MSG="Timeout de I/O no OneDrive: arquivo em nuvem inacessível. O macOS retornou 'Operation timed out'."
  elif [[ -n "$FFMPEG_ERR_TEXT" ]]; then
    LAST_ERROR_MSG="Falha no ffmpeg: $FFMPEG_ERR_TEXT"
  else
    LAST_ERROR_MSG="Falha desconhecida no ffmpeg durante extração do áudio."
  fi
  echo "ERRO [extracao_audio]: $LAST_ERROR_MSG" >&2
  emit_log "ERROR" "extracao_audio" "$LAST_ERROR_MSG"
  emit_step_end "extracao_audio" "error" "$STEP1_DUR" "$LAST_ERROR_MSG"
  exit 1
fi

# ---------------------------------------------------------------------------
# Extração de Frames para OCR & Visão Multimodal (se habilitado)
# ---------------------------------------------------------------------------
if [[ "$VIDEO_VISION_MODE" == "vision_ocr" ]]; then
  echo "      -> Extraindo frames de tela para OCR e Visão Multimodal..."
  emit_log "INFO" "extracao_audio" "Iniciando amostragem de frames do vídeo para análise visual..."
  mkdir -p "$FRAMES_DIR"
  FRAMES_LOG="$TEMP_WORKSPACE/frames_extraction.log"
  if python3 "$ROOT_DIR/scripts/extract_video_frames.py" "$EFFECTIVE_VIDEO_PATH" "$FRAMES_DIR" >"$FRAMES_LOG" 2>&1; then
    FRAME_COUNT="$(grep -oE '"count": *[0-9]+' "$FRAMES_LOG" | awk '{print $2}' || echo 0)"
    emit_log "INFO" "extracao_audio" "Frames visuais extraídos: ${FRAME_COUNT:-0} frames capturados para OCR e Visão Multimodal."
    echo "      -> Frames visuais capturados: ${FRAME_COUNT:-0} frames em $FRAMES_DIR"
  else
    emit_log "WARN" "extracao_audio" "Aviso: falha na extração de frames visuais. O pipeline continuará com o áudio."
  fi
fi

# OTIMIZAÇÃO CRÍTICA DE ARMAZENAMENTO:
# Se o vídeo foi processado a partir de área temporária /tmp, remove-o IMEDIATAMENTE
# após a extração do áudio e dos frames pelo ffmpeg, reduzindo a pegada em disco de dezenas de GB para centenas de MB.
if [[ "$IS_TMP_VIDEO" == true && -f "$EFFECTIVE_VIDEO_PATH" ]]; then
  if assert_safe_path_for_deletion "$EFFECTIVE_VIDEO_PATH"; then
    rm -f "$EFFECTIVE_VIDEO_PATH"
    emit_log "INFO" "extracao_audio" "Vídeo temporário removido de /tmp. Espaço liberado imediatamente."
  fi
fi

STEP1_DUR=$(( $(date +%s) - STEP1_START ))
echo "      -> Áudio extraído: $AUDIO_PATH"
emit_log "INFO" "extracao_audio" "Áudio extraído com sucesso: $(basename "$AUDIO_PATH")."
emit_step_end "extracao_audio" "success" "$STEP1_DUR" "Áudio extraído: $(basename "$AUDIO_PATH")"
CURRENT_STEP=""

# ---------------------------------------------------------------------------
# 2. Transcrição com Whisper (modelo local, sem API externa)
# ---------------------------------------------------------------------------
STEP2_START=$(date +%s)
echo
CURRENT_STEP="transcricao_whisper"
emit_step_start "transcricao_whisper"

GGML_MODEL_FILE="$GGML_MODEL_DIR/ggml-${WHISPER_MODEL}.bin"
USE_WHISPER_CPP=false
if [[ -x "$WHISPER_CPP_BIN" && -f "$GGML_MODEL_FILE" ]]; then
  USE_WHISPER_CPP=true
fi

if [[ "$USE_WHISPER_CPP" == true ]]; then
  echo "[2/4] Transcrevendo áudio com whisper.cpp Metal acelerado (modelo: $WHISPER_MODEL)..."
  emit_log "INFO" "transcricao_whisper" "Motor ativo: whisper.cpp Nativo C++ com aceleração Metal (Apple M4 Pro). Modelo: ggml-${WHISPER_MODEL}.bin"
else
  echo "[2/4] Transcrevendo áudio com Whisper Python (modelo: $WHISPER_MODEL)..."
  emit_log "INFO" "transcricao_whisper" "Iniciando transcrição com Whisper Python (modelo: $WHISPER_MODEL, idioma: $LANGUAGE)."
  emit_log "INFO" "transcricao_whisper" "Carregando modelo Whisper '$WHISPER_MODEL' na memória..."
  if [[ ! -x "$VENV_WHISPER" ]]; then
    echo "Erro: nem whisper.cpp nem openai-whisper foram encontrados em $VENV_WHISPER" >&2
    emit_log "ERROR" "transcricao_whisper" "Nenhum motor Whisper encontrado."
    emit_step_end "transcricao_whisper" "error" 0 "Whisper não encontrado."
    exit 1
  fi
fi

# Duração total do áudio (em segundos), usada como denominador para
# calcular o percentual de progresso
AUDIO_DURATION_S="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$AUDIO_PATH" 2>/dev/null || echo 0)"
AUDIO_DURATION_S="${AUDIO_DURATION_S%.*}"
if [[ -z "$AUDIO_DURATION_S" || "$AUDIO_DURATION_S" -le 0 ]]; then
  AUDIO_DURATION_S=1
fi

WHISPER_LOG="$VIDEO_OUTPUT_DIR/logs/${FILENAME_NOEXT}_${RUN_ID}_whisper.log"
WHISPER_EXIT_CODE=0

set +e
if [[ "$USE_WHISPER_CPP" == true ]]; then
  WHISPER_CMD=(
    "$WHISPER_CPP_BIN"
    -m "$GGML_MODEL_FILE"
    -f "$AUDIO_PATH"
    -t 4
    --flash-attn
    -pp
    --suppress-nst
    -mc 0
    -nf
    -bs 1
    -bo 1
    -otxt
    -of "${TRANSCRIPT_TXT%.txt}"
  )
  WHISPER_LANG_RESOLVED="$LANGUAGE"
  if [[ -z "$WHISPER_LANG_RESOLVED" || "$WHISPER_LANG_RESOLVED" == "auto" || "$WHISPER_LANG_RESOLVED" == "None" ]]; then
    WHISPER_LANG_RESOLVED="es"
  fi
  WHISPER_CMD+=(-l "$WHISPER_LANG_RESOLVED")

  "${WHISPER_CMD[@]}" 2>&1 | tee "$WHISPER_LOG" | while IFS= read -r line; do
    if [[ "$line" =~ progress\ =\ *([0-9]+)% ]]; then
      pct="${BASH_REMATCH[1]}"
      emit_step_progress "transcricao_whisper" "$pct"
    else
      end_ts="$(grep -oE '\--> *[0-9]{2}:[0-9]{2}(:[0-9]{2})?\.[0-9]{3}' <<< "$line" | sed -E 's/--> *//' | head -n1)"
      if [[ -n "$end_ts" ]]; then
        end_s="$(timestamp_to_seconds "$end_ts")"
        if [[ -n "$end_s" && "$AUDIO_DURATION_S" -gt 0 ]]; then
          pct=$(( end_s * 100 / AUDIO_DURATION_S ))
          [[ $pct -gt 100 ]] && pct=100
          emit_step_progress "transcricao_whisper" "$pct"
        fi
      fi
    fi
  done
  WHISPER_EXIT_CODE=${PIPESTATUS[0]:-0}

else
  WHISPER_CMD=(
    "$VENV_WHISPER"
    "$AUDIO_PATH"
    --model "$WHISPER_MODEL"
  )
  if [[ -n "$LANGUAGE" && "$LANGUAGE" != "auto" && "$LANGUAGE" != "None" ]]; then
    WHISPER_CMD+=(--language "$LANGUAGE")
  fi
  WHISPER_CMD+=(
    --task transcribe
    --output_format txt
    --output_dir "$VIDEO_OUTPUT_DIR"
    --fp16 False
    --condition_on_previous_text False
    --no_speech_threshold 0.6
    --verbose True
  )

  export OMP_NUM_THREADS=4
  PYTHONUNBUFFERED=1 "${WHISPER_CMD[@]}" 2>&1 | tee "$WHISPER_LOG" | while IFS= read -r line; do
    end_ts="$(grep -oE '\--> *[0-9]{2}:[0-9]{2}(:[0-9]{2})?\.[0-9]{3}' <<< "$line" | sed -E 's/--> *//' | head -n1)"
    if [[ -n "$end_ts" ]]; then
      end_s="$(timestamp_to_seconds "$end_ts")"
      if [[ -n "$end_s" ]]; then
        pct=$(( end_s * 100 / AUDIO_DURATION_S ))
        [[ $pct -gt 100 ]] && pct=100
        emit_step_progress "transcricao_whisper" "$pct"
      fi
    fi
  done
  WHISPER_EXIT_CODE=${PIPESTATUS[0]:-0}
fi
set -e

if [[ "$WHISPER_EXIT_CODE" -ne 0 ]]; then
  echo "Erro: whisper terminou com código $WHISPER_EXIT_CODE." >&2
  if [[ -f "$WHISPER_LOG" ]]; then
    tail -n 15 "$WHISPER_LOG" >&2 || true
  fi
  emit_log "ERROR" "transcricao_whisper" "Whisper terminou com código $WHISPER_EXIT_CODE."
  emit_step_end "transcricao_whisper" "error" 0 "Whisper falhou (exit $WHISPER_EXIT_CODE)."
  exit "$WHISPER_EXIT_CODE"
fi
rm -f "$WHISPER_LOG"

# O whisper Python gera com sufixo _audio.txt; movemos se necessário
GENERATED_TXT="$VIDEO_OUTPUT_DIR/${FILENAME_NOEXT}_${RUN_ID}_audio.txt"
if [[ -f "$GENERATED_TXT" ]]; then
  mv "$GENERATED_TXT" "$TRANSCRIPT_TXT"
fi

if [[ ! -f "$TRANSCRIPT_TXT" ]]; then
  echo "Erro: transcrição não foi gerada." >&2
  emit_log "ERROR" "transcricao_whisper" "Arquivo de transcrição não foi gerado."
  emit_step_end "transcricao_whisper" "error" 0 "Transcrição não gerada."
  exit 1
fi

# Sanitização: remove linhas residuais que contenham apenas [BLANK_AUDIO] e deduplica repetições consecutivas idênticas (loops alucinatórios)
TMP_CLEAN="$(mktemp -t transcript_clean_XXXXXX.txt)"
grep -v -E "^\s*\[BLANK_AUDIO\]\s*$" "$TRANSCRIPT_TXT" | awk 'NR==1 || $0!=prev {print; prev=$0}' > "$TMP_CLEAN" || true
if [[ -s "$TMP_CLEAN" ]]; then
  mv "$TMP_CLEAN" "$TRANSCRIPT_TXT"
else
  rm -f "$TMP_CLEAN"
fi

STEP2_DUR=$(( $(date +%s) - STEP2_START ))
echo "      -> Transcrição gerada: $TRANSCRIPT_TXT"
emit_log "INFO" "transcricao_whisper" "Transcrição gerada com sucesso: $(basename "$TRANSCRIPT_TXT")."

# Remoção imediata do áudio WAV temporário para economizar espaço e evitar sincronização pesada no OneDrive
if [[ -f "$AUDIO_PATH" ]]; then
  rm -f "$AUDIO_PATH" 2>/dev/null || true
  emit_log "INFO" "transcricao_whisper" "Áudio WAV temporário removido após transcrição."
fi

CURRENT_STEP=""
emit_step_end "transcricao_whisper" "success" "$STEP2_DUR" "Transcrição: $(basename "$TRANSCRIPT_TXT")"

# ---------------------------------------------------------------------------
# 3. Interpretação/Análise Avançada via Visão Multimodal ou axet-code
# ---------------------------------------------------------------------------
STEP3_START=$(date +%s)
echo
CURRENT_STEP="interpretacao_axet"
emit_step_start "interpretacao_axet"

MULTIMODAL_SUCCESS=false
OCR_CONTEXT_FILE=""

# Verifica se o modo multimodal está ativo e se há frames extraídos para OCR
if [[ "$VIDEO_VISION_MODE" == "vision_ocr" && -d "$FRAMES_DIR" && $(ls -1 "$FRAMES_DIR"/*.jpg 2>/dev/null | wc -l) -gt 0 ]]; then
  echo "[3/4] Extraindo OCR das telas do vídeo com Claude Sonnet 5..."
  emit_log "INFO" "interpretacao_axet" "Iniciando extração de OCR das telas via LLM Gateway..."
  emit_step_progress "interpretacao_axet" 5 "[1/5] Extraindo telas e OCR dos frames com Claude Sonnet 5..."

  OCR_CONTEXT_FILE="$TEMP_WORKSPACE/ocr_context.txt"
  MULTIMODAL_ERR="$TEMP_WORKSPACE/multimodal_error.log"

  if LLM_GATEWAY_URL="$LLM_GATEWAY_URL" python3 "$ROOT_DIR/scripts/analyze_video_multimodal.py" \
      --ocr-only "$FRAMES_DIR" "$OCR_CONTEXT_FILE" 2>"$MULTIMODAL_ERR"; then
    if [[ -s "$OCR_CONTEXT_FILE" && $(wc -c < "$OCR_CONTEXT_FILE") -gt 50 ]]; then
      MULTIMODAL_SUCCESS=true
      emit_log "INFO" "interpretacao_axet" "OCR visual extraído com sucesso ($(wc -c < "$OCR_CONTEXT_FILE" | tr -d ' ') bytes)."
    fi
  else
    MM_ERR_TEXT="$(head -n 5 "$MULTIMODAL_ERR" 2>/dev/null | tr '\n' ' ')"
    emit_log "WARN" "interpretacao_axet" "Aviso no OCR de telas ($MM_ERR_TEXT). Prosseguindo com a transcrição..."
  fi
fi

echo "[3/4] Interpretando a transcrição e gerando relatório técnico via axet-code (modelo: $AXET_MODEL_LABEL)..."
emit_log "INFO" "interpretacao_axet" "Iniciando síntese RAG com axet-code (modelo: $AXET_MODEL_LABEL)."

PROMPT_FILE="$(mktemp -t axet_prompt_XXXXXX.txt)"

if [[ -f "$PROMPT_TEMPLATE" ]]; then
  emit_log "INFO" "interpretacao_axet" "Montando prompt avançado com template: $(basename "$PROMPT_TEMPLATE")."
  python3 - "$PROMPT_TEMPLATE" "$TRANSCRIPT_TXT" "${OCR_CONTEXT_FILE:-}" "$PROMPT_FILE" <<'PYEOF'
import sys, os

template_path, transcript_path, ocr_path, out_path = sys.argv[1:5]

with open(template_path, "r", encoding="utf-8", errors="replace") as f:
    template = f.read()

with open(transcript_path, "r", encoding="utf-8", errors="replace") as f:
    transcript = f.read()

ocr_text = ""
if ocr_path and os.path.isfile(ocr_path):
    with open(ocr_path, "r", encoding="utf-8", errors="replace") as f:
        ocr_text = f.read().strip()

if ocr_text:
    full_context = f"# EVIDÊNCIAS VISUAIS EXTRAÍDAS DAS TELAS E SLIDES DO VÍDEO (OCR MULTIMODAL)\n{ocr_text}\n\n---\n\n# TRANSCRIÇÃO ORIGINAL DA FALA (WHISPER)\n```text\n{transcript}\n```\n"
else:
    full_context = transcript

if "{{CONTEUDO_ENTRADA}}" in template:
    final_prompt = template.replace("{{CONTEUDO_ENTRADA}}", full_context)
elif "{{TRANSCRICAO}}" in template:
    if ocr_text:
        combined = f"{ocr_text}\n\n---\n\n{transcript}"
        final_prompt = template.replace("{{TRANSCRICAO}}", combined)
    else:
        final_prompt = template.replace("{{TRANSCRICAO}}", transcript)
else:
    final_prompt = f"{template}\n\n---\n\n# CONTEÚDO PARA ANÁLISE\n\n```\n{full_context}\n```\n"

with open(out_path, "w", encoding="utf-8") as f:
    f.write(final_prompt)
PYEOF
else
  emit_log "WARN" "interpretacao_axet" "Template de prompt não encontrado em $PROMPT_TEMPLATE. Usando template básico."
  TRANSCRIPT_CONTENT="$(cat "$TRANSCRIPT_TXT")"
  cat > "$PROMPT_FILE" <<PROMPT_EOF
Você é um especialista sênior em análise de transcrições, documentação funcional, arquitetura de sistemas e processos de negócio.
Sua tarefa é analisar profundamente a transcrição e produzir um documento estruturado completo sem alucinações.

---
TRANSCRIÇÃO ORIGINAL:
$TRANSCRIPT_CONTENT
PROMPT_EOF
fi

PROMPT_SIZE=$(wc -c < "$PROMPT_FILE" | tr -d ' ')
PROMPT_SIZE_KB=$(( (PROMPT_SIZE + 1023) / 1024 ))
emit_log "INFO" "interpretacao_axet" "Enviando prompt (${PROMPT_SIZE_KB} KB) para axet-code (modelo: $AXET_MODEL_LABEL)..."

AXET_CMD=(axet-code run --quiet)
if [[ -n "${AXET_MODEL:-}" && "$AXET_MODEL" != "default" && "$AXET_MODEL" != "auto" ]]; then
  AXET_CMD+=(-m "$AXET_MODEL")
fi

AXET_ERR_FILE="$(mktemp -t axet_err_XXXXXX.txt)"
AXET_STREAM_OUT="$(mktemp -t axet_stream_XXXXXX.md)"

# Fase 1 (15%): Contexto carregado e enviado para o modelo
emit_step_progress "interpretacao_axet" 15 "[1/5] Contexto carregado (${PROMPT_SIZE_KB} KB). Enviando para ${AXET_MODEL_LABEL}..."

# Dispara axet-code transmitindo a saída em tempo real para AXET_STREAM_OUT em background
"${AXET_CMD[@]}" < "$PROMPT_FILE" 2>"$AXET_ERR_FILE" > "$AXET_STREAM_OUT" &
AXET_PID=$!

RAG_START_TIME=$(date +%s)
CURRENT_RAG_PHASE=1

# Loop de monitoramento ativo: combina tempo de inferência com detecção de cabeçalhos/bytes
while kill -0 "$AXET_PID" 2>/dev/null; do
  sleep 1
  ELAPSED=$(( $(date +%s) - RAG_START_TIME ))
  STREAM_BYTES=0
  [[ -s "$AXET_STREAM_OUT" ]] && STREAM_BYTES=$(wc -c < "$AXET_STREAM_OUT" | tr -d ' ')

  # Fase 5 (90%): Perguntas & Respostas de Alta Relevância RAG / Fechamento
  if [[ "$CURRENT_RAG_PHASE" -lt 5 ]] && { [[ "$STREAM_BYTES" -ge 20000 ]] || grep -q -i -E "^#+.*([Pp]erguntas|[Rr]espostas|Q&A|FAQ|[Cc]asos [Cc]oncretos|[Rr]oadmap)" "$AXET_STREAM_OUT" 2>/dev/null || [[ $ELAPSED -ge 40 ]]; }; then
    CURRENT_RAG_PHASE=5
    emit_step_progress "interpretacao_axet" 90 "[5/5] Formulando Perguntas & Respostas de Alta Relevância RAG..."
  # Fase 4 (75%): Entidades, APIs e Pontos de Integração
  elif [[ "$CURRENT_RAG_PHASE" -lt 4 ]] && { [[ "$STREAM_BYTES" -ge 12000 ]] || grep -q -i -E "^#+.*([Ee]ntidade|[Aa][Pp][Ii]|[Ii]ntegra|[Mm]odelo de [Ii]ntegra|[Mm]odelo [Oo]peracional|[Gg]overnan)" "$AXET_STREAM_OUT" 2>/dev/null || [[ $ELAPSED -ge 25 ]]; }; then
    CURRENT_RAG_PHASE=4
    emit_step_progress "interpretacao_axet" 75 "[4/5] Mapeando Entidades, APIs e Pontos de Integração..."
  # Fase 3 (55%): Regras de Negócio e Módulos TRON
  elif [[ "$CURRENT_RAG_PHASE" -lt 3 ]] && { [[ "$STREAM_BYTES" -ge 4000 ]] || grep -q -i -E "^#+.*([Rr]egras? de [Nn]eg|[Mm][oó]dulo|[Aa]rquitetura|[Cc]omponentes?|[Ff]uncionamento|TRON)" "$AXET_STREAM_OUT" 2>/dev/null || [[ $ELAPSED -ge 14 ]]; }; then
    CURRENT_RAG_PHASE=3
    emit_step_progress "interpretacao_axet" 55 "[3/5] Estruturando Regras de Negócio e Módulos TRON..."
  # Fase 2 (35%): Visão Geral, Atores e Casos de Uso
  elif [[ "$CURRENT_RAG_PHASE" -lt 2 ]] && { [[ "$STREAM_BYTES" -ge 600 ]] || grep -q -i -E "^#+.*([Vv]is[aã]o [Gg]eral|[Ss][ií]ntese|[Cc]ontexto|[Aa]tores|[Cc]asos? de [Uu]so|[Pp]roblema)" "$AXET_STREAM_OUT" 2>/dev/null || [[ $ELAPSED -ge 5 ]]; }; then
    CURRENT_RAG_PHASE=2
    emit_step_progress "interpretacao_axet" 35 "[2/5] Sintetizando Visão Geral, Atores e Casos de Uso..."
  fi
done

# Aguarda término e checa status do processo
wait "$AXET_PID"
AXET_EXIT_CODE=$?

if [[ $AXET_EXIT_CODE -ne 0 ]]; then
  echo "Erro: axet-code encerrou com falha (código $AXET_EXIT_CODE)." >&2
  if [[ -f "$AXET_ERR_FILE" ]]; then
    tail -n 20 "$AXET_ERR_FILE" >&2 || true
  fi
  emit_log "ERROR" "interpretacao_axet" "Falha na chamada ao axet-code (modelo: $AXET_MODEL_LABEL)."
  emit_step_end "interpretacao_axet" "error" 0 "axet-code falhou."
  rm -f "$PROMPT_FILE" "$AXET_ERR_FILE" "$AXET_STREAM_OUT"
  exit 1
fi

AXET_OUTPUT="$(cat "$AXET_STREAM_OUT" 2>/dev/null || true)"
rm -f "$PROMPT_FILE" "$AXET_ERR_FILE" "$AXET_STREAM_OUT"

if [[ -z "$AXET_OUTPUT" ]]; then
  echo "Erro: axet-code não retornou conteúdo." >&2
  emit_log "ERROR" "interpretacao_axet" "axet-code não retornou conteúdo."
  emit_step_end "interpretacao_axet" "error" 0 "axet-code sem retorno."
  exit 1
fi

# Fase Final (100%): Concluído com sucesso
emit_step_progress "interpretacao_axet" 100 "Relatório estruturado gerado com sucesso."

STEP3_DUR=$(( $(date +%s) - STEP3_START ))
echo "      -> Análise avançada gerada (${STEP3_DUR}s)."
emit_log "INFO" "interpretacao_axet" "Análise avançada gerada com sucesso."
CURRENT_STEP=""
emit_step_end "interpretacao_axet" "success" "$STEP3_DUR" "Análise avançada concluída."

# ---------------------------------------------------------------------------
# 4. Montagem do Markdown final
# ---------------------------------------------------------------------------
STEP4_START=$(date +%s)
echo
echo "[4/4] Montando o relatório final em Markdown..."
CURRENT_STEP="geracao_markdown"
emit_step_start "geracao_markdown"
emit_log "INFO" "geracao_markdown" "Montando relatório final em Markdown."

{
  echo "# Relatório de Análise Avançada de Transcrição"
  echo
  echo "**Arquivo de origem:** \`$BASENAME\`"
  echo "**Data de processamento:** $(date '+%d/%m/%Y %H:%M:%S')"
  if [[ "$USE_WHISPER_CPP" == true ]]; then
    echo "**Modelo de transcrição:** whisper.cpp Metal ($WHISPER_MODEL) — idioma: ${LANGUAGE:-auto}"
  else
    echo "**Modelo de transcrição:** Whisper Python ($WHISPER_MODEL) — idioma: ${LANGUAGE:-auto}"
  fi
  if [[ "$MULTIMODAL_SUCCESS" == true ]]; then
    echo "**Modo de Análise:** Com OCR + Visão Multimodal (Frames de Tela + Áudio)"
    echo "**Modelo de Visão/IA:** LLM Gateway ($AXET_MODEL_LABEL)"
    echo "**Prompt utilizado:** análise multimodal avançada (documentação funcional, OCR de telas, formulários, tabelas, arquitetura)"
  else
    echo "**Modo de Análise:** Sem OCR (Apenas Áudio + LLM Tradicional)"
    echo "**Modelo de interpretação IA:** axet-code ($AXET_MODEL_LABEL)"
    echo "**Prompt utilizado:** análise sênior avançada (documentação funcional, arquitetura, negócio, riscos, Q&A, anti-alucinação)"
  fi
  echo
  echo "---"
  echo
  echo "$AXET_OUTPUT"
} > "$FINAL_MD"

# Validação explícita de integridade do relatório Markdown gerado
FINAL_MD_SIZE="$(wc -c < "$FINAL_MD" 2>/dev/null || echo 0)"
if [[ ! -s "$FINAL_MD" || "$FINAL_MD_SIZE" -lt 150 ]]; then
  echo "Erro: O relatório Markdown não passou na validação de integridade (< 150 bytes: $FINAL_MD_SIZE bytes)." >&2
  emit_log "ERROR" "geracao_markdown" "Falha na validação do relatório Markdown (conteúdo vazio ou menor que 150 bytes)."
  emit_step_end "geracao_markdown" "error" 0 "Falha na validação do relatório."
  safe_cleanup_temp
  exit 1
fi

STEP4_DUR=$(( $(date +%s) - STEP4_START ))
echo "      -> Relatório final salvo em: $FINAL_MD (validado: ${FINAL_MD_SIZE} bytes)"
emit_log "INFO" "geracao_markdown" "Relatório final validado e salvo com sucesso: $(basename "$FINAL_MD")."
CURRENT_STEP=""
emit_step_end "geracao_markdown" "success" "$STEP4_DUR" "Relatório: $(basename "$FINAL_MD")"

# Limpeza garantida da área temporária de trabalho (/tmp/axet-workspace)
safe_cleanup_temp

stop_heartbeat
PIPELINE_TOTAL_DUR=$(( $(date +%s) - PIPELINE_START_TS ))
emit_log "INFO" "" "Pipeline concluído com sucesso em ${PIPELINE_TOTAL_DUR}s. Área temporária liberada."
emit_run_end "success" "$PIPELINE_TOTAL_DUR"

echo
echo "=============================================================="
echo " Pipeline concluído com sucesso!"
echo " Resultado: $FINAL_MD"
echo "=============================================================="
