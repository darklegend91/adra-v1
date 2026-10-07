/**
 * Document ingestion and OCR pipeline.
 *
 * Format routing:
 *   Digital fillable PDF  → pdf-lib AcroForm  (existing, ~97% accuracy)
 *   Digital text PDF      → sidecar pdfplumber → fallback pdf-parse
 *   Image                 → sidecar PP-OCRv5  → fallback Tesseract.js
 *   Scanned PDF           → embedded page image OCR → rendered page OCR fallback
 *   Audio (mp3/wav/…)     → sidecar faster-whisper
 *   XLSX / CSV            → xlsx library
 *   JSON                  → direct parse
 *   XML                   → tag-value extraction + MACHINE_LABEL mapping
 *   Plain text            → buffer decode
 *
 * Every sidecar call falls back to a local method when the sidecar is down.
 */

import path from "path";
import { PDFParse } from "pdf-parse";
import xlsx from "xlsx";
import { extractPdfFormText } from "./pdfFormExtractor.js";
import { runOcr, findPiiBoxes, isImageMime, isPdfMime } from "./tesseractService.js";
import { cleanText } from "./textUtils.js";
import {
  isSidecarAvailable,
  sidecarOcr,
  sidecarExtractPdf,
  sidecarVoice,
} from "./sidecarClient.js";

const DIGITAL_TEXT_MIN   = 80;   // chars — below this we treat a PDF as scanned
const PDF_OCR_PAGE_LIMIT  = 3;    // keep intake responsive; ADR forms are usually short
const ADR_REGION_OCR_TEXT_MIN = 120;
const AUDIO_EXTENSIONS   = new Set([".mp3", ".wav", ".ogg", ".webm", ".m4a", ".flac", ".opus"]);
const AUDIO_MIMES        = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/ogg", "audio/webm", "audio/mp4", "audio/flac", "audio/opus",
]);

// ── Public API ────────────────────────────────────────────────────────────────

export function buildSourceMetadata(file) {
  return {
    originalName: file.originalname,
    mimeType: file.mimetype,
    byteSize: file.size,
    extension: path.extname(file.originalname || "").toLowerCase(),
    processedAt: new Date().toISOString(),
    storagePolicy: "Original file processed in memory and discarded.",
  };
}

export async function parseSourceDocument(file, sourceMetadata = buildSourceMetadata(file)) {
  const ext  = sourceMetadata.extension;
  const mime = file.mimetype || "";

  if (AUDIO_MIMES.has(mime) || AUDIO_EXTENSIONS.has(ext))
    return parseAudio(file.buffer, ext.replace(".", "") || "mp3");

  if (isImageMime(mime) || [".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"].includes(ext))
    return parseImage(file.buffer);

  if (ext === ".pdf" || isPdfMime(mime))
    return parsePdf(file.buffer);

  if ([".csv", ".xlsx", ".xls"].includes(ext))
    return parseSpreadsheet(file.buffer);

  if (ext === ".json" || mime === "application/json")
    return parseJson(file.buffer);

  if (ext === ".xml" || mime === "application/xml" || mime === "text/xml")
    return parseXml(file.buffer);

  if ([".txt", ".text", ".md"].includes(ext) || mime.startsWith("text/"))
    return parsePlainText(file.buffer);

  return parsePlainText(file.buffer);
}

// ── Audio ─────────────────────────────────────────────────────────────────────

async function parseAudio(buffer, format) {
  if (!isSidecarAvailable()) {
    return _stub("voice-unsupported", "Voice transcription requires the Python sidecar (faster-whisper).");
  }
  try {
    const result = await sidecarVoice(buffer, format);
    return {
      parser: "faster-whisper",
      text: cleanText(result.text || ""),
      needsOcr: false,
      rows: [],
      parserConfidence: result.language_probability ?? 0.9,
      unknownFields: {
        voiceLanguage: result.language,
        voiceDuration: result.duration,
        voiceSegments: result.segments?.length ?? 0,
      },
    };
  } catch (err) {
    console.warn("[OCR] Voice transcription failed:", err.message);
    return _stub("voice-error", `Voice transcription failed: ${err.message}`);
  }
}

// ── Image ─────────────────────────────────────────────────────────────────────

async function parseImage(buffer) {
  // Sidecar PP-OCRv5 preferred; Tesseract.js fallback
  if (isSidecarAvailable()) {
    try {
      const result = await sidecarOcr(buffer, { runStructure: false });
      return _ocrResult(result, "pp-ocrv5");
    } catch (err) {
      console.warn("[OCR] Sidecar OCR failed, falling back to Tesseract:", err.message);
    }
  }
  return _tesseractOcr(buffer);
}

// ── PDF ───────────────────────────────────────────────────────────────────────

async function parsePdf(buffer) {
  // Step 1 — AcroForm extraction (highest accuracy for fillable PDFs, ~97%)
  const formExtraction = await extractPdfFormText(buffer);

  // Step 2 — pdfplumber via sidecar for layout-aware text + medication table
  if (isSidecarAvailable()) {
    try {
      const plumber = await sidecarExtractPdf(buffer, []);
      const plumberText = cleanText(
        [plumber.text, formExtraction.text].filter(Boolean).join("\n\n")
      );

      if (plumberText.length >= DIGITAL_TEXT_MIN) {
        return {
          parser: formExtraction.filledFieldCount ? "pdfplumber+acroform" : "pdfplumber",
          text: plumberText,
          needsOcr: false,
          rows: _plumberTablesToRows(plumber.tables),
          parserConfidence: 0.88,
          unknownFields: {
            pdfFormFields: formExtraction.fieldCount,
            pdfFormFieldsFilled: formExtraction.filledFieldCount,
            plumberTables: plumber.tables?.length ?? 0,
            plumberWords: plumber.words?.length ?? 0,
          },
        };
      }
    } catch (err) {
      console.warn("[OCR] pdfplumber sidecar failed, trying pdf-parse:", err.message);
    }
  }

  // Step 3 — pdf-parse fallback (digital text PDFs)
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const digitalText = cleanText(
      [result.text, formExtraction.text].filter(Boolean).join("\n\n")
    );

    if (digitalText.length >= DIGITAL_TEXT_MIN) {
      return {
        parser: formExtraction.filledFieldCount ? "pdf-parse+acroform" : "pdf-parse",
        text: digitalText,
        needsOcr: false,
        rows: [],
        parserConfidence: 0.72,
        unknownFields: {
          pages: result.total ?? 0,
          pdfFormFields: formExtraction.fieldCount,
          pdfFormFieldsFilled: formExtraction.filledFieldCount,
        },
      };
    }

    const imageOcr = await _ocrPdfImages(parser, {
      pages: result.total ?? 0,
      pdfFormFields: formExtraction.fieldCount,
      pdfFormFieldsFilled: formExtraction.filledFieldCount,
    });
    if (imageOcr.text.length >= DIGITAL_TEXT_MIN) return imageOcr;

    return _pdfNeedsOcr([digitalText, imageOcr.text].filter(Boolean).join("\n\n"), {
      pages: result.total ?? 0,
      pdfFormFields: formExtraction.fieldCount,
      pdfFormFieldsFilled: formExtraction.filledFieldCount,
      ...imageOcr.unknownFields,
    });
  } finally {
    await parser.destroy();
  }
}

// ── Spreadsheet ───────────────────────────────────────────────────────────────

function parseSpreadsheet(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const rows = workbook.SheetNames.flatMap((sheetName) =>
    xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false }).map(
      (row) => ({ sheetName, ...row })
    )
  );
  return {
    parser: "xlsx",
    text: cleanText(rows.map((row) => Object.values(row).join(" ")).join("\n")),
    needsOcr: false,
    rows,
    parserConfidence: 0.78,
    unknownFields: { sheets: workbook.SheetNames, rowCount: rows.length },
  };
}

// ── JSON ──────────────────────────────────────────────────────────────────────

function parseJson(buffer) {
  const parsed = JSON.parse(buffer.toString("utf8"));
  return {
    parser: "json",
    text: cleanText(JSON.stringify(parsed, null, 2)),
    needsOcr: false,
    rows: Array.isArray(parsed) ? parsed : [parsed],
    parserConfidence: 0.95,
    unknownFields: { rootType: Array.isArray(parsed) ? "array" : typeof parsed },
  };
}

// ── XML ───────────────────────────────────────────────────────────────────────
// Proper tag-value extraction + mapping to MACHINE_LABEL format so the
// existing nlpExtractor machineField() logic can read it correctly.

const XML_TO_MACHINE_LABEL = {
  patientinitials: "Patient_Initials",
  initials: "Patient_Initials",
  patientage: "Patient_Age",
  age: "Patient_Age",
  sex: "Patient_Sex",
  gender: "Patient_Sex",
  patientweight: "Patient_Weight_kg",
  weight: "Patient_Weight_kg",
  suspectdrug: "Suspect_Drug",
  drug: "Suspect_Drug",
  medicationname: "Suspect_Drug",
  meddrapt: "MedDRA_PT",
  adversereaction: "MedDRA_PT",
  pt: "MedDRA_PT",
  dose: "Drug_Dose_mg",
  drugdose: "Drug_Dose_mg",
  route: "Drug_Route",
  drugroute: "Drug_Route",
  frequency: "Dose_Frequency",
  dosefrequency: "Dose_Frequency",
  indication: "Indication",
  outcome: "Outcome",
  seriousness: "SAE_Seriousness_Criteria",
  saecriteria: "SAE_Seriousness_Criteria",
  reportername: "Reporter_Name",
  reporter: "Reporter_Name",
  onsetdate: "Onset_Date",
  reactionstartdate: "Onset_Date",
  narrative: "Narrative",
  description: "Narrative",
  reportdate: "Report_Date",
  region: "Region",
  causality: "Causality_Assessment",
};

function parseXml(buffer) {
  const xml = buffer.toString("utf8");
  const tagValues = _extractXmlTagValues(xml);
  const lines = ["ADRA_MACHINE_READABLE_ADR"];
  const mapped = new Set();

  for (const [rawTag, value] of Object.entries(tagValues)) {
    const label = XML_TO_MACHINE_LABEL[rawTag.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (label && !mapped.has(label)) {
      lines.push(`${label}: ${value}`);
      mapped.add(label);
    }
  }

  // Append any unmapped tag-values as plain context
  for (const [tag, value] of Object.entries(tagValues)) {
    const normalised = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!XML_TO_MACHINE_LABEL[normalised]) {
      lines.push(`${tag}: ${value}`);
    }
  }

  const text = lines.length > 1
    ? cleanText(lines.join("\n"))
    : cleanText(xml.replace(/<[^>]+>/g, " "));

  return {
    parser: "xml-parsed",
    text,
    needsOcr: false,
    rows: Object.keys(tagValues).length ? [tagValues] : [],
    parserConfidence: 0.90,
    unknownFields: { xmlLength: xml.length, fieldsFound: Object.keys(tagValues).length },
  };
}

function _extractXmlTagValues(xml) {
  const values = {};
  // Match <Tag attr="...">leaf-text-only</Tag> — handles simple and attribute-bearing tags
  const pattern = /<([A-Za-z][A-Za-z0-9_:.-]*)[^>]*>([^<]{1,500})<\/\1>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const tag = match[1];
    const value = match[2].trim();
    if (value && !values[tag]) values[tag] = value;
  }
  return values;
}

// ── Plain text ────────────────────────────────────────────────────────────────

function parsePlainText(buffer) {
  return {
    parser: "plaintext",
    text: cleanText(buffer.toString("utf8")),
    needsOcr: false,
    rows: [],
    parserConfidence: 0.95,
    unknownFields: {},
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _tesseractOcr(buffer) {
  const ocr = await runOcr(buffer);
  const piiBoxes = findPiiBoxes(ocr.words);
  const text = cleanText(ocr.text);
  return {
    parser: "tesseract-ocr",
    text,
    needsOcr: Boolean(ocr.error) || text.length < DIGITAL_TEXT_MIN,
    rows: [],
    ocrMeta: {
      engine: ocr.ocrEngine,
      averageConfidence: ocr.averageConfidence,
      wordCount: ocr.wordCount,
      piiBoxes,
      piiBoxCount: piiBoxes.length,
    },
    parserConfidence: ocr.averageConfidence,
    unknownFields: {
      ocrEngine: ocr.ocrEngine,
      ocrWordCount: ocr.wordCount,
      ocrAverageConfidence: ocr.averageConfidence,
      ocrError: ocr.error || "",
      piiBoxesDetected: piiBoxes.length,
    },
  };
}

async function _ocrPdfImages(parser, fields = {}) {
  const pageTexts = [];
  const ocrMeta = [];
  let imagesSeen = 0;

  try {
    const extractedImages = await parser.getImage({
      first: PDF_OCR_PAGE_LIMIT,
      imageThreshold: 0,
      imageBuffer: true,
      imageDataUrl: false,
    });

    for (const page of extractedImages.pages || []) {
      const images = (page.images || [])
        .filter((image) => image?.data?.length)
        .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
      for (const image of images.slice(0, 1)) {
        imagesSeen += 1;
        const ocr = await runOcr(Buffer.from(image.data));
        const text = cleanText(ocr.text);
        const regionHints = await _ocrAdrFormRegions(image, text);
        if (text || regionHints.length) pageTexts.push(_withRegionHints(text, regionHints));
        ocrMeta.push({
          page: page.page,
          source: "embedded-image",
          width: image.width || 0,
          height: image.height || 0,
          textLength: text.length,
          confidence: ocr.averageConfidence || 0,
          wordCount: ocr.wordCount || 0,
          error: ocr.error || "",
          regionHints: regionHints.length,
        });
      }
    }
  } catch (err) {
    ocrMeta.push({ source: "embedded-image", error: err.message });
  }

  if (!pageTexts.join("").trim()) {
    try {
      const screenshots = await parser.getScreenshot({
        first: PDF_OCR_PAGE_LIMIT,
        desiredWidth: 1400,
        imageBuffer: true,
        imageDataUrl: false,
      });
      for (const page of screenshots.pages || []) {
        if (!page?.data?.length) continue;
        const ocr = await runOcr(Buffer.from(page.data));
        const text = cleanText(ocr.text);
        if (text) pageTexts.push(text);
        ocrMeta.push({
          page: page.page,
          source: "rendered-page",
          width: page.width || 0,
          height: page.height || 0,
          textLength: text.length,
          confidence: ocr.averageConfidence || 0,
          wordCount: ocr.wordCount || 0,
          error: ocr.error || "",
        });
      }
    } catch (err) {
      ocrMeta.push({ source: "rendered-page", error: err.message });
    }
  }

  const text = cleanText(pageTexts.join("\n\n"));
  const confidences = ocrMeta.map((m) => m.confidence).filter((n) => n > 0);
  const parserConfidence = confidences.length
    ? Number((confidences.reduce((sum, n) => sum + n, 0) / confidences.length).toFixed(3))
    : 0.25;

  return {
    parser: "pdf-image-tesseract-ocr",
    text,
    needsOcr: text.length < DIGITAL_TEXT_MIN,
    rows: [],
    parserConfidence,
    unknownFields: {
      ...fields,
      pdfImagesSeen: imagesSeen,
      pdfOcrPages: ocrMeta.length,
      pdfOcrMeta: ocrMeta,
      ocrNote: text.length >= DIGITAL_TEXT_MIN
        ? "Scanned PDF text extracted from embedded/rasterized page image using Tesseract.js."
        : "PDF image OCR ran but produced too little text for reliable extraction.",
    },
  };
}

async function _ocrAdrFormRegions(image, fullPageText) {
  const pageText = String(fullPageText || "").toLowerCase();
  const likelyAdrForm =
    pageText.includes("reaction reporting form") ||
    pageText.includes("adverse drug") ||
    pageText.includes("suspected") ||
    pageText.length < ADR_REGION_OCR_TEXT_MIN;
  if (!likelyAdrForm || !image?.data?.length || !image.width || !image.height) return [];

  const regions = [
    { key: "narrative", box: [0.055, 0.305, 0.49, 0.145], scale: 5, threshold: 150 },
    { key: "drug_name", box: [0.075, 0.480, 0.135, 0.030], scale: 8, threshold: 150 },
    { key: "medication_row", box: [0.075, 0.476, 0.630, 0.065], scale: 6, threshold: 150 },
    { key: "reporter", box: [0.500, 0.710, 0.440, 0.080], scale: 6, threshold: 150 },
  ];

  const hints = [];
  for (const region of regions) {
    try {
      const buffer = await _preprocessImageRegion(image, region);
      if (!buffer) continue;
      const ocr = await runOcr(buffer);
      const text = cleanText(ocr.text);
      if (text) hints.push({ key: region.key, text });
    } catch (err) {
      hints.push({ key: region.key, text: "", error: err.message });
    }
  }
  return hints.filter((hint) => hint.text);
}

async function _preprocessImageRegion(image, region) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const source = await loadImage(Buffer.from(image.data));
  const [rx, ry, rw, rh] = region.box;
  const sx = Math.max(0, Math.floor(rx * source.width));
  const sy = Math.max(0, Math.floor(ry * source.height));
  const sw = Math.min(source.width - sx, Math.ceil(rw * source.width));
  const sh = Math.min(source.height - sy, Math.ceil(rh * source.height));
  if (sw <= 0 || sh <= 0) return null;

  const scale = region.scale || 4;
  const canvas = createCanvas(sw * scale, sh * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const threshold = region.threshold || 150;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = (0.299 * pixels.data[i]) + (0.587 * pixels.data[i + 1]) + (0.114 * pixels.data[i + 2]);
    const v = gray < threshold ? 0 : 255;
    pixels.data[i] = v;
    pixels.data[i + 1] = v;
    pixels.data[i + 2] = v;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toBuffer("image/png");
}

function _withRegionHints(text, hints) {
  if (!hints.length) return text;
  return cleanText([
    text,
    "ADRA_OCR_REGION_HINTS",
    ...hints.map((hint) => `ADRA_OCR_REGION_${hint.key.toUpperCase()}: ${hint.text}`),
  ].filter(Boolean).join("\n"));
}

function _pdfNeedsOcr(text, fields = {}) {
  return {
    parser: "pdf-parse+needs-ocr",
    text: cleanText(text || ""),
    needsOcr: true,
    rows: [],
    parserConfidence: 0.2,
    unknownFields: {
      ...fields,
      ocrNote: "PDF has too little extractable digital text, and PDF image OCR produced too little text for reliable extraction.",
    },
  };
}

function _ocrResult(sidecarResult, parserName) {
  return {
    parser: parserName,
    text: cleanText(sidecarResult.text || ""),
    needsOcr: false,
    rows: [],
    parserConfidence: sidecarResult.average_confidence ?? 0.88,
    ocrMeta: {
      engine: sidecarResult.engine ?? "PP-OCRv5",
      averageConfidence: sidecarResult.average_confidence ?? 0,
      wordCount: sidecarResult.word_count ?? 0,
    },
    unknownFields: {
      ocrEngine: sidecarResult.engine ?? "PP-OCRv5",
      ocrWordCount: sidecarResult.word_count ?? 0,
      ocrAverageConfidence: sidecarResult.average_confidence ?? 0,
    },
  };
}

function _plumberTablesToRows(tables) {
  if (!Array.isArray(tables)) return [];
  return tables.flatMap((table) =>
    (table.rows || []).slice(1).map((row) => {
      const headers = table.rows[0] || [];
      return Object.fromEntries(
        headers.map((h, i) => [String(h ?? `col${i}`).trim(), String(row[i] ?? "").trim()])
      );
    })
  );
}

function _stub(parser, note) {
  return {
    parser,
    text: "",
    needsOcr: false,
    rows: [],
    parserConfidence: 0,
    unknownFields: { note },
  };
}
