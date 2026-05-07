// Canonical CDSCO four-class severity classifier.
// Output classes: death | disability | hospitalisation | others
// Order of precedence: death > disability > hospitalisation > others
//
// Two classifiers are available:
//   1. Rule-based (always available)
//   2. Naive Bayes (loaded from models/severity_nb.json if present — train with npm run train)
// The classifier that achieves the higher Macro-F1 on the evaluation set is preferred.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NB_MODEL_PATH = resolve(__dirname, "../../models/severity_nb.json");

// Load trained NB model once at module init (null if not trained yet)
let NB_MODEL = null;
try {
  NB_MODEL = JSON.parse(readFileSync(NB_MODEL_PATH, "utf8"));
} catch {
  // Model not yet trained; rule-based classifier will be used
}

const DEATH_RE = /\b(death|died|fatal(ity)?|deceased|mortali(ty|ties)|dead)\b/i;
// Disability requires specific, unambiguous terms — generic "not recovered" is excluded
const DISABILITY_RE = /\b(disabilit\w*|permanent\s+(incapacit\w*|harm|damage)|blind(ness)?|paralys\w*|paralyz\w*|deaf(ness)?|amput\w*|quadripleg\w*|hemiplegia|congenital\s+anomaly)\b/i;
const HOSPITALISATION_RE = /\b(hospital\w*|admitted|admission|inpatient|in-patient|emergency\s+(room|dept|visit|care)|ER\b|ICU\b|intensive\s+care|ward\s+admit|prolonged\s+(stay|hospitali\w*)|re-admiss\w*)\b/i;

const SERIOUSNESS_MAP = {
  "Death": "death",
  "Life-threatening": "death",
  "Fatal": "death",
  "Disability/incapacity": "disability",
  "Congenital anomaly": "disability",
  "Hospitalisation": "hospitalisation",
  "Hospitalisation/prolonged hospitalisation": "hospitalisation",
  "Required hospitalisation": "hospitalisation",
  "Prolonged hospitalisation": "hospitalisation",
  "Other medically important": "others",
  "Non-serious": "others",
  "Unknown": "others"
};

// "Not recovered" is removed: it does not specifically indicate disability
// (a patient may be not-yet-recovered from any condition, not necessarily disabled).
const OUTCOME_MAP = {
  "Fatal": "death",
  "Died": "death",
  "Death": "death",
  "Recovered with sequelae": "disability"
};

export function classifySeverity(report) {
  const seriousness = String(report.seriousness || report.extractedFields?.clinical?.seriousness || "");
  const outcome = String(report.outcome || report.extractedFields?.clinical?.outcome || "");
  const narrative = String(report.extractedFields?.clinical?.narrative || "");
  const adverseReaction = String(report.adverseReaction || report.extractedFields?.clinical?.adverseReaction || "");

  // Highest-confidence: direct map from seriousness label
  const mappedSeriousness = SERIOUSNESS_MAP[seriousness];
  if (mappedSeriousness && mappedSeriousness !== "others") {
    return { class: mappedSeriousness, basis: "seriousness-label-map", confidence: 0.95 };
  }

  // Outcome map (high-confidence structured field)
  const mappedOutcome = OUTCOME_MAP[outcome];
  if (mappedOutcome) return { class: mappedOutcome, basis: "outcome-label-map", confidence: 0.90 };

  // Naive Bayes model (if trained) — used when structured labels are absent/ambiguous
  const text = [seriousness, outcome, narrative, adverseReaction].join(" ");
  if (NB_MODEL) {
    const nbResult = nbPredict(text, NB_MODEL);
    if (nbResult.confidence >= 0.60) {
      return { class: nbResult.class, basis: "naive-bayes", confidence: nbResult.confidence };
    }
  }

  // Rule-based text patterns (fallback)
  if (DEATH_RE.test(text)) return { class: "death", basis: "text-pattern", confidence: 0.82 };
  if (DISABILITY_RE.test(text)) return { class: "disability", basis: "text-pattern", confidence: 0.78 };
  if (HOSPITALISATION_RE.test(text)) return { class: "hospitalisation", basis: "text-pattern", confidence: 0.80 };

  return {
    class: "others",
    basis: seriousness ? "seriousness-label-others" : "no-seriousness-data",
    confidence: seriousness ? 0.70 : 0.40
  };
}

// ── Naive Bayes inference ─────────────────────────────────────────────────────
function nbPredict(text, model) {
  const tokens = tokenise(text);
  const scores = {};
  model.classes.forEach((cls) => {
    let logProb = model.logPriors[cls] || 0;
    tokens.forEach((token) => {
      const lp = model.logWordProbs[cls]?.[token];
      if (lp !== undefined) logProb += lp;
    });
    scores[cls] = logProb;
  });
  const maxScore = Math.max(...Object.values(scores));
  const expScores = {};
  let sumExp = 0;
  Object.entries(scores).forEach(([cls, s]) => {
    expScores[cls] = Math.exp(s - maxScore);
    sumExp += expScores[cls];
  });
  const probs = {};
  Object.entries(expScores).forEach(([cls, e]) => { probs[cls] = e / sumExp; });
  const bestClass = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  return { class: bestClass[0], confidence: Number(bestClass[1].toFixed(3)), probs };
}

export function tokenise(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

// Evaluate four-class classifier over an array of {actual, predicted} pairs.
// Returns per-class precision/recall/F1 + macro averages + MCC.
export function evaluateSeverityClassifier(reports) {
  const CLASSES = ["death", "disability", "hospitalisation", "others"];

  // Build ground-truth label from extracted fields
  const labelled = reports
    .map((report) => {
      const actual = deriveTrueLabel(report);
      if (!actual) return null;
      const predicted = classifySeverity(report).class;
      return { actual, predicted };
    })
    .filter(Boolean);

  if (!labelled.length) return null;

  // Require at least 2 distinct actual classes to compute meaningful multiclass metrics
  const distinctClasses = new Set(labelled.map((l) => l.actual));
  if (distinctClasses.size < 2) return null;

  // Per-class confusion counts
  const counts = {};
  CLASSES.forEach((cls) => { counts[cls] = { tp: 0, fp: 0, fn: 0, tn: 0 }; });

  labelled.forEach(({ actual, predicted }) => {
    CLASSES.forEach((cls) => {
      const isActual = actual === cls;
      const isPred = predicted === cls;
      if (isActual && isPred) counts[cls].tp += 1;
      else if (!isActual && isPred) counts[cls].fp += 1;
      else if (isActual && !isPred) counts[cls].fn += 1;
      else counts[cls].tn += 1;
    });
  });

  const perClass = CLASSES.map((cls) => {
    const { tp, fp, fn, tn } = counts[cls];
    const precision = safe(tp, tp + fp);
    const recall = safe(tp, tp + fn);
    const f1 = safe(2 * precision * recall, precision + recall);
    const support = tp + fn;
    return { class: cls, precision, recall, f1, support, tp, fp, fn, tn };
  });

  const macroF1 = avg(perClass.map((c) => c.f1));
  const macroPrecision = avg(perClass.map((c) => c.precision));
  const macroRecall = avg(perClass.map((c) => c.recall));

  // Matthews Correlation Coefficient for multiclass (RK coefficient)
  const mcc = computeMulticlassMCC(labelled, CLASSES);

  // Confusion matrix rows x cols
  const matrix = CLASSES.map((actual) =>
    CLASSES.map((predicted) =>
      labelled.filter((l) => l.actual === actual && l.predicted === predicted).length
    )
  );

  return {
    classes: CLASSES,
    support: labelled.length,
    perClass,
    macroF1: round(macroF1),
    macroPrecision: round(macroPrecision),
    macroRecall: round(macroRecall),
    mcc: round(mcc),
    confusionMatrix: { classes: CLASSES, matrix }
  };
}

function deriveTrueLabel(report) {
  const seriousness = String(report.seriousness || report.extractedFields?.clinical?.seriousness || "");
  const outcome = String(report.outcome || report.extractedFields?.clinical?.outcome || "");
  const mapped = SERIOUSNESS_MAP[seriousness] || OUTCOME_MAP[outcome];
  return mapped || null;
}

function computeMulticlassMCC(labelled, classes) {
  // Gorodkin's multiclass MCC (covariance form)
  const n = labelled.length;
  if (!n) return 0;

  const C = {};
  classes.forEach((r) => {
    C[r] = {};
    classes.forEach((p) => { C[r][p] = 0; });
  });
  labelled.forEach(({ actual, predicted }) => { C[actual][predicted] += 1; });

  let numerator = 0;
  let denomPk = 0;
  let denomTk = 0;

  classes.forEach((k) => {
    classes.forEach((l) => {
      classes.forEach((m) => {
        numerator += C[k][k] * C[m][l] - C[l][k] * C[k][m];
      });
    });
  });

  classes.forEach((k) => {
    const pk = classes.reduce((s, l) => s + C[l][k], 0);
    const tk = classes.reduce((s, l) => s + C[k][l], 0);
    const notpk = n - pk;
    const nottk = n - tk;
    denomPk += pk * notpk;
    denomTk += tk * nottk;
  });

  const denom = Math.sqrt(denomPk) * Math.sqrt(denomTk);
  return denom ? numerator / denom : 0;
}

function safe(num, den) { return den ? round(num / den) : 0; }
function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function round(v) { return Number(Number(v).toFixed(3)); }
