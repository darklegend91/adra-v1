import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import xlsx from "xlsx";

const TEMPLATE_PATH = "data/ADR_Reporting_Form_1.4_Version.pdf";
const DEFAULT_WORKBOOK = "data/ADRA_Synthetic_Evaluation_Dataset.xlsx";
const DEFAULT_SHEET = "ADRA_ICSR_Synthetic";
const DEFAULT_OUTPUT_DIR = "output/filled_forms/ADRA";
const DEFAULT_LIMIT = 50;

const TEXT_FIELDS = {
  "Text Field0": "patientInitials",
  "Text Field3": "reportDate",
  "Text Field4": "region",
  "Text Field5": "weight",
  "Text Field7": "reaction",
  "Text Field8": "narrative",
  "Text Field10": "drug",
  "Text Field14": "dose",
  "Text Field15": "doseUnit",
  "Text Field16": "route",
  "Text Field17": "frequency",
  "Text Field20": "indication",
  "Text Field36": "outcome",
  "Text Field37": "causality",
  "Text Field47": "reporterType",
  "Text Field48": "onsetDate",
  "Text Field126": "age"
};

const CHECKBOX_FIELDS = {
  "Check Box0": "male",
  "Check Box17": "female",
  "Check Box18": "otherSex",
  "Check Box2": "death",
  "Check Box3": "lifeThreatening",
  "Check Box4": "hospitalisation",
  "Check Box5": "disability",
  "Check Box6": "congenital",
  "Check Box7": "otherSerious",
  "Check Box8": "recovered",
  "Check Box9": "recovering",
  "Check Box10": "notRecovered",
  "Check Box11": "unknownOutcome"
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workbookPath = options.input || DEFAULT_WORKBOOK;
  const sheetName = options.sheet || DEFAULT_SHEET;
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const limit = Number(options.limit || DEFAULT_LIMIT);

  const workbook = xlsx.readFile(workbookPath);
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) throw new Error(`Sheet not found: ${sheetName}`);
  const rows = xlsx.utils.sheet_to_json(worksheet, { defval: "" }).slice(0, limit);
  const templateBytes = await fs.readFile(TEMPLATE_PATH);
  await fs.mkdir(outputDir, { recursive: true });

  let written = 0;
  for (const row of rows) {
    const id = safeFileName(row.ICSR_ID || `row-${written + 1}`);
    const pdf = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
    const form = pdf.getForm();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const values = buildValues(row);

    for (const [fieldName, key] of Object.entries(TEXT_FIELDS)) {
      setText(form, fieldName, values.text[key]);
    }
    for (const [fieldName, key] of Object.entries(CHECKBOX_FIELDS)) {
      setCheckbox(form, fieldName, values.checks[key]);
    }
    form.updateFieldAppearances(font);

    await fs.writeFile(path.join(outputDir, `${id}.pdf`), await pdf.save());
    written += 1;
  }

  console.log(JSON.stringify({ workbookPath, sheetName, outputDir, written }, null, 2));
}

function buildValues(row) {
  const sex = normalise(row.Patient_Sex);
  const seriousness = normalise(row.SAE_Seriousness_Criteria);
  const outcome = normalise(row.Outcome);
  const reaction = [row.MedDRA_PT, row.MedDRA_SOC ? `MedDRA SOC: ${row.MedDRA_SOC}` : ""].filter(Boolean).join("\n");

  return {
    text: {
      patientInitials: initialsFromAnchor(row.Patient_Token || row.ICSR_ID),
      reportDate: value(row.Report_Date),
      region: value(row.Region || row.Site_ID),
      age: value(row.Patient_Age),
      weight: value(row.Patient_Weight_kg),
      reaction,
      narrative: value(row.Narrative).slice(0, 1000),
      drug: value(row.Suspect_Drug),
      dose: value(row.Drug_Dose_mg),
      doseUnit: row.Drug_Dose_mg ? "mg" : "",
      route: value(row.Drug_Route),
      frequency: value(row.Dose_Frequency),
      indication: value(row.Indication),
      outcome: value(row.Outcome),
      causality: value(row.Causality_Assessment),
      reporterType: value(row.Reporter_Type),
      onsetDate: value(row.Onset_Date)
    },
    checks: {
      male: sex === "male",
      female: sex === "female",
      otherSex: sex === "other",
      death: seriousness === "death",
      lifeThreatening: seriousness.includes("life"),
      hospitalisation: seriousness.includes("hospital"),
      disability: seriousness.includes("disability") || seriousness.includes("incapacity"),
      congenital: seriousness.includes("congenital"),
      otherSerious: seriousness.includes("other medically"),
      recovered: outcome === "recovered",
      recovering: outcome === "recovering",
      notRecovered: outcome === "not recovered",
      unknownOutcome: outcome === "unknown"
    }
  };
}

function initialsFromAnchor(anchor) {
  const text = value(anchor);
  if (!text) return "P.P.";
  let first = 0;
  let second = 7;
  for (let index = 0; index < text.length; index += 1) {
    first = (first + text.charCodeAt(index)) % 26;
    second = (second + text.charCodeAt(index) * (index + 1)) % 26;
  }
  return `${String.fromCharCode(65 + first)}.${String.fromCharCode(65 + second)}.`;
}

function setText(form, fieldName, valueToSet) {
  try {
    form.getTextField(fieldName).setText(value(valueToSet));
  } catch (_error) {
    // Template variants may omit some optional fields.
  }
}

function setCheckbox(form, fieldName, shouldCheck) {
  try {
    const checkbox = form.getCheckBox(fieldName);
    if (shouldCheck) checkbox.check();
    else checkbox.uncheck();
  } catch (_error) {
    // Template variants may omit some optional checkboxes.
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") options.input = args[++index];
    else if (arg === "--sheet") options.sheet = args[++index];
    else if (arg === "--output-dir") options.outputDir = args[++index];
    else if (arg === "--limit") options.limit = args[++index];
  }
  return options;
}

function value(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function normalise(input) {
  return value(input).toLowerCase();
}

function safeFileName(input) {
  return value(input).replace(/[\\/:*?"<>|]/g, "_") || "report";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
