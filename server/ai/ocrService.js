import path from "path";
import { PDFParse } from "pdf-parse";
import xlsx from "xlsx";
import { extractPdfFormText } from "./pdfFormExtractor.js";
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
  const extension = sourceMetadata.extension;
  if (extension === ".pdf" || file.mimetype === "application/pdf") return parsePdf(file.buffer);
  if ([".csv", ".xlsx", ".xls"].includes(extension)) return parseSpreadsheet(file.buffer);
  if (extension === ".json" || file.mimetype === "application/json") return parseJson(file.buffer);
  if (extension === ".xml") return parseXml(file.buffer);
  if ([".txt", ".text", ".md"].includes(extension) || file.mimetype?.startsWith("text/")) return parseText(file.buffer, "text");
  if (file.mimetype?.startsWith("image/")) return parseImagePending();
  return parseText(file.buffer, "plain-buffer");
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const formExtraction = await extractPdfFormText(buffer);
    const result = await parser.getText();
    const text = cleanText([result.text || "", formExtraction.text].filter(Boolean).join("\n\n"));
    return {
      parser: formExtraction.filledFieldCount ? "pdf-parse+acroform" : "pdf-parse",
      text,
      needsOcr: text.length < OCR_SUPPORTED_TEXT_MIN,
      rows: [],
      unknownFields: {
        pages: result.total || 0,
        pdfFormFields: formExtraction.fieldCount,
        pdfFormFieldsFilled: formExtraction.filledFieldCount
      }
    };
  } finally {
    await parser.destroy();
  }
}

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
    unknownFields: { sheets: workbook.SheetNames, rowCount: rows.length }
  };
}

function parseJson(buffer) {
  const parsed = JSON.parse(buffer.toString("utf8"));
  return {
    parser: "json",
    text: cleanText(JSON.stringify(parsed, null, 2)),
    needsOcr: false,
    rows: Array.isArray(parsed) ? parsed : [parsed],
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
    unknownFields: { xmlLength: xml.length }
  };
}

function parseText(buffer, parser) {
  return {
    parser,
    text: cleanText(buffer.toString("utf8")),
    needsOcr: false,
    rows: [],
    unknownFields: {}
  };
}

function parseImagePending() {
  return {
    parser: "image-ocr-pending",
    text: "",
    needsOcr: true,
    rows: [],
    unknownFields: { imageOcr: "No OCR engine installed in this environment." }
  };
}
