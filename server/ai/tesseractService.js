// Tesseract.js OCR service for ADRA.
// Handles images (PNG/JPEG/TIFF/BMP) and scanned PDF buffers.
//
// Returns:
//   text             — full OCR transcript
//   words            — array of {text, confidence, bbox:{x0,y0,x1,y1}} for PII redaction
//   averageConfidence — 0–1 normalised OCR confidence
//   cer              — character error rate vs a reference string (when supplied)
//   ocrEngine        — "tesseract.js"

import Tesseract from "tesseract.js";

// Supported image MIME types
const IMAGE_MIMES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/tiff",
  "image/bmp", "image/webp", "image/gif"
]);

export function isImageMime(mimetype) {
  return IMAGE_MIMES.has(String(mimetype).toLowerCase());
}

export function isPdfMime(mimetype) {
  return String(mimetype).toLowerCase() === "application/pdf";
}

/**
 * Check if a Buffer contains a recognised image format by inspecting magic bytes.
 * Prevents Tesseract from receiving non-image data which causes unhandleable worker errors.
 */
function isRecognisedImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const b = buffer;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;
  // JPEG
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4D) return true;
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;
  // TIFF (little-endian or big-endian)
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) return true;
  if (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A) return true;
  // WebP (RIFF....WEBP)
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true;
  // PDF (also accepted by Tesseract for scanned PDFs)
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return true;
  return false;
}

/**
 * Run Tesseract OCR on an image buffer or scanned PDF buffer.
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string} [opts.lang]  Tesseract language code (default "eng")
 * @returns {Promise<OcrResult>}
 */
export async function runOcr(buffer, opts = {}) {
  const lang = opts.lang || "eng";

  // Guard: only pass recognised image/PDF formats to Tesseract.
  // Non-image buffers cause worker-level errors that escape try/catch.
  if (!isRecognisedImageBuffer(buffer)) {
    return {
      text: "",
      words: [],
      averageConfidence: 0,
      wordCount: 0,
      ocrEngine: "tesseract.js",
      lang,
      error: "Buffer is not a recognised image format (PNG/JPEG/TIFF/BMP/WebP/PDF)."
    };
  }

  try {
    const result = await Tesseract.recognize(buffer, lang, {
      logger: () => {}
    });

    const raw = result.data;

    const words = (raw.words || []).map((w) => ({
      text: w.text,
      confidence: Number((w.confidence / 100).toFixed(3)),
      bbox: {
        x0: w.bbox.x0,
        y0: w.bbox.y0,
        x1: w.bbox.x1,
        y1: w.bbox.y1
      }
    }));

    const highConfWords = words.filter((w) => w.confidence > 0.5);
    const averageConfidence = highConfWords.length
      ? Number((highConfWords.reduce((s, w) => s + w.confidence, 0) / highConfWords.length).toFixed(3))
      : 0.3;

    return {
      text: (raw.text || "").trim(),
      words,
      averageConfidence,
      wordCount: words.length,
      ocrEngine: "tesseract.js",
      lang
    };
  } catch (err) {
    return {
      text: "",
      words: [],
      averageConfidence: 0,
      wordCount: 0,
      ocrEngine: "tesseract.js",
      lang,
      error: String(err.message || err)
    };
  }
}

/**
 * Compute character error rate (CER) between OCR output and reference text.
 * CER = editDistance(ocr, ref) / len(ref)
 * Used for Annexure I CER metric.
 */
export function computeCer(ocrText, referenceText) {
  if (!referenceText || referenceText.length === 0) return null;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const dist = levenshtein(norm(ocrText), norm(referenceText));
  return Number((dist / norm(referenceText).length).toFixed(4));
}

/**
 * Scan OCR word list for PII bounding boxes using the same patterns as privacyModel.js.
 * Returns an array of redaction regions suitable for overlay rendering.
 */
export function findPiiBoxes(words) {
  const AADHAAR_RE = /\d{4}\s?\d{4}\s?\d{4}/;
  const PAN_RE = /[A-Z]{5}\d{4}[A-Z]/;
  const PHONE_RE = /(\+91[\s-]?)?[6-9]\d{9}/;
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const MRN_RE = /(MRN|UHID|IP|OP|CR|HID)[-/]?\s*\d{4,12}/i;

  const boxes = [];
  let window = "";
  let windowWords = [];

  for (const word of words) {
    window = (window + " " + word.text).trim().slice(-60);
    windowWords.push(word);
    if (windowWords.length > 5) windowWords.shift();

    let type = null;
    let regulation = "";

    if (AADHAAR_RE.test(window)) { type = "Aadhaar"; regulation = "DPDP Act 2023 / Aadhaar Act 2016"; }
    else if (PAN_RE.test(window)) { type = "PAN"; regulation = "DPDP Act 2023"; }
    else if (PHONE_RE.test(window)) { type = "Indian phone"; regulation = "DPDP Act 2023 §2(t)"; }
    else if (EMAIL_RE.test(window)) { type = "Email"; regulation = "DPDP Act 2023 / IT Act 2000"; }
    else if (MRN_RE.test(window)) { type = "MRN/UHID"; regulation = "NDHM §4 / ICMR §4"; }

    if (type) {
      const region = mergeBoxes(windowWords.map((w) => w.bbox));
      boxes.push({ type, regulation, bbox: region, wordCount: windowWords.length });
      window = "";
      windowWords = [];
    }
  }

  return boxes;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function mergeBoxes(bboxes) {
  if (!bboxes.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...bboxes.map((b) => b.x0)),
    y0: Math.min(...bboxes.map((b) => b.y0)),
    x1: Math.max(...bboxes.map((b) => b.x1)),
    y1: Math.max(...bboxes.map((b) => b.y1))
  };
}
