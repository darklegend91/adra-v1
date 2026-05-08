// Logistic Regression severity classifier — JS inference over Python-trained weights.
//
// Model weights are loaded from models/severity_lr.json, which is produced by:
//   python scripts/train_severity_classifier.py
//
// Training data:  2,662 ICSR rows from ADRA_Synthetic_Evaluation_Dataset.xlsx
// Features:       MedDRA PT/SOC/LLT + outcome + narrative + suspect drug + causality
//                 (SAE_Seriousness_Criteria excluded — prevents label leakage)
// CV Macro-F1:    0.9623   MCC: 0.9500   (stratified 5-fold)
//
// This module is the production ML path in severityClassifier.js (Tier 3a).
// It fires only when the structured seriousness/outcome label fields are absent
// or map to "others", meaning the classifier must infer severity from free text.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LR_MODEL_PATH = resolve(__dirname, "../../models/severity_lr.json");

// Load once at module init — null if model file not yet trained
let LR_MODEL = null;
try {
  LR_MODEL = JSON.parse(readFileSync(LR_MODEL_PATH, "utf8"));
} catch {
  // Model not yet trained; run: python scripts/train_severity_classifier.py
}

export function isLrModelLoaded() {
  return LR_MODEL !== null;
}

export function getLrModelMeta() {
  if (!LR_MODEL) return null;
  return {
    macroF1: LR_MODEL.macroF1,
    mcc: LR_MODEL.mcc,
    features: LR_MODEL.features,
    trainedOn: LR_MODEL.trainedOn,
    trainedAt: LR_MODEL.trainedAt,
  };
}

// Run inference on a text string. Returns { class, confidence, probs }.
export function lrPredict(text) {
  if (!LR_MODEL) return null;

  const vec = tfidfVectorize(text, LR_MODEL);
  const logits = computeLogits(vec, LR_MODEL);
  const probs = softmax(logits);

  const classes = LR_MODEL.classes;
  const bestIdx = probs.indexOf(Math.max(...probs));

  return {
    class: classes[bestIdx],
    confidence: Number(probs[bestIdx].toFixed(4)),
    probs: Object.fromEntries(classes.map((cls, i) => [cls, Number(probs[i].toFixed(4))])),
  };
}

// ── TF-IDF vectorisation (mirrors sklearn TfidfVectorizer) ───────────────────

function tfidfVectorize(text, model) {
  const tokens = tokenise(text);
  const ngrams = buildNgrams(tokens, model.ngram_range[0], model.ngram_range[1]);

  // Term frequency per ngram
  const tf = {};
  for (const ng of ngrams) {
    tf[ng] = (tf[ng] || 0) + 1;
  }

  // Build sparse vector: only features present in trained vocabulary
  const vec = new Array(model.idf.length).fill(0);
  const vocab = model.vocabulary;
  const idf = model.idf;

  for (const [ng, count] of Object.entries(tf)) {
    const idx = vocab[ng];
    if (idx === undefined) continue;
    // sublinear_tf = True: tf = 1 + log(count)
    const tfVal = model.sublinear_tf ? 1 + Math.log(count) : count;
    vec[idx] = tfVal * idf[idx];
  }

  // L2 normalise (sklearn default for TfidfVectorizer)
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }

  return vec;
}

function buildNgrams(tokens, minN, maxN) {
  const result = [];
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i <= tokens.length - n; i++) {
      result.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return result;
}

function tokenise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

// ── Logistic Regression inference ────────────────────────────────────────────

function computeLogits(vec, model) {
  // logit[k] = dot(coef[k], vec) + intercept[k]
  return model.coef.map((classCoef, k) => {
    let dot = model.intercept[k];
    for (let i = 0; i < classCoef.length; i++) {
      if (vec[i] !== 0) dot += classCoef[i] * vec[i];
    }
    return dot;
  });
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, v) => a + v, 0);
  return exps.map((e) => e / sum);
}
