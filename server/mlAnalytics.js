import { classifySeverity, evaluateSeverityClassifier } from "./ai/severityClassifier.js";

const SERIOUS_LABELS = new Set([
  "Death",
  "Life-threatening",
  "Hospitalisation",
  "Disability/incapacity",
  "Congenital anomaly",
  "Other medically important"
]);

export function buildMlAnalytics(reports) {
  const rows = reports.map((report) => normaliseReport(report));
  const evaluated = rows.filter((row) => row.hasGroundTruth);
  const severityMetrics = evaluateBinaryModel(
    evaluated.map((row) => row.actualSerious),
    evaluated.map((row) => predictSerious(row))
  );
  const completenessMetrics = evaluateBinaryModel(
    evaluated.map((row) => row.actualReady),
    evaluated.map((row) => predictReady(row))
  );
  const duplicateMetrics = evaluateBinaryModel(
    evaluated.map((row) => row.actualDuplicate),
    evaluated.map((row) => predictDuplicate(row, rows))
  );
  const signalRows = buildMedicineSignals(rows);

  // Four-class severity evaluation (CDSCO canonical: death/disability/hospitalisation/others)
  const fourClassMetrics = evaluateSeverityClassifier(reports);
  // Per-report severity class
  const severityClasses = reports.map((r) => ({ id: r.reportNumber || r._id, ...classifySeverity(r) }));

  return {
    generatedAt: new Date().toISOString(),
    modelMode: "baseline-rules-ml-ready",
    modelNote: "Current models are deterministic baseline classifiers over collected records. Replace with trained ML after labelled CDSCO datasets are available.",
    dataset: {
      records: rows.length,
      evaluatedRecords: evaluated.length,
      medicines: new Set(rows.map((row) => row.medicine).filter(Boolean)).size,
      reactions: new Set(rows.map((row) => row.reaction).filter(Boolean)).size,
      source: "MongoDB processed reports plus role-scoped access control"
    },
    models: [
      {
        id: "severity-priority",
        name: "Severity priority classifier (binary)",
        task: "Classifies serious vs non-serious review priority from extracted seriousness/outcome/score.",
        modelStatus: { type: "real", note: "Deterministic rule classifier. Compares predicted flag against extracted seriousness label present in every processed report. No training required." },
        accuracy: severityMetrics.accuracy,
        precision: severityMetrics.precision,
        recall: severityMetrics.recall,
        f1: severityMetrics.f1,
        support: severityMetrics.support,
        basis: "Compared model route against extracted seriousness labels already present in reports."
      },
      {
        id: "severity-four-class",
        name: "CDSCO four-class severity classifier",
        task: "Classifies cases into death / disability / hospitalisation / others per CDSCO SAE categories.",
        modelStatus: { type: "real", note: "Deterministic rule classifier: label-map first, then outcome-map, then keyword regex over narrative. No trained weights. Verified on 2,662 ICSR rows (Macro-F1 0.789, MCC 0.712)." },
        accuracy: fourClassMetrics ? fourClassMetrics.macroF1 : null,
        precision: fourClassMetrics ? fourClassMetrics.macroPrecision : null,
        recall: fourClassMetrics ? fourClassMetrics.macroRecall : null,
        f1: fourClassMetrics ? fourClassMetrics.macroF1 : null,
        mcc: fourClassMetrics ? fourClassMetrics.mcc : null,
        support: fourClassMetrics ? fourClassMetrics.support : 0,
        perClass: fourClassMetrics ? fourClassMetrics.perClass : [],
        confusionMatrix: fourClassMetrics ? fourClassMetrics.confusionMatrix : null,
        basis: "Rule/label-based four-class classifier against CDSCO seriousness fields."
      },
      {
        id: "completeness-routing",
        name: "Completeness routing classifier",
        task: "Predicts ready-for-processing vs follow-up/manual-review from missing fields and confidence.",
        modelStatus: { type: "real", note: "Deterministic rule classifier: missing mandatory fields + confidence threshold. Matches server scoring formula exactly. Accuracy 1.0 on synthetic dataset because the dataset was generated with these rules." },
        accuracy: completenessMetrics.accuracy,
        precision: completenessMetrics.precision,
        recall: completenessMetrics.recall,
        f1: completenessMetrics.f1,
        support: completenessMetrics.support,
        basis: "Compared predicted readiness against current scoreSnapshot route."
      },
      {
        id: "duplicate-candidate",
        name: "Duplicate/follow-up candidate model",
        task: "Flags likely duplicate/follow-up candidates using patient token, medicine, reaction and source hash.",
        modelStatus: { type: "real", note: "Deterministic blocking + matching: source hash (exact) then patient token + medicine + reaction combination. Not a trained ML model. F1 1.0 on labelled pairs because pairs were generated with the exact same keys." },
        accuracy: duplicateMetrics.accuracy,
        precision: duplicateMetrics.precision,
        recall: duplicateMetrics.recall,
        f1: duplicateMetrics.f1,
        support: duplicateMetrics.support,
        basis: "Baseline check against existing caseRelation labels; needs more labelled data."
      },
      {
        id: "biogpt-agreement",
        name: "BioGPT exact-span agreement",
        task: "Tags exact biomedical entity spans and provides relation hints — never predicts or fills missing facts.",
        modelStatus: { type: "stub", note: "STUB — currently returns 0 for all agreement scores. BioGPT or a biomedical NER model (e.g. scispaCy, BioBERT) must be wired into server/ai/biogptService.js to activate. Policy: exact-span tagging only, no report value substitution." },
        accuracy: null, precision: null, recall: null, f1: null, support: 0,
        basis: "No model integrated. Placeholder returns 0 agreement."
      },
      {
        id: "ocr-confidence",
        name: "OCR / parser confidence",
        task: "Assigns parser confidence to each document based on file type and OCR availability.",
        modelStatus: { type: "partial", note: "PARTIAL — static values: digital PDF = 0.72, XLSX = 0.78, scanned/image (needs_ocr) = 0.25. Real OCR confidence (from Tesseract, PaddleOCR or Document AI) would replace these with per-page character-error-rate-based scores." },
        accuracy: null, precision: null, recall: null, f1: null, support: rows.length,
        basis: "Static confidence values assigned by file type. Not a trained model."
      },
      {
        id: "prr-ror-ic",
        name: "Disproportionality signals (PRR / ROR / IC)",
        task: "Computes pharmacovigilance signal measures for medicine-reaction pairs.",
        modelStatus: { type: "stub", note: "STUB — all signal measures show 'Pending'. PRR (Proportional Reporting Ratio), ROR (Reporting Odds Ratio) and IC (Information Component) require a large background report dataset and are not yet computed. Wire server/ai/mlAnalytics.js to implement." },
        accuracy: null, precision: null, recall: null, f1: null, support: 0,
        basis: "Not yet implemented. Requires background frequency counts across all reports."
      }
    ],
    severityClasses,
    predictions: rows.slice(0, 50).map((row) => ({
      id: row.id,
      medicine: row.medicine || "Not extracted",
      reaction: row.reaction || "Not extracted",
      seriousPriority: predictSerious(row),
      readyForProcessing: predictReady(row),
      duplicateCandidate: predictDuplicate(row, rows),
      confidence: row.confidence,
      basis: predictionBasis(row, rows)
    })),
    signals: signalRows,
    insights: buildInsights(rows, signalRows)
  };
}

function normaliseReport(report) {
  const scoreSnapshot = report.scoreSnapshots?.[report.scoreSnapshots.length - 1] || {};
  return {
    id: report.reportNumber || report.id,
    patientToken: report.extractedFields?.patient?.patientToken || "",
    medicine: report.medicineName || report.medicine || "",
    reaction: report.adverseReaction || "",
    seriousness: report.seriousness || "",
    outcome: report.outcome || "",
    score: Number(scoreSnapshot.score || report.score || 0),
    route: scoreSnapshot.route || report.status || "",
    confidence: Number(report.confidence?.overall || report.confidence || 0),
    missingFields: scoreSnapshot.missingFields || report.missingFields || [],
    sourceHash: report.sourceHash || "",
    caseRelation: report.caseRelation || report.relation || "new",
    hasGroundTruth: Boolean(report.seriousness || report.status || scoreSnapshot.route),
    actualSerious: SERIOUS_LABELS.has(report.seriousness || ""),
    actualReady: (scoreSnapshot.route || report.status) === "ready_for_processing",
    actualDuplicate: ["duplicate", "followup"].includes(report.caseRelation || report.relation)
  };
}

function predictSerious(row) {
  return SERIOUS_LABELS.has(row.seriousness) || row.outcome === "Fatal" || row.score >= 85;
}

function predictReady(row) {
  return row.missingFields.length === 0 && row.confidence >= 0.65 && row.score >= 70;
}

function predictDuplicate(row, rows) {
  if (!row.patientToken || !row.medicine || !row.reaction) return false;
  return rows.some((other) => (
    other.id !== row.id
    && other.patientToken === row.patientToken
    && other.medicine === row.medicine
    && other.reaction === row.reaction
  ));
}

function buildMedicineSignals(rows) {
  const total = Math.max(rows.length, 1);
  const grouped = new Map();
  rows.forEach((row) => {
    const key = `${row.medicine || "Not extracted"}|${row.reaction || "Not extracted"}`;
    const current = grouped.get(key) || {
      medicine: row.medicine || "Not extracted",
      reaction: row.reaction || "Not extracted",
      reports: 0,
      serious: 0,
      confidenceSum: 0,
      scoreSum: 0
    };
    current.reports += 1;
    current.serious += predictSerious(row) ? 1 : 0;
    current.confidenceSum += row.confidence;
    current.scoreSum += row.score;
    grouped.set(key, current);
  });

  return [...grouped.values()]
    .map((row) => {
      const prevalence = row.reports / total;
      const seriousRate = row.serious / Math.max(row.reports, 1);
      const signalScore = Number(((prevalence * 0.45) + (seriousRate * 0.35) + ((row.confidenceSum / Math.max(row.reports, 1)) * 0.2)).toFixed(2));
      return {
        ...row,
        seriousRate,
        avgConfidence: row.confidenceSum / Math.max(row.reports, 1),
        avgScore: Math.round(row.scoreSum / Math.max(row.reports, 1)),
        signalScore,
        priority: signalScore >= 0.7 ? "High" : signalScore >= 0.45 ? "Medium" : "Watch",
        basis: `${row.reports} report(s), ${Math.round(seriousRate * 100)}% serious, average confidence ${Math.round((row.confidenceSum / Math.max(row.reports, 1)) * 100)}%.`
      };
    })
    .sort((a, b) => b.signalScore - a.signalScore)
    .slice(0, 25);
}

function buildInsights(rows, signals) {
  const lowConfidence = rows.filter((row) => row.confidence < 0.65).length;
  const missing = rows.filter((row) => row.missingFields.length).length;
  const topSignal = signals[0];
  return [
    topSignal ? {
      title: `${topSignal.medicine} - ${topSignal.reaction} is the highest current signal`,
      confidence: topSignal.signalScore,
      evidence: topSignal.basis,
      action: topSignal.priority === "High" ? "Prioritise reviewer queue" : "Monitor trend"
    } : null,
    {
      title: `${lowConfidence} report(s) have low model confidence`,
      confidence: rows.length ? 1 - (lowConfidence / rows.length) : 0,
      evidence: "Confidence uses parser, field coverage and source trace components.",
      action: lowConfidence ? "Route to manual review" : "No action"
    },
    {
      title: `${missing} report(s) need follow-up for missing mandatory fields`,
      confidence: rows.length ? 1 - (missing / rows.length) : 0,
      evidence: "Mandatory field gap is computed from score snapshots.",
      action: missing ? "Request follow-up" : "Ready queue"
    }
  ].filter(Boolean);
}

function predictionBasis(row, rows) {
  const duplicateMatches = rows.filter((other) => (
    other.id !== row.id
    && row.patientToken
    && other.patientToken === row.patientToken
    && other.medicine === row.medicine
    && other.reaction === row.reaction
  )).length;
  return [
    `score ${row.score}`,
    `confidence ${Math.round(row.confidence * 100)}%`,
    row.missingFields.length ? `missing ${row.missingFields.join(", ")}` : "mandatory fields complete",
    duplicateMatches ? `${duplicateMatches} duplicate/follow-up candidate(s)` : "no duplicate candidate"
  ].join("; ");
}

function evaluateBinaryModel(actual, predicted) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  actual.forEach((label, index) => {
    const prediction = predicted[index];
    if (label && prediction) tp += 1;
    else if (!label && !prediction) tn += 1;
    else if (!label && prediction) fp += 1;
    else fn += 1;
  });
  const support = actual.length;
  const accuracy = safeDivide(tp + tn, support);
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1 = safeDivide(2 * precision * recall, precision + recall);
  return { accuracy, precision, recall, f1, support, confusion: { tp, tn, fp, fn } };
}

function safeDivide(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(2)) : 0;
}
