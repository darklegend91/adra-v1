import fs from "fs/promises";
import path from "path";
import xlsx from "xlsx";
import { classifyCaseRelation } from "../ai/caseLinkage.js";
import { processUploadedReport } from "../reportProcessor.js";

const DEFAULT_WORKBOOK = "data/ADRA_Synthetic_Evaluation_Dataset.xlsx";
const DEFAULT_OUTPUT_DIR = "output/filled_forms/ADRA";
const EVAL_XLSX = "output/ADRA_Output_Evaluation.xlsx";
const EVAL_MD = "output/ADRA_Output_Evaluation.md";

const FIELD_CHECKS = [
  { key: "medicine", expected: "Suspect_Drug", actual: (r) => r.medicineName },
  { key: "reaction", expected: "MedDRA_PT", actual: (r) => r.adverseReaction },
  { key: "age", expected: "Patient_Age", actual: (r) => r.extractedFields?.patient?.age },
  { key: "sex", expected: "Patient_Sex", actual: (r) => r.gender },
  { key: "outcome", expected: "Outcome", actual: (r) => r.outcome },
  { key: "seriousness", expected: "SAE_Seriousness_Criteria", actual: (r) => r.seriousness },
  { key: "route", expected: "Expected_Route", actual: (r) => r.scoreSnapshots?.[0]?.route },
  { key: "relation", expected: "Expected_Relation", actual: (_r, relation) => relation.relation }
];

async function main() {
  const workbookPath = process.argv[2] || DEFAULT_WORKBOOK;
  const outputDir = process.argv[3] || DEFAULT_OUTPUT_DIR;

  const workbook = xlsx.readFile(workbookPath);
  const expectedRows = xlsx.utils.sheet_to_json(workbook.Sheets.ADRA_ICSR_Synthetic, { defval: "" });
  const expectedById = new Map(expectedRows.map((row) => [String(row.ICSR_ID), row]));
  const files = (await fs.readdir(outputDir))
    .filter((file) => file.toLowerCase().endsWith(".pdf"))
    .sort();

  const priorProcessed = [];
  const perReport = [];
  const errors = [];
  const counters = Object.fromEntries(FIELD_CHECKS.map((field) => [field.key, { compared: 0, matched: 0 }]));

  for (const fileName of files) {
    const icsrId = path.basename(fileName, ".pdf");
    const expected = expectedById.get(icsrId);
    const fullPath = path.join(outputDir, fileName);
    const buffer = await fs.readFile(fullPath);
    const processed = await processUploadedReport({
      file: {
        buffer,
        originalname: fileName,
        mimetype: "application/pdf",
        size: buffer.length
      },
      user: { id: "evaluation", role: "super_admin", center: "Evaluation" }
    });
    const relation = classifyCaseRelation(processed, priorProcessed);
    priorProcessed.push(processed);

    const reportResult = {
      ICSR_ID: icsrId,
      File: fullPath,
      Expected_Present: Boolean(expected),
      Parser: processed.sourceMetadata.parser,
      Text_Length: processed.sourceMetadata.extractedTextLength,
      Processing_Status: processed.processingStatus,
      Expected_Medicine: expected?.Suspect_Drug || "",
      Extracted_Medicine: processed.medicineName || "",
      Expected_Reaction: expected?.MedDRA_PT || "",
      Extracted_Reaction: processed.adverseReaction || "",
      Expected_Age: expected?.Patient_Age || "",
      Extracted_Age: processed.extractedFields?.patient?.age || "",
      Expected_Sex: expected?.Patient_Sex || "",
      Extracted_Sex: processed.gender || "",
      Expected_Outcome: expected?.Outcome || "",
      Extracted_Outcome: processed.outcome || "",
      Expected_Seriousness: expected?.SAE_Seriousness_Criteria || "",
      Extracted_Seriousness: processed.seriousness || "",
      Expected_Route: expected?.Expected_Route || "",
      Extracted_Route: processed.scoreSnapshots?.[0]?.route || "",
      Expected_Relation: expected?.Expected_Relation || "",
      Extracted_Relation: relation.relation,
      Score: processed.scoreSnapshots?.[0]?.score || 0,
      Expected_Score: expected?.Expected_Score_0_100 || "",
      Confidence: processed.confidence?.overall || 0,
      Expected_Confidence: expected?.Expected_Confidence_0_1 || "",
      Missing_Fields: (processed.scoreSnapshots?.[0]?.missingFields || []).join(", "),
      Relation_Basis: relation.basis
    };

    for (const field of FIELD_CHECKS) {
      if (!expected) continue;
      const expectedValue = expected[field.expected];
      const actualValue = field.actual(processed, relation);
      const isMatched = isEquivalent(field.key, expectedValue, actualValue);
      counters[field.key].compared += 1;
      if (isMatched) counters[field.key].matched += 1;
      reportResult[`${field.key}_Match`] = isMatched ? "Yes" : "No";
      if (!isMatched) {
        errors.push({
          ICSR_ID: icsrId,
          Field: field.key,
          Expected: expectedValue,
          Actual: actualValue || "",
          Error_Type: classifyError(expectedValue, actualValue),
          Notes: errorNote(field.key, expectedValue, actualValue)
        });
      }
    }

    perReport.push(reportResult);
  }

  const fieldAccuracy = Object.entries(counters).map(([field, value]) => ({
    Field: field,
    Compared: value.compared,
    Matched: value.matched,
    Accuracy: value.compared ? round4(value.matched / value.compared) : 0
  }));

  const comparedCells = fieldAccuracy.reduce((sum, row) => sum + row.Compared, 0);
  const matchedCells = fieldAccuracy.reduce((sum, row) => sum + row.Matched, 0);
  const summary = [
    { Metric: "ADRA PDF files evaluated", Value: files.length },
    { Metric: "Expected rows matched by ICSR_ID", Value: perReport.filter((row) => row.Expected_Present).length },
    { Metric: "Overall field accuracy", Value: comparedCells ? round4(matchedCells / comparedCells) : 0 },
    { Metric: "Total field errors", Value: errors.length },
    { Metric: "Processable PDF rate", Value: round4(perReport.filter((row) => row.Processing_Status === "processed").length / Math.max(perReport.length, 1)) },
    { Metric: "Average extracted confidence", Value: round4(avg(perReport.map((row) => row.Confidence))) },
    { Metric: "Average expected confidence", Value: round4(avg(perReport.map((row) => Number(row.Expected_Confidence || 0)))) },
    { Metric: "Main failure pattern", Value: topErrorPattern(errors) }
  ];

  await writeWorkbook(summary, fieldAccuracy, errors, perReport);
  await writeMarkdown(summary, fieldAccuracy, errors);
  console.log(JSON.stringify({ evaluationWorkbook: EVAL_XLSX, evaluationReport: EVAL_MD, files: files.length, errors: errors.length }, null, 2));
}

async function writeWorkbook(summary, fieldAccuracy, errors, perReport) {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(summary), "Summary");
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(fieldAccuracy), "Field_Accuracy");
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(errors), "Errors");
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(perReport), "Per_Report");
  xlsx.writeFile(workbook, EVAL_XLSX, { compression: true });
}

async function writeMarkdown(summary, fieldAccuracy, errors) {
  const lines = [
    "# ADRA Output Evaluation",
    "",
    "## Summary",
    ...summary.map((row) => `- ${row.Metric}: ${row.Value}`),
    "",
    "## Field Accuracy",
    "| Field | Compared | Matched | Accuracy |",
    "|---|---:|---:|---:|",
    ...fieldAccuracy.map((row) => `| ${row.Field} | ${row.Compared} | ${row.Matched} | ${Math.round(row.Accuracy * 100)}% |`),
    "",
    "## Top Errors",
    "| ICSR | Field | Expected | Actual | Error Type |",
    "|---|---|---|---|---|",
    ...errors.slice(0, 50).map((row) => `| ${row.ICSR_ID} | ${row.Field} | ${safeCell(row.Expected)} | ${safeCell(row.Actual)} | ${row.Error_Type} |`)
  ];
  await fs.writeFile(EVAL_MD, `${lines.join("\n")}\n`);
}

function isEquivalent(field, expected, actual) {
  const expectedValue = normalise(expected);
  const actualValue = normalise(actual);
  if (!expectedValue && !actualValue) return true;
  if (!expectedValue || !actualValue) return false;
  if (field === "sex") {
    return expectedValue[0] === actualValue[0];
  }
  if (field === "seriousness") {
    if (expectedValue === "non serious") return actualValue === "non serious" || actualValue === "non-serious";
    return expectedValue === actualValue;
  }
  return expectedValue === actualValue;
}

function classifyError(expected, actual) {
  const expectedValue = normalise(expected);
  const actualValue = normalise(actual);
  if (!actualValue) return "missing_extraction";
  if (!expectedValue) return "unexpected_extraction";
  if (["reporting form", "(s) *", "suspected medication(s)", "date"].includes(actualValue)) return "template_label_extracted";
  return "wrong_value";
}

function errorNote(field, expected, actual) {
  const actualValue = normalise(actual);
  if (["reporting form", "(s) *", "suspected medication(s)", "date"].includes(actualValue)) {
    return `Extractor captured a PDF template label instead of the ${field} value.`;
  }
  if (!actualValue) return `Extractor did not return a ${field} value.`;
  return `Extractor returned a different ${field} value than the synthetic ground truth.`;
}

function topErrorPattern(errors) {
  if (!errors.length) return "No errors";
  const counts = errors.reduce((map, row) => {
    map[row.Error_Type] = (map[row.Error_Type] || 0) + 1;
    return map;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} (${value})`)[0];
}

function normalise(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function avg(values) {
  const filtered = values.map(Number).filter((value) => Number.isFinite(value));
  return filtered.reduce((sum, value) => sum + value, 0) / Math.max(filtered.length, 1);
}

function round4(value) {
  return Number(Number(value || 0).toFixed(4));
}

function safeCell(value) {
  return String(value || "").replace(/\|/g, "/").slice(0, 120);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

