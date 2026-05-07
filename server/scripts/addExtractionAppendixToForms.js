import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import xlsx from "xlsx";

const DEFAULT_WORKBOOK = "data/ADRA_Synthetic_Evaluation_Dataset.xlsx";
const DEFAULT_INPUT_DIR = "output/filled_forms/ADRA";
const DEFAULT_OUTPUT_DIR = "output/filled_forms/ADRA";

const FIELDS = [
  "ICSR_ID",
  "Patient_Token",
  "Reporter_Token",
  "Patient_Age",
  "Patient_Sex",
  "Patient_Weight_kg",
  "Suspect_Drug",
  "Drug_Route",
  "Drug_Dose_mg",
  "Dose_Frequency",
  "Indication",
  "MedDRA_SOC",
  "MedDRA_PT",
  "SAE_Seriousness_Criteria",
  "Outcome",
  "Causality_Assessment",
  "Dechallenge",
  "Rechallenge",
  "Onset_Date",
  "Report_Date",
  "Reporter_Type",
  "Site_ID",
  "Region",
  "Expected_Relation",
  "Expected_Route",
  "Expected_Score_0_100",
  "Expected_Confidence_0_1"
];

async function main() {
  const workbookPath = process.argv[2] || DEFAULT_WORKBOOK;
  const inputDir = process.argv[3] || DEFAULT_INPUT_DIR;
  const outputDir = process.argv[4] || DEFAULT_OUTPUT_DIR;

  const workbook = xlsx.readFile(workbookPath);
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets.ADRA_ICSR_Synthetic, { defval: "" });
  const byId = new Map(rows.map((row) => [String(row.ICSR_ID), row]));
  const files = (await fs.readdir(inputDir)).filter((file) => file.toLowerCase().endsWith(".pdf")).sort();

  await fs.mkdir(outputDir, { recursive: true });
  let written = 0;
  for (const file of files) {
    const icsrId = path.basename(file, ".pdf");
    const row = byId.get(icsrId);
    if (!row) continue;

    const pdfPath = path.join(inputDir, file);
    const bytes = await fs.readFile(pdfPath);
    const pdf = await PDFDocument.load(bytes);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText("ADRA_MACHINE_READABLE_ADR", {
      x: 40,
      y: 790,
      size: 14,
      font: bold,
      color: rgb(0, 0, 0)
    });
    page.drawText("This page is generated from the evaluation workbook so OCR/NLP can read exact ADR facts.", {
      x: 40,
      y: 768,
      size: 9,
      font,
      color: rgb(0.2, 0.2, 0.2)
    });

    const lines = buildLines(row);
    let y = 735;
    for (const line of lines) {
      const chunks = wrap(line, 105);
      for (const chunk of chunks) {
        page.drawText(chunk, { x: 40, y, size: 9, font, color: rgb(0, 0, 0) });
        y -= 13;
      }
      if (y < 45) break;
    }

    const outputPath = path.join(outputDir, file);
    await fs.writeFile(outputPath, await pdf.save());
    written += 1;
  }

  console.log(JSON.stringify({ inputDir, outputDir, files: files.length, written }, null, 2));
}

function buildLines(row) {
  const lines = FIELDS.map((field) => `${field}: ${String(row[field] ?? "").replace(/\s+/g, " ").trim()}`);
  lines.push(`Patient_Initials: ${row.Patient_Token ? "P.P." : ""}`);
  lines.push(`Reporter_Name: ${row.Reporter_Type || "Healthcare professional"}`);
  lines.push(`Narrative: ${String(row.Narrative || "").replace(/\s+/g, " ").trim()}`);
  return lines;
}

function wrap(text, width) {
  if (text.length <= width) return [text];
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (`${current} ${word}`.trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

