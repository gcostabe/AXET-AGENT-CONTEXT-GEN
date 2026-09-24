#!/usr/bin/env python3
"""
scripts/analyze_video_multimodal.py

Orquestrador de análise multimodal em 2 etapas para o AGENTE-CONTEXT-GEN:
1. ETAPA 1 (Visão/OCR Especializado):
   Envia os frames visuais capturados para o LLM Gateway (:8766 com Claude Sonnet 5),
   extraindo textualmente todas as telas, formulários, tabelas, diagramas e notas técnicas,
   com filtro rigoroso anti-ruído (descarta webcams, Teams e janelas do SO).

2. ETAPA 2 (Síntese & Análise Mestre sem Truncamento):
   Combina a transcrição completa (Whisper) com o OCR enriquecido das telas dentro do
   template de análise técnica avançada (708 linhas de rigor de engenharia), despachando
   para axet-code (gpt-5.6-terra / claude) para produzir o documento de 1.000+ linhas na íntegra.

Uso:
    python3 scripts/analyze_video_multimodal.py <transcript_txt> <frames_dir> <prompt_template> <output_md> [model_name]
"""

import sys
import os
import json
import base64
import urllib.request
import urllib.error
import subprocess
from pathlib import Path

DEFAULT_GATEWAY_URL = "http://localhost:8766"
DEFAULT_VISION_MODEL = "eu.anthropic.claude-sonnet-5"
DEFAULT_SYNTHESIS_MODEL = "gpt-5.6-terra"

def read_file(filepath: str) -> str:
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def load_frames(frames_dir: str, max_frames: int = 15) -> list:
    """Carrega os frames e seus metadados de tempo."""
    manifest_path = os.path.join(frames_dir, "frames_manifest.json")
    frames = []

    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                raw_frames = data.get("frames", [])
                for rf in raw_frames[:max_frames]:
                    p = rf.get("path")
                    if p and os.path.isfile(p):
                        frames.append({
                            "path": p,
                            "filename": rf.get("filename", os.path.basename(p)),
                            "time_str": rf.get("time_str", "00:00"),
                            "timestamp_s": rf.get("timestamp_s", 0)
                        })
        except Exception as e:
            sys.stderr.write(f"Aviso ao ler manifesto de frames: {e}\n")

    if not frames:
        jpgs = sorted(Path(frames_dir).glob("*.jpg"))
        for j in jpgs[:max_frames]:
            frames.append({
                "path": str(j),
                "filename": j.name,
                "time_str": "frame",
                "timestamp_s": 0
            })

    return frames

def encode_image_base64(filepath: str) -> str:
    """Converte arquivo de imagem para string base64."""
    with open(filepath, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

def extract_ocr_from_frames(gateway_url: str, vision_model: str, frames: list) -> str:
    """
    Etapa 1: Envia os frames visuais para o modelo de visão multimodal no Gateway
    e extrai o conteúdo técnico de tela (OCR, formulários, tabelas e diagramas).
    """
    if not frames:
        return ""

    endpoint = f"{gateway_url.rstrip('/')}/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01"
    }

    user_blocks = [{
        "type": "text",
        "text": (
            "Você é um especialista em OCR técnico e visão computacional de interfaces corporativas.\n"
            "Analise detalhadamente cada um dos frames de tela fornecidos (capturados ao longo de um vídeo técnico) "
            "e extraia minuciosamente todo o conteúdo visual relevante:\n"
            "- Textos de planilhas técnicas: perguntas, tópicos, colunas, células preenchidas, respostas e notas em fórmulas;\n"
            "- Telas de sistemas/softwares: nomes de módulos, formulários, campos, botões, opções de seleção e valores padrão;\n"
            "- Diagramas e esquemas: arquitetura, fluxos lógicos, integrações e entidades de banco de dados;\n"
            "- Mensagens de status, avisos e rodapés de interface.\n\n"
            "FILTRO MANDATÓRIO ANTI-RUÍDO:\n"
            "- IGNORE completamente janelas de videoconferência (câmeras de participantes, contadores como '+15' pessoas, controles de chamada);\n"
            "- IGNORE barras de tarefas do sistema operacional (Windows/Mac) e menus padrão do Excel (como 'Arquivo', 'Exibir', zoom).\n"
            "Foque estritamente nas informações técnicas de negócio e dados projetados na tela.\n\n"
            "Estruture o resultado cronologicamente indicando para cada frame o instante de exibição e o texto extraído."
        )
    }]

    for idx, fr in enumerate(frames, start=1):
        try:
            b64_img = encode_image_base64(fr["path"])
            user_blocks.append({
                "type": "text",
                "text": f"--- [FRAME {idx:02d} @ {fr['time_str']} (arquivo: {fr['filename']})] ---"
            })
            user_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": b64_img
                }
            })
        except Exception as img_err:
            sys.stderr.write(f"Aviso: falha ao codificar frame {fr['path']}: {img_err}\n")

    payload = {
        "model": vision_model,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": user_blocks}]
    }

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers
    )

    try:
        sys.stderr.write(f"[Etapa 1/2] Extraindo OCR de {len(frames)} frames visuais com '{vision_model}' no Gateway ({gateway_url})...\n")
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = data.get("content", [])
            text_parts = [c.get("text", "") for c in content if c.get("type") == "text" and c.get("text")]
            ocr_text = "\n\n".join(text_parts).strip()
            sys.stderr.write(f"[Etapa 1/2] OCR concluído com sucesso: {len(ocr_text)} caracteres de evidências visuais extraídos.\n")
            return ocr_text
    except Exception as e:
        sys.stderr.write(f"Aviso na Etapa 1 (OCR de frames): {e}. Prosseguindo apenas com a transcrição do áudio.\n")
        return ""

def call_axet_code_synthesis(prompt_text: str, model: str) -> str:
    """
    Etapa 2: Invoca axet-code CLI para síntese aprofundada (documento exaustivo de 1.000+ linhas).
    """
    sys.stderr.write(f"[Etapa 2/2] Gerando relatório técnico aprofundado via axet-code (modelo: {model})...\n")
    cmd = ["axet-code", "run", "--quiet"]
    if model and model not in ("default", "auto"):
        cmd.extend(["-m", model])

    res = subprocess.run(
        cmd,
        input=prompt_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True
    )
    output = res.stdout.strip()

    # Se o axet-code gravou diretamente em arquivo .md no disco e retornou o caminho
    import re
    md_paths = re.findall(r"[`'\"]([^`'\"]+\.md)[`'\"]", output)
    for p in md_paths:
        if os.path.isfile(p) and os.path.getsize(p) > 1000:
            sys.stderr.write(f"Carregando relatório gerado pelo axet-code em: {p} ({os.path.getsize(p)} bytes)...\n")
            with open(p, "r", encoding="utf-8") as f:
                return f.read()

    return output

def call_gateway_text_synthesis(gateway_url: str, model: str, prompt_text: str) -> str:
    """Fallback para geração de texto via gateway se axet-code não estiver disponível."""
    endpoint = f"{gateway_url.rstrip('/')}/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01"
    }
    payload = {
        "model": model,
        "max_tokens": 16384,
        "messages": [{"role": "user", "content": prompt_text}]
    }
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers)
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        content = data.get("content", [])
        parts = [c.get("text", "") for c in content if c.get("type") == "text" and c.get("text")]
        return "\n\n".join(parts).strip()

def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--ocr-only":
        frames_dir = os.path.abspath(sys.argv[2])
        out_ocr_path = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else "ocr_context.txt"
        gateway_url = os.environ.get("LLM_GATEWAY_URL", DEFAULT_GATEWAY_URL)
        frames = load_frames(frames_dir, max_frames=15)
        ocr_visual_context = extract_ocr_from_frames(gateway_url, DEFAULT_VISION_MODEL, frames)
        os.makedirs(os.path.dirname(os.path.abspath(out_ocr_path)), exist_ok=True)
        with open(out_ocr_path, "w", encoding="utf-8") as f:
            f.write(ocr_visual_context or "")
        sys.stderr.write(f"OCR salvo em {out_ocr_path} ({len(ocr_visual_context)} bytes).\n")
        sys.exit(0)

    if len(sys.argv) < 5:
        sys.stderr.write("Uso: python3 scripts/analyze_video_multimodal.py <transcript_txt> <frames_dir> <prompt_template> <output_md> [model_name]\n")
        sys.exit(1)

    transcript_path = os.path.abspath(sys.argv[1])
    frames_dir = os.path.abspath(sys.argv[2])
    template_path = os.path.abspath(sys.argv[3])
    output_path = os.path.abspath(sys.argv[4])
    requested_model = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5].strip() else DEFAULT_SYNTHESIS_MODEL

    if not os.path.isfile(transcript_path):
        import unicodedata
        alt_nfd = unicodedata.normalize("NFD", transcript_path)
        alt_nfc = unicodedata.normalize("NFC", transcript_path)
        if os.path.isfile(alt_nfd):
            transcript_path = alt_nfd
        elif os.path.isfile(alt_nfc):
            transcript_path = alt_nfc
        else:
            sys.stderr.write(f"Erro: arquivo de transcrição não encontrado: {transcript_path}\n")
            sys.exit(1)

    transcript_text = read_file(transcript_path)
    template_text = read_file(template_path) if os.path.isfile(template_path) else ""

    gateway_url = os.environ.get("LLM_GATEWAY_URL", DEFAULT_GATEWAY_URL)
    frames = load_frames(frames_dir, max_frames=15)

    # 1. ETAPA 1: Extração especializada de OCR dos frames via Visão Multimodal
    ocr_visual_context = ""
    if frames:
        ocr_visual_context = extract_ocr_from_frames(gateway_url, DEFAULT_VISION_MODEL, frames)

    # Monta o contexto integrado (Fala + Evidências Visuais de OCR)
    full_input_context = f"""
# EVIDÊNCIAS VISUAIS EXTRAÍDAS DAS TELAS E SLIDES DO VÍDEO (OCR MULTIMODAL)
{ocr_visual_context if ocr_visual_context else "Nenhum frame visual específico disponível ou imagem em branco."}

---

# TRANSCRIÇÃO ORIGINAL DA FALA (WHISPER)
```text
{transcript_text}
```
"""

    if "{{CONTEUDO_ENTRADA}}" in template_text:
        final_prompt = template_text.replace("{{CONTEUDO_ENTRADA}}", full_input_context)
    elif "{{TRANSCRICAO}}" in template_text:
        combined = f"{ocr_visual_context}\n\n---\n\n{transcript_text}"
        final_prompt = template_text.replace("{{TRANSCRICAO}}", combined)
    else:
        final_prompt = f"{template_text}\n\n---\n\n{full_input_context}"

    # 2. ETAPA 2: Síntese e Documentação Técnica Exaustiva (1.000+ linhas sem truncamento)
    synthesis_model = requested_model
    if synthesis_model in ("eu.anthropic.claude-sonnet-5", "claude-sonnet-5", "default", "auto"):
        synthesis_model = DEFAULT_SYNTHESIS_MODEL

    result_text = None
    try:
        result_text = call_axet_code_synthesis(final_prompt, synthesis_model)
    except Exception as axet_err:
        sys.stderr.write(f"Aviso: chamada ao axet-code falhou ({axet_err}). Tentando síntese via Gateway...\n")
        try:
            result_text = call_gateway_text_synthesis(gateway_url, DEFAULT_VISION_MODEL, final_prompt)
        except Exception as gw_err:
            sys.stderr.write(f"Erro fatal: ambas as opções de síntese falharam ({gw_err})\n")
            sys.exit(1)

    if not result_text or len(result_text.strip()) < 150:
        sys.stderr.write("Erro: a síntese retornou conteúdo vazio ou insuficiente.\n")
        sys.exit(1)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(result_text)

    sys.stderr.write(f"Análise multimodal concluída com sucesso: {len(result_text)} bytes salvos em {output_path}.\n")
    print(json.dumps({"ok": True, "bytes": len(result_text), "model": synthesis_model, "has_ocr": bool(ocr_visual_context)}))

if __name__ == "__main__":
    main()
