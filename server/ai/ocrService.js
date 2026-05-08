import path from "path";
import { PDFParse } from "pdf-parse";
import xlsx from "xlsx";
import { extractPdfFormText } from "./pdfFormExtractor.js";
import { runOcr, findPiiBoxes, isImageMime, isPdfMime } from "./tesseractService.js";
import { cleanText } from "./textUtils.js";

const OCR_SUPPORTED_TEXT_MIN = 80;

export function buildSourceMetadata(file) {
  return {
    originalName: file.originalname,
    mimeType: file.mimetype,
    byteSize: file.size,
    extension: path.extname(file.originalname || "").toLowerCase(),
    processedAt: new Date().toISOString(),
    storagePolicy: "Original file processed in memory and discarded."
  };
}

export async function parseSourceDocument(file, sourceMetadata = buildSourceMetadata(file)) {
  const ext = sourceMetadata.extension;
  const mime = file.mimetype || "";

  // Images → Tesseract OCR directly
  if (isImageMime(mime) || [".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"].includes(ext)) {
    return parseImageOcr(file.buffer);
  }

  // PDF → try pdf-parse first; fall back to Tesseract if text is too sparse
  if (ext === ".pdf" || isPdfMime(mime)) return parsePdf(file.buffer);

  if ([".csv", ".xlsx", ".xls"].includes(ext)) return parseSpreadsheet(file.buffer);
  if (ext === ".json" || mime === "application/json") return parseJson(file.buffer);
  if (ext === ".xml") return parseXml(file.buffer);
  if ([".txt", ".text", ".md"].includes(ext) || mime.startsWith("text/")) return parseText(file.buffer, "text");

  return parseText(file.buffer, "plain-buffer");
}

// ── Image → Tesseract ─────────────────────────────────────────────────────────
async function parseImageOcr(buffer) {
  const ocr = await runOcr(buffer);
  const piiBoxes = findPiiBoxes(ocr.words);
  const text = cleanText(ocr.text);

  return {
    parser: "tesseract-ocr",
    text,
    needsOcr: false,
    rows: [],
    ocrMeta: {
      engine: ocr.ocrEngine,
      averageConfidence: ocr.averageConfidence,
      wordCount: ocr.wordCount,
      lang: ocr.lang,
      piiBoxes,
      piiBoxCount: piiBoxes.length
    },
    parserConfidence: ocr.averageConfidence,
    unknownFields: {
      ocrEngine: ocr.ocrEngine,
      ocrWordCount: ocr.wordCount,
      ocrAverageConfidence: ocr.averageConfidence,
      piiBoxesDetected: piiBoxes.length
    }
  };
}

// ── PDF → pdf-parse + AcroForm, Tesseract fallback for scanned ────────────────
async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const formExtraction = await extractPdfFormText(buffer);
    const result = await parser.getText();
    const digitalText = cleanText(
      [result.text || "", formExtraction.text].filter(Boolean).join("\n\n")
    );

    // Digital PDF — enough text extracted
    if (digitalText.length >= OCR_SUPPORTED_TEXT_MIN) {
      return {
        parser: formExtraction.filledFieldCount ? "pdf-parse+acroform" : "pdf-parse",
        text: digitalText,
        needsOcr: false,
        rows: [],
        parserConfidence: 0.72,
        unknownFields: {
          pages: result.total || 0,
          pdfFormFields: formExtraction.fieldCount,
          pdfFormFieldsFilled: formExtraction.filledFieldCount
        }
      };
    }

    // Sparse text → scanned PDF → try Tesseract on the raw buffer
    const ocr = await runOcr(buffer);
    const ocrText = cleanText(ocr.text);

    if (ocrText.length >= OCR_SUPPORTED_TEXT_MIN) {
      const piiBoxes = findPiiBoxes(ocr.words);
      return {
        parser: "tesseract-ocr-pdf",
        text: ocrText,
        needsOcr: false,
        rows: [],
        parserConfidence: ocr.averageConfidence,
        ocrMeta: {
          engine: ocr.ocrEngine,
          averageConfidence: ocr.averageConfidence,
          wordCount: ocr.wordCount,
          piiBoxes,
          piiBoxCount: piiBoxes.length,
          note: "Scanned PDF — text extracted via Tesseract OCR."
        },
        unknownFields: {
          pages: result.total || 0,
          ocrEngine: ocr.ocrEngine,
          ocrWordCount: ocr.wordCount,
          ocrAverageConfidence: ocr.averageConfidence
        }
      };
    }

    // Still too little text — mark for review but return whatever we have
    return {
      parser: "pdf-parse+ocr-low-confidence",
      text: [digitalText, ocrText].filter(Boolean).join("\n") || "",
      needsOcr: true,
      rows: [],
      parserConfidence: ocr.averageConfidence || 0.2,
      unknownFields: {
        pages: result.total || 0,
        ocrNote: "Low OCR yield — document may be too degraded or non-English."
      }
    };
  } finally {
    await parser.destroy();
  }
}

// ── Spreadsheet ───────────────────────────────────────────────────────────────
function parseSpreadsheet(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const rows = workbook.SheetNames.flatMap((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(sheet, { defval: "", raw: false }).map((row) => ({ sheetName, ...row }));
  });
  return {
    parser: "xlsx",
    text: cleanText(rows.map((row) => Object.values(row).join(" ")).join("\n")),
    needsOcr: false,
    rows,
    parserConfidence: 0.78,
    unknownFields: { sheets: workbook.SheetNames, rowCount: rows.length }
  };
}

// ── Plain formats ─────────────────────────────────────────────────────────────
function parseJson(buffer) {
  const parsed = JSON.parse(buffer.toString("utf8"));
  return {
    parser: "json",
    text: cleanText(JSON.stringify(parsed, null, 2)),
    needsOcr: false,
    rows: Array.isArray(parsed) ? parsed : [parsed],
    parserConfidence: 0.95,
    unknownFields: { rootType: Array.isArray(parsed) ? "array" : typeof parsed }
  };
}

function parseXml(buffer) {
  const xml = buffer.toString("utf8");
  return {
    parser: "xml-text",
    text: cleanText(xml.replace(/<[^>]+>/g, " ")),
    needsOcr: false,
    rows: [],
    parserConfidence: 0.90,
    unknownFields: { xmlLength: xml.length }
  };
}

function parseText(buffer, parser) {
  return {
    parser,
    text: cleanText(buffer.toString("utf8")),
    needsOcr: false,
    rows: [],
    parserConfidence: 0.95,
    unknownFields: {}
  };
}
