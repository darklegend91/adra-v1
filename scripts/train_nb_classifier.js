#!/usr/bin/env node
// Train a Multinomial Naive Bayes severity classifier on the synthetic ICSR dataset.
// Produces models/severity_nb.json which severityClassifier.js loads at startup.
//
// Usage: npm run train
//
// Training details:
//   Features: bag-of-words unigrams from narrative + seriousness + outcome + reaction text
//   Classes:  death | disability | hospitalisation | others
//   Smoothing: Laplace (alpha = 1)
//   Class priors: uniform (to handle class imbalance — avoids bias toward "others" at 70%)
//   Evaluation: 5-fold stratified cross-validation + full-dataset final model

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let XLSX;
try {
  const mod = await import("xlsx");
  XLSX = mod.default || mod;
} catch {
  console.error("xlsx not installed. Run: npm install"); process.exit(1);
}

const { tokenise } = await import(`${ROOT}/server/ai/severityClassifier.js`);

const CLASSES = ["death", "disability", "hospitalisation", "others"];
const ALPHA = 1;     // Laplace smoothing
const K_FOLDS = 5;

const SERIOUSNESS_CLASS_MAP = {
  "Death": "death", "Life-threatening": "death",
  "Disability/incapacity": "disability", "Congenital anomaly": "disability",
  "Hospitalisation": "hospitalisation", "Required hospitalisation": "hospitalisation",
  "Other medically important": "others", "Non-serious": "others"
};

// ── Load data ─────────────────────────────────────────────────────────────────
const dataFile = `${ROOT}/data/ADRA_Synthetic_Evaluation_Dataset.xlsx`;
const wb = XLSX.readFile(dataFile);
const icsr = XLSX.utils.sheet_to_json(wb.Sheets["ADRA_ICSR_Synthetic"], { defval: "" });

const labelled = icsr
  .filter((r) => SERIOUSNESS_CLASS_MAP[r.SAE_Seriousness_Criteria])
  .map((r) => ({
    label: SERIOUSNESS_CLASS_MAP[r.SAE_Seriousness_Criteria],
    text: [r.Narrative || "", r.SAE_Seriousness_Criteria || "", r.Outcome || "", r.MedDRA_PT || ""].join(" ")
  }));

console.log(`Naive Bayes Classifier Training`);
console.log(`================================`);
console.log(`Labelled samples: ${labelled.length}`);
CLASSES.forEach((c) => console.log(`  ${c}: ${labelled.filter((r) => r.label === c).length}`));

// ── 5-fold stratified CV ──────────────────────────────────────────────────────
console.log(`\n[1/2] ${K_FOLDS}-fold stratified cross-validation...`);

// Stratified shuffle per class
const byClass = {};
CLASSES.forEach((c) => { byClass[c] = shuffle(labelled.filter((r) => r.label === c)); });

// Build K folds: each fold has proportional samples per class
const folds = Array.from({ length: K_FOLDS }, () => []);
CLASSES.forEach((c) => {
  byClass[c].forEach((item, idx) => folds[idx % K_FOLDS].push(item));
});

const cvResults = [];
for (let fold = 0; fold < K_FOLDS; fold++) {
  const testFold = folds[fold];
  const trainFold = folds.filter((_, i) => i !== fold).flat();
  const model = trainNB(trainFold);
  const metrics = evaluateNB(model, testFold);
  cvResults.push(metrics);
  console.log(`  Fold ${fold + 1}: Macro-F1=${metrics.macroF1.toFixed(3)} MCC=${metrics.mcc.toFixed(3)}`);
}

const avgMacroF1 = avg(cvResults.map((r) => r.macroF1));
const avgMCC = avg(cvResults.map((r) => r.mcc));
console.log(`  CV Average: Macro-F1=${avgMacroF1.toFixed(3)} MCC=${avgMCC.toFixed(3)}`);

// ── Train final model on full dataset ─────────────────────────────────────────
console.log(`\n[2/2] Training final model on full dataset...`);
const finalModel = trainNB(labelled);
const fullMetrics = evaluateNB(finalModel, labelled);
console.log(`  Full-dataset: Macro-F1=${fullMetrics.macroF1.toFixed(3)} MCC=${fullMetrics.mcc.toFixed(3)}`);
console.log(`  (Full-dataset numbers are optimistic — use CV average for reporting)`);

// ── Per-class results ──────────────────────────────────────────────────────────
console.log(`\n  Per-class (CV average):`);
CLASSES.forEach((cls, i) => {
  const p = avg(cvResults.map((r) => r.perClass[i].precision));
  const r = avg(cvResults.map((r) => r.perClass[i].recall));
  const f = avg(cvResults.map((r) => r.perClass[i].f1));
  console.log(`    ${cls.padEnd(16)} P=${p.toFixed(3)} R=${r.toFixed(3)} F1=${f.toFixed(3)}`);
});

// ── Save model ────────────────────────────────────────────────────────────────
const outputPath = `${ROOT}/models/severity_nb.json`;
mkdirSync(`${ROOT}/models`, { recursive: true });

const savedModel = {
  ...finalModel,
  trainingMeta: {
    trainedAt: new Date().toISOString(),
    samples: labelled.length,
    cvFolds: K_FOLDS,
    cvMacroF1: round(avgMacroF1),
    cvMCC: round(avgMCC),
    fullDatasetMacroF1: round(fullMetrics.macroF1),
    fullDatasetMCC: round(fullMetrics.mcc),
    perClassCV: CLASSES.map((cls, i) => ({
      class: cls,
      precision: round(avg(cvResults.map((r) => r.perClass[i].precision))),
      recall: round(avg(cvResults.map((r) => r.perClass[i].recall))),
      f1: round(avg(cvResults.map((r) => r.perClass[i].f1)))
    }))
  }
};

writeFileSync(outputPath, JSON.stringify(savedModel, null, 2));
console.log(`\nModel saved to: ${outputPath}`);
console.log(`Restart the server to activate the NB classifier.`);

// ── Training functions ────────────────────────────────────────────────────────
function trainNB(data) {
  const vocab = new Set();
  const classDocs = {};
  CLASSES.forEach((c) => { classDocs[c] = []; });

  data.forEach(({ label, text }) => {
    const tokens = tokenise(text);
    tokens.forEach((t) => vocab.add(t));
    if (classDocs[label]) classDocs[label].push(tokens);
  });

  const vocabList = [...vocab];
  const vocabSize = vocabList.length;

  // Uniform log priors (handle class imbalance)
  const logPriors = {};
  CLASSES.forEach((c) => { logPriors[c] = Math.log(1 / CLASSES.length); });

  // Log word probabilities with Laplace smoothing
  const logWordProbs = {};
  CLASSES.forEach((c) => {
    const allTokens = classDocs[c].flat();
    const totalCount = allTokens.length + vocabSize * ALPHA;
    const counts = {};
    allTokens.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    logWordProbs[c] = {};
    vocabList.forEach((t) => {
      logWordProbs[c][t] = Math.log(((counts[t] || 0) + ALPHA) / totalCount);
    });
  });

  return { classes: CLASSES, logPriors, logWordProbs, vocabSize, alpha: ALPHA };
}

function evaluateNB(model, data) {
  const counts = {};
  CLASSES.forEach((c) => { counts[c] = { tp: 0, fp: 0, fn: 0, tn: 0 }; });

  const labelled = data.map(({ label, text }) => {
    const tokens = tokenise(text);
    const scores = {};
    CLASSES.forEach((c) => {
      let lp = model.logPriors[c];
      tokens.forEach((t) => { if (model.logWordProbs[c]?.[t]) lp += model.logWordProbs[c][t]; });
      scores[c] = lp;
    });
    const predicted = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    return { actual: label, predicted };
  });

  labelled.forEach(({ actual, predicted }) => {
    CLASSES.forEach((c) => {
      const isA = actual === c, isP = predicted === c;
      if (isA && isP) counts[c].tp++;
      else if (!isA && isP) counts[c].fp++;
      else if (isA && !isP) counts[c].fn++;
      else counts[c].tn++;
    });
  });

  const perClass = CLASSES.map((c) => {
    const { tp, fp, fn } = counts[c];
    const precision = safe(tp, tp + fp);
    const recall = safe(tp, tp + fn);
    const f1 = safe(2 * precision * recall, precision + recall);
    return { class: c, precision, recall, f1 };
  });

  const macroF1 = avg(perClass.map((c) => c.f1));
  const mcc = computeMCC(labelled);
  return { macroF1, mcc, perClass };
}

function computeMCC(labelled) {
  const n = labelled.length;
  const C = {};
  CLASSES.forEach((r) => { C[r] = {}; CLASSES.forEach((p) => { C[r][p] = 0; }); });
  labelled.forEach(({ actual, predicted }) => { C[actual][predicted]++; });
  let num = 0, dp = 0, dt = 0;
  CLASSES.forEach((k) => {
    CLASSES.forEach((l) => { CLASSES.forEach((m) => { num += C[k][k] * C[m][l] - C[l][k] * C[k][m]; }); });
    const pk = CLASSES.reduce((s, l) => s + C[l][k], 0);
    const tk = CLASSES.reduce((s, l) => s + C[k][l], 0);
    dp += pk * (n - pk); dt += tk * (n - tk);
  });
  const denom = Math.sqrt(dp) * Math.sqrt(dt);
  return denom ? num / denom : 0;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function safe(n, d) { return d ? n / d : 0; }
function avg(arr) { return arr.reduce((s, v) => s + v, 0) / Math.max(arr.length, 1); }
function round(v) { return Number(Number(v).toFixed(4)); }
