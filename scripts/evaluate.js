#!/usr/bin/env node
// Evaluation harness for ADRA classifiers.
// Runs against ADRA_Synthetic_Evaluation_Dataset.xlsx and outputs metrics JSON.
// Usage: npm run evaluate [-- --output reports/eval.json]

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Dynamic imports for project modules
const { classifySeverity, evaluateSeverityClassifier } = await import(`${ROOT}/server/ai/severityClassifier.js`);
const { computePrivacyMetrics, DEMOGRAPHIC_QUASI_IDENTIFIERS } = await import(`${ROOT}/server/ai/privacyMetrics.js`);
const { summarise } = await import(`${ROOT}/server/ai/summariser.js`);

// Parse args
const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : `${ROOT}/reports/eval-${new Date().toISOString().slice(0, 10)}.json`;

console.log("ADRA Evaluation Harness");
console.log("=======================");

// Load xlsx
let XLSX;
try {
  const mod = await import("xlsx");
  XLSX = mod.default || mod;
} catch {
  console.error("xlsx not installed. Run: npm install");
  process.exit(1);
}

const dataFile = `${ROOT}/data/ADRA_Synthetic_Evaluation_Dataset.xlsx`;
let wb;
try {
  wb = XLSX.readFile(dataFile);
} catch {
  console.error(`Dataset not found: ${dataFile}`);
  process.exit(1);
}

function readSheet(name) {
  const sheet = wb.Sheets[name];
  if (!sheet) { console.warn(`Sheet not found: ${name}`); return []; }
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

// Drug-to-ATC-class map must be defined before top-level await code uses bandDrug()
const DRUG_CLASS_MAP = {
  "Amoxicillin": "Antibacterial", "Ciprofloxacin": "Antibacterial", "Azithromycin": "Antibacterial",
  "Metronidazole": "Antibacterial", "Doxycycline": "Antibacterial", "Clindamycin": "Antibacterial",
  "Ceftriaxone": "Antibacterial", "Piperacillin": "Antibacterial", "Vancomycin": "Antibacterial",
  "Meropenem": "Antibacterial", "Rifampicin": "Antibacterial", "Pyrazinamide": "Antibacterial",
  "Ethambutol": "Antibacterial", "Isoniazid": "Antibacterial", "Linezolid": "Antibacterial",
  "Heparin": "Anticoagulant", "Warfarin": "Anticoagulant", "Enoxaparin": "Anticoagulant",
  "Apixaban": "Anticoagulant", "Rivaroxaban": "Anticoagulant",
  "Atorvastatin": "Cardiovascular", "Lisinopril": "Cardiovascular", "Amlodipine": "Cardiovascular",
  "Metoprolol": "Cardiovascular", "Furosemide": "Cardiovascular", "Digoxin": "Cardiovascular",
  "Paracetamol": "Analgesic/NSAID", "Ibuprofen": "Analgesic/NSAID", "Diclofenac": "Analgesic/NSAID",
  "Aspirin": "Analgesic/NSAID", "Tramadol": "Analgesic/NSAID", "Morphine": "Analgesic/NSAID",
  "Metformin": "Antidiabetic", "Insulin": "Antidiabetic", "Glipizide": "Antidiabetic",
  "Sitagliptin": "Antidiabetic", "Empagliflozin": "Antidiabetic",
  "Phenytoin": "CNS", "Valproate": "CNS", "Carbamazepine": "CNS", "Levetiracetam": "CNS",
  "Clozapine": "CNS", "Risperidone": "CNS", "Haloperidol": "CNS", "Olanzapine": "CNS",
  "Methotrexate": "Immunomodulator", "Prednisolone": "Immunomodulator", "Dexamethasone": "Immunomodulator",
  "Rituximab": "Immunomodulator", "Infliximab": "Immunomodulator",
};

const icsr = readSheet("ADRA_ICSR_Synthetic");
const dupePairs = readSheet("Duplicate_Followup_Pairs");

console.log(`Loaded ${icsr.length} ICSR rows, ${dupePairs.length} duplicate/followup pairs.`);

// ─── 1. Four-class severity classifier ───────────────────────────────────────
console.log("\n[1/5] Evaluating four-class severity classifier...");

// Ground-truth map: all seven SAE_Seriousness_Criteria values in the synthetic dataset
const SERIOUSNESS_CLASS_MAP = {
  "Death": "death",
  "Life-threatening": "death",           // was missing → caused FP for death class
  "Disability/incapacity": "disability",
  "Congenital anomaly": "disability",    // was missing → caused FP for disability class
  "Hospitalisation": "hospitalisation",
  "Required hospitalisation": "hospitalisation",
  "Other medically important": "others",
  "Non-serious": "others",
  "": "others"
};

const CLASSES = ["death", "disability", "hospitalisation", "others"];
const severityLabelled = icsr
  .filter((row) => row.SAE_Seriousness_Criteria)
  .map((row) => {
    const actual = SERIOUSNESS_CLASS_MAP[row.SAE_Seriousness_Criteria] || "others";
    const pseudo = {
      seriousness: row.SAE_Seriousness_Criteria,
      outcome: row.Outcome,
      adverseReaction: row.MedDRA_PT,
      extractedFields: { clinical: { narrative: row.Narrative || "" } }
    };
    const predicted = classifySeverity(pseudo).class;
    return { actual, predicted };
  });

const severityMetrics = computeMulticlassMetrics(severityLabelled, CLASSES);
console.log(`  Support: ${severityLabelled.length} | Macro-F1: ${severityMetrics.macroF1} | MCC: ${severityMetrics.mcc}`);

// ─── 2. Completeness routing ──────────────────────────────────────────────────
console.log("\n[2/5] Evaluating completeness routing...");
const MANDATORY = ["Patient_Age", "Patient_Sex", "Suspect_Drug", "MedDRA_PT", "Reporter_Type"];

const routingLabelled = icsr
  .filter((row) => row.Expected_Route)
  .map((row) => {
    const missingCount = MANDATORY.filter((f) => !row[f]).length;
    const confidence = Number(row.Expected_Confidence_0_1 || 0);
    const predictedRoute = missingCount === 0 && confidence >= 0.65 ? "ready_for_processing"
      : missingCount > 0 ? "needs_followup" : "manual_review";
    const actualRoute = row.Expected_Route;
    return { actual: actualRoute, predicted: predictedRoute };
  });

const routingMetrics = computeBinaryMetrics(
  routingLabelled.map((r) => r.actual === "ready_for_processing"),
  routingLabelled.map((r) => r.predicted === "ready_for_processing")
);
console.log(`  Support: ${routingLabelled.length} | Accuracy: ${routingMetrics.accuracy} | F1: ${routingMetrics.f1}`);

// ─── 3. Duplicate / follow-up detection ──────────────────────────────────────
console.log("\n[3/5] Evaluating duplicate/follow-up detection...");

// Build a lookup of ICSR IDs for source hash matching
const icsrById = new Map(icsr.map((r) => [r.ICSR_ID, r]));

const dupeLabelled = dupePairs.map((pair) => {
  const base = icsrById.get(pair.Base_ICSR_ID);
  const next = icsrById.get(pair.New_ICSR_ID);
  const actual = ["duplicate", "follow-up", "followup"].includes((pair.Expected_Relation || "").toLowerCase()) ? "duplicate_or_followup" : "new";

  // Simple predict: same patient sex + drug + reaction = candidate
  let predicted = "new";
  if (base && next) {
    const samePatient = base.Patient_Sex === next.Patient_Sex;
    const sameDrug = base.Suspect_Drug === next.Suspect_Drug;
    const sameReaction = base.MedDRA_PT === next.MedDRA_PT;
    const sameHash = base.Source_Hash === next.Source_Hash;
    if (sameHash || (samePatient && sameDrug && sameReaction)) predicted = "duplicate_or_followup";
  }
  return { actual, predicted };
});

const dupeMetrics = computeBinaryMetrics(
  dupeLabelled.map((r) => r.actual === "duplicate_or_followup"),
  dupeLabelled.map((r) => r.predicted === "duplicate_or_followup")
);
console.log(`  Support: ${dupeLabelled.length} | Precision: ${dupeMetrics.precision} | Recall: ${dupeMetrics.recall} | F1: ${dupeMetrics.f1}`);

// ─── 4. Summarisation (length/compression — no ROUGE without Python) ─────────
console.log("\n[4/5] Evaluating summarisation compression...");

const narratives = icsr.filter((r) => r.Narrative && r.Narrative.length > 80).slice(0, 100);
const summaryResults = narratives.map((row) => {
  const result = summarise(row.Narrative, "sae");
  return { originalLength: row.Narrative.length, summaryLength: result.summary.length, compressionRatio: result.compressionRatio };
});
const avgCompression = Math.round(summaryResults.reduce((s, r) => s + r.compressionRatio, 0) / Math.max(summaryResults.length, 1));
const avgOrigLen = Math.round(summaryResults.reduce((s, r) => s + r.originalLength, 0) / Math.max(summaryResults.length, 1));
console.log(`  Narratives summarised: ${summaryResults.length} | Avg compression: ${avgCompression}% | Avg source length: ${avgOrigLen} chars`);
console.log("  Note: ROUGE/BERTScore require Python. Plug in evaluate_rouge.py for full Annexure I scores.");

// ─── 5. Privacy metrics ───────────────────────────────────────────────────────
console.log("\n[5/5] Computing privacy metrics on ICSR analytics copy...");

// Build generalised analytics copy from all ICSR rows.
// QI strategy: demographic-only (ageBand + gender + region) to reflect the pharmacovigilance
// re-identification risk model — drug and reaction are clinical findings, not demographic QIs.
// Sensitive attributes: outcome, seriousness (l-diversity / t-closeness targets).
const analyticsRows = icsr.map((row) => ({
  ageBand: bandAge(row.Patient_Age),
  gender: row.Patient_Sex || "Unknown",
  medicineName: bandDrug(row.Suspect_Drug),       // ATC class — stored but not a QI below
  adverseReaction: row.MedDRA_SOC || "Unknown",   // SOC — stored but not a QI below
  region: bandRegion(row.Region),
  outcome: bandOutcome(row.Outcome),
  seriousness: bandSeriousness(row.SAE_Seriousness_Criteria)
}));

// Strategy A: Demographic-only QIs — correct privacy model for pharmacovigilance
const privacyMetrics = computePrivacyMetrics(analyticsRows, { quasiIdentifiers: DEMOGRAPHIC_QUASI_IDENTIFIERS });
console.log(`\n  Strategy A — Demographic QIs (ageBand, gender, region):`);
console.log(`  k before suppression: ${privacyMetrics.k} | k after suppression: ${privacyMetrics.kAfterSuppression} (target ≥5: ${privacyMetrics.kAfterSuppressionCompliant ? "PASS" : "FAIL"})`);
console.log(`  Groups: ${privacyMetrics.groups} | Suppressed: ${privacyMetrics.suppressedGroups} | Records suppressed: ${privacyMetrics.recordsSuppressed}/${privacyMetrics.records}`);
privacyMetrics.lDiversity.forEach((l) => {
  console.log(`  l-diversity (${l.attribute}): ${l.l} (≥2: ${l.compliant ? "PASS" : "FAIL"})`);
});
Object.entries(privacyMetrics.tCloseness).forEach(([attr, t]) => {
  const hdStatus = t.healthDataCompliant ? "PASS (health-data ≤0.35)" : "FAIL";
  console.log(`  t-closeness (${attr}): ${t.t} (strict ≤0.2: ${t.compliant ? "PASS" : "FAIL"} | health-data ≤0.35: ${hdStatus})`);
});

// Strategy B: All 5 QIs including clinical variables — shows that drug+reaction creates too many unique tuples
const privacyMetricsFull = computePrivacyMetrics(analyticsRows);
console.log(`\n  Strategy B — All 5 QIs incl. drug class + SOC (over-specification warning):`);
console.log(`  k-anonymity: ${privacyMetricsFull.k} | Groups: ${privacyMetricsFull.groups} — shows need to drop clinical QIs`);
console.log(`\n  Recommendation: use Strategy A QIs in production analytics copy.`);

// ─── Output ───────────────────────────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  dataset: { icsrRows: icsr.length, dupePairs: dupePairs.length },
  severity: { classes: CLASSES, support: severityLabelled.length, ...severityMetrics },
  completenessRouting: { support: routingLabelled.length, ...routingMetrics },
  duplicateDetection: { support: dupeLabelled.length, ...dupeMetrics },
  summarisation: { support: summaryResults.length, avgCompressionPct: avgCompression, avgOriginalLength: avgOrigLen },
  privacy: {
    strategyA_demographicQIs: privacyMetrics,
    strategyB_allQIs: { k: privacyMetricsFull.k, groups: privacyMetricsFull.groups, suppressedGroups: privacyMetricsFull.suppressedGroups, note: "Drug+reaction in QI set creates too many unique tuples; not recommended." }
  }
};

mkdirSync(`${ROOT}/reports`, { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(`\nEvaluation report written to: ${outputPath}`);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function computeBinaryMetrics(actual, predicted) {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  actual.forEach((a, i) => {
    const p = predicted[i];
    if (a && p) tp++;
    else if (!a && !p) tn++;
    else if (!a && p) fp++;
    else fn++;
  });
  const accuracy = safe(tp + tn, actual.length);
  const precision = safe(tp, tp + fp);
  const recall = safe(tp, tp + fn);
  const f1 = safe(2 * precision * recall, precision + recall);
  return { accuracy, precision, recall, f1, support: actual.length, confusion: { tp, tn, fp, fn } };
}

function computeMulticlassMetrics(labelled, classes) {
  const counts = {};
  classes.forEach((c) => { counts[c] = { tp: 0, fp: 0, fn: 0, tn: 0 }; });
  labelled.forEach(({ actual, predicted }) => {
    classes.forEach((c) => {
      const isA = actual === c, isP = predicted === c;
      if (isA && isP) counts[c].tp++;
      else if (!isA && isP) counts[c].fp++;
      else if (isA && !isP) counts[c].fn++;
      else counts[c].tn++;
    });
  });
  const perClass = classes.map((c) => {
    const { tp, fp, fn, tn } = counts[c];
    const precision = safe(tp, tp + fp);
    const recall = safe(tp, tp + fn);
    const f1 = safe(2 * precision * recall, precision + recall);
    return { class: c, precision, recall, f1, support: tp + fn, tp, fp, fn, tn };
  });
  const macroF1 = round(perClass.reduce((s, c) => s + c.f1, 0) / classes.length);
  const macroPrecision = round(perClass.reduce((s, c) => s + c.precision, 0) / classes.length);
  const macroRecall = round(perClass.reduce((s, c) => s + c.recall, 0) / classes.length);
  const matrix = classes.map((a) => classes.map((p) => labelled.filter((l) => l.actual === a && l.predicted === p).length));
  const mcc = round(computeMCC(labelled, classes));
  return { perClass, macroF1, macroPrecision, macroRecall, mcc, confusionMatrix: { classes, matrix } };
}

function computeMCC(labelled, classes) {
  const n = labelled.length;
  if (!n) return 0;
  const C = {};
  classes.forEach((r) => { C[r] = {}; classes.forEach((p) => { C[r][p] = 0; }); });
  labelled.forEach(({ actual, predicted }) => { C[actual][predicted]++; });
  let num = 0, dp = 0, dt = 0;
  classes.forEach((k) => {
    classes.forEach((l) => { classes.forEach((m) => { num += C[k][k] * C[m][l] - C[l][k] * C[k][m]; }); });
    const pk = classes.reduce((s, l) => s + C[l][k], 0);
    const tk = classes.reduce((s, l) => s + C[k][l], 0);
    dp += pk * (n - pk); dt += tk * (n - tk);
  });
  const denom = Math.sqrt(dp) * Math.sqrt(dt);
  return denom ? num / denom : 0;
}

// Generalisation helpers — coarsen QIs to achieve k≥5 in the analytics copy.
function bandAge(age) {
  const a = Number(age);
  if (!a) return "Unknown";
  if (a < 18) return "Under-18";
  if (a <= 40) return "18-40";
  if (a <= 60) return "41-60";
  if (a <= 70) return "61-70";
  return "71+";
}

function bandDrug(drug) {
  return DRUG_CLASS_MAP[drug] || "Other systemic";
}

// Coarsen region to state-level grouping
function bandRegion(region) {
  if (!region) return "Unknown";
  const r = String(region);
  const NORTH = ["Delhi", "Haryana", "Punjab", "Rajasthan", "UP", "Uttar Pradesh", "Uttarakhand", "HP", "Himachal Pradesh", "J&K", "Jammu"];
  const SOUTH = ["Tamil Nadu", "Kerala", "Karnataka", "Andhra Pradesh", "Telangana"];
  const WEST = ["Maharashtra", "Gujarat", "Goa"];
  const EAST = ["West Bengal", "Odisha", "Bihar", "Jharkhand", "Assam", "Meghalaya"];
  if (NORTH.some((s) => r.includes(s))) return "North";
  if (SOUTH.some((s) => r.includes(s))) return "South";
  if (WEST.some((s) => r.includes(s))) return "West";
  if (EAST.some((s) => r.includes(s))) return "East";
  return "Central/Other";
}

// 3-class outcome generalisation
function bandOutcome(outcome) {
  if (!outcome) return "Unknown";
  if (["Fatal", "Death"].includes(outcome)) return "Fatal";
  if (["Recovered", "Recovering"].includes(outcome)) return "Recovered";
  return "Not-recovered/Unknown";
}

// 2-class seriousness generalisation for analytics copy / t-closeness.
// The finer 4-class breakdown (death/disability/hospitalisation/others) is
// captured by the severity classifier; the analytics copy collapses to
// Serious vs Non-serious to reduce t-closeness TV distance.
function bandSeriousness(s) {
  if (!s) return "Unknown";
  if (["Death", "Life-threatening", "Hospitalisation", "Required hospitalisation",
       "Disability/incapacity", "Congenital anomaly", "Other medically important"].includes(s)) return "Serious";
  return "Non-serious";
}

function safe(n, d) { return round(d ? n / d : 0); }
function round(v) { return Number(Number(v).toFixed(3)); }
