/**
 * HTTP client for the ADRA Python ML sidecar (localhost:7070).
 *
 * Every public function degrades gracefully: if the sidecar is down or a
 * call times out, the function throws so callers can fall back to local methods.
 *
 * Call checkSidecarHealth() once at server startup.  All other functions use
 * isSidecarAvailable() to skip the network call when the sidecar is absent.
 */

const rawSidecarUrl = process.env.SIDECAR_URL || "http://127.0.0.1:7070";
const SIDECAR_URL = /^https?:\/\//i.test(rawSidecarUrl) ? rawSidecarUrl : `http://${rawSidecarUrl}`;

// Timeouts
const HEALTH_TIMEOUT_MS   = 3_000;
const DEFAULT_TIMEOUT_MS  = 30_000;
const VOICE_TIMEOUT_MS    = 120_000;   // audio transcription can take a while

// null = not yet checked, true/false = result of last health check
let _available = null;

// ── Health ────────────────────────────────────────────────────────────────────

export async function checkSidecarHealth() {
  try {
    const res = await _fetch(`${SIDECAR_URL}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS);
    _available = res.ok;
    if (res.ok) {
      const data = await res.json();
      console.log("[Sidecar] Connected —", JSON.stringify(data.device_config || {}));
    } else {
      console.warn(`[Sidecar] Health check returned HTTP ${res.status} — falling back to local methods.`);
    }
  } catch {
    _available = false;
    console.warn("[Sidecar] Not reachable — all ML features will use local fallbacks.");
  }
  return _available;
}

export function isSidecarAvailable() {
  return _available === true;
}

// ── OCR ───────────────────────────────────────────────────────────────────────

/**
 * Run PP-OCRv5 on a raster image buffer.
 * @param {Buffer} imageBuffer
 * @param {{ lang?: string, runStructure?: boolean }} options
 */
export async function sidecarOcr(imageBuffer, options = {}) {
  return _post("/ocr", {
    image_b64: imageBuffer.toString("base64"),
    lang: options.lang ?? "en",
    run_structure: options.runStructure ?? false,
  });
}

// ── PDF table extraction ──────────────────────────────────────────────────────

/**
 * pdfplumber-based extraction — layout-aware text + medication table cells.
 * @param {Buffer} pdfBuffer
 * @param {number[]} pages  zero-indexed page numbers; [] = all pages
 */
export async function sidecarExtractPdf(pdfBuffer, pages = []) {
  return _post("/extract-pdf", {
    pdf_b64: pdfBuffer.toString("base64"),
    pages,
  });
}

// ── NER ───────────────────────────────────────────────────────────────────────

/**
 * Extract clinical entities from free-text narrative.
 * Returns: { drugs, diseases, dose, route, frequency, age, gender,
 *            onset_date, outcome, seriousness, negated, coverage }
 */
export async function sidecarNer(text) {
  return _post("/ner", { text });
}

// ── Language detection ────────────────────────────────────────────────────────

/**
 * Detect the language of a text snippet.
 * Returns: { lang, confidence, is_english, is_indic }
 */
export async function sidecarDetectLang(text) {
  return _post("/detect-lang", { text: text.slice(0, 500) }, 5_000);
}

// ── Translation ───────────────────────────────────────────────────────────────

/**
 * Translate Indic text to English via IndicTrans2.
 * @param {string} text
 * @param {string} srcLang  fastText 2-letter code e.g. "hi", "ta"
 */
export async function sidecarTranslate(text, srcLang) {
  return _post("/translate", { text, src_lang: srcLang });
}

// ── Voice ─────────────────────────────────────────────────────────────────────

/**
 * Transcribe an audio buffer with faster-whisper.
 * @param {Buffer} audioBuffer
 * @param {string} format  "mp3" | "wav" | "ogg" | "webm" | "m4a" | "flac"
 */
export async function sidecarVoice(audioBuffer, format = "mp3") {
  return _post(
    "/voice",
    { audio_b64: audioBuffer.toString("base64"), format },
    VOICE_TIMEOUT_MS,
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _post(path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await _fetch(
    `${SIDECAR_URL}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Sidecar ${path} → HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }

  return response.json();
}

function _fetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(
    () => clearTimeout(timer),
  );
}
