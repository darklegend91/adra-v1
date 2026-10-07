import crypto from "crypto";
import { runBioGptExactSpanTagging } from "./ai/biogptService.js";
import { normalizeToEnglish } from "./ai/languageNormalizer.js";
import { buildRagChunks, enhanceFieldsWithNer, extractAdrFields } from "./ai/nlpExtractor.js";
import { buildSourceMetadata, parseSourceDocument } from "./ai/ocrService.js";
import { buildAnonymisationSamples, detectPrivacyFindings } from "./ai/privacyModel.js";
import { buildConfidence, buildScoreSnapshot } from "./ai/scoringModel.js";
import { classifySeverity } from "./ai/severityClassifier.js";
import { buildSaeSummaryFromFields } from "./ai/summariser.js";
import { bandAge, bandWeight, sha256, sha256String } from "./ai/textUtils.js";

const DEFAULT_GUIDELINE_VERSION = "guideline-v1";
const MISSING_REQUIRED_VALUES = new Set(["", "not extracted", "unknown", "n/a", "na", "none", "null", "-"]);

export async function processUploadedReport({ file, user, guidelineVersion = DEFAULT_GUIDELINE_VERSION }) {
  const sourceHash = sha256(file.buffer);
  const sourceMetadata = buildSourceMetadata(file);

  // 1. Parse raw document (OCR / AcroForm / pdfplumber / voice / XML / …)
  const parsed = await parseSourceDocument(file, sourceMetadata);

  // 2. Multilingual normalisation — detect language, translate to English if needed
  const { normalizedParsed, langInfo } = await normalizeToEnglish(parsed);

  // 3. Rule-based structured field extraction
  const rawFields = extractAdrFields(normalizedParsed);

  // 4. scispaCy NER — fills gaps in narrative / free-text fields
  const narrative = rawFields.clinical.narrative || normalizedParsed.text.slice(0, 2000);
  const extractedFields = await enhanceFieldsWithNer(rawFields, narrative);

  const bioGpt = runBioGptExactSpanTagging(normalizedParsed, extractedFields);
  const privacyFindings = detectPrivacyFindings(extractedFields, parsed.text);
  const confidence = buildConfidence(parsed, extractedFields, bioGpt);
  const scoreSnapshot = buildScoreSnapshot(extractedFields, confidence, guidelineVersion);
  const secureReviewToken = createSecureReviewToken();
  const reportNumber = createReportNumber(sourceHash);
  const caseRecordId = createCaseRecordId(extractedFields, sourceHash);

  // CDSCO four-class severity classification
  const severityResult = classifySeverity({
    seriousness: extractedFields.clinical.seriousness,
    outcome: extractedFields.clinical.outcome,
    adverseReaction: extractedFields.clinical.adverseReaction,
    extractedFields
  });

  // Extractive SAE narrative summary
  const saeSummary = buildSaeSummaryFromFields(extractedFields, extractedFields.clinical.narrative || parsed.text.slice(0, 2000));

  // Processing log — one entry per pipeline stage, returned to frontend for display
  const fieldsFound = (extractedFields.sourceTrace || []).filter((t) => t.value).length;
  const processingLog = [
    {
      stage: "parse",
      label: "Parse / OCR",
      status: "done",
      detail: `${parsed.parser} · ${parsed.text.length} chars · confidence ${Math.round((parsed.parserConfidence || 0) * 100)}%`,
    },
    {
      stage: "language",
      label: "Language detect",
      status: "done",
      detail: langInfo?.was_translated
        ? `Translated from ${langInfo.lang} → English`
        : `Detected: ${langInfo?.lang ?? "en"} (English — no translation needed)`,
    },
    {
      stage: "extract",
      label: "Field extraction",
      status: "done",
      detail: `${fieldsFound} fields found · ${extractedFields.sourceTrace?.length || 0} tracked`,
    },
    {
      stage: "ner",
      label: "NER enhancement",
      status: extractedFields.nerMeta ? "done" : "skipped",
      detail: extractedFields.nerMeta
        ? `scispaCy: ${extractedFields.nerMeta.drugs.length} drug(s), ${extractedFields.nerMeta.diseases.length} disease(s) · coverage ${Math.round((extractedFields.nerMeta.coverage || 0) * 100)}%`
        : "Sidecar not running — using rule-based extraction only",
    },
    {
      stage: "severity",
      label: "Severity classification",
      status: "done",
      detail: `Class: ${severityResult.class} · ${severityResult.basis || "cascade classifier"}`,
    },
    {
      stage: "privacy",
      label: "Privacy scan",
      status: "done",
      detail: `${privacyFindings.length} PII/PHI finding(s) detected`,
    },
    {
      stage: "score",
      label: "Scoring & routing",
      status: "done",
      detail: `Score: ${scoreSnapshot.score} · Route: ${scoreSnapshot.route} · Missing: ${scoreSnapshot.missingFields.length} field(s)`,
    },
  ];

  return {
    reportNumber,
    caseRecordId,
    createdByUserId: user.id,
    createdByRole: user.role,
    createdByCenter: user.center || "",
    immutable: true,
    secureReviewToken,
    secureReviewTokenHash: sha256String(secureReviewToken),
    secureReviewTokenPreview: `${secureReviewToken.slice(0, 14)}...restricted`,
    processingStatus: parsed.needsOcr ? "needs_ocr" : "processed",
    sourceHash,
    sourceMetadata: {
      ...sourceMetadata,
      parser: parsed.parser,
      extractedTextLength: parsed.text.length,
      ocrStatus: parsed.needsOcr ? "OCR engine required for scanned/image-only content" : "Digital text extracted"
    },
    extractedFields,
    unknownFields: {
      ...parsed.unknownFields,
      ai: { bioGpt },
      severityClassification: severityResult,
      saeSummary,
      languageInfo: langInfo,
      nerMeta: extractedFields.nerMeta ?? null
    },
    privacyFindings,
    scoreSnapshots: [scoreSnapshot],
    confidence,
    medicineName: extractedFields.clinical.suspectedMedication || "",
    adverseReaction: extractedFields.clinical.adverseReaction || "",
    gender: extractedFields.patient.gender || "",
    ageBand: bandAge(extractedFields.patient.age),
    weightBand: bandWeight(extractedFields.patient.weight),
    seriousness: extractedFields.clinical.seriousness || "",
    outcome: extractedFields.clinical.outcome || "",
    severityClass: severityResult.class,
    caseRelation: "new",
    followupHistory: [],
    duplicateHistory: [],
    ragChunks: buildRagChunks(extractedFields, parsed.text),
    processingLog,
  };
}

export function presentReport(report, user) {
  const tokenVisible = user.role === "pvpi_member" && String(report.createdByUserId) === String(user.id);
  const latestScore = report.scoreSnapshots?.[report.scoreSnapshots.length - 1] || {};
  const medicineName = isMissingRequiredValue(report.medicineName) ? "" : report.medicineName;
  const adverseReaction = isMissingRequiredValue(report.adverseReaction) ? "" : report.adverseReaction;
  const criticalMissingFields = [];
  if (!adverseReaction) criticalMissingFields.push("Adverse reaction");
  if (!medicineName) criticalMissingFields.push("Suspected medication");
  const missingFields = [...new Set([...(latestScore.missingFields || []), ...criticalMissingFields])];
  const route = report.processingStatus === "needs_ocr"
    ? "needs_ocr"
    : criticalMissingFields.length
      ? "needs_followup"
      : latestScore.route;
  return {
    id: report.reportNumber,
    caseId: report.caseRecordId,
    uploaderId: report.createdByUserId,
    uploaderName: report.extractedFields?.pvpi?.submittedBy || user.name,
    center: report.createdByCenter,
    relation: report.caseRelation,
    score: latestScore.score || 0,
    confidence: report.confidence?.overall || 0,
    status: route,
    humanReview: {
      status: report.humanReviewStatus || "unreviewed",
      note: report.humanReviewNote || "",
      updatedAt: report.humanReviewUpdatedAt?.toISOString?.() || "",
      updatedByUserId: report.humanReviewUpdatedByUserId || "",
      updatedByRole: report.humanReviewUpdatedByRole || "",
      history: report.humanReviewHistory || []
    },
    medicine: medicineName || "Not extracted",
    adverseReaction: adverseReaction || "Not extracted",
    gender: report.gender || "Not extracted",
    ageBand: report.ageBand || "Unknown",
    weightBand: report.weightBand || "Unknown",
    seriousness: report.seriousness || "Unknown",
    outcome: report.outcome || "Unknown",
    severityClass: report.severityClass || report.unknownFields?.severityClassification?.class || "others",
    severityBasis: report.unknownFields?.severityClassification?.basis || "",
    saeSummary: report.unknownFields?.saeSummary || null,
    reportDate: report.extractedFields?.pvpi?.receivedAt || report.createdAt?.toISOString?.().slice(0, 10) || "",
    missingFields,
    confidenceBreakdown: report.confidence?.components || {},
    relationBasis: report.unknownFields?.caseLinkage?.basis || "",
    duplicateHistory: report.duplicateHistory || [],
    followupHistory: report.followupHistory || [],
    secureReviewToken: tokenVisible ? report.secureReviewToken : report.secureReviewTokenPreview,
    secureReviewTokenVisible: tokenVisible,
    extractedFields: report.extractedFields,
    privacyFindings: report.privacyFindings,
    sourceTrace: report.extractedFields?.sourceTrace || [],
    sourceMetadata: report.sourceMetadata,
    aiFindings: report.unknownFields?.ai || {},
    languageInfo: report.unknownFields?.languageInfo || null,
    nerMeta: report.unknownFields?.nerMeta || null,
    processingLog: report.processingLog || [],
    createdAt: report.createdAt,
    immutable: report.immutable
  };
}

function isMissingRequiredValue(value) {
  const cleaned = String(value || "").trim().toLowerCase();
  return MISSING_REQUIRED_VALUES.has(cleaned) || /^\(?[a-z]\)?\s*[*x×.\-]*$/.test(cleaned);
}

// Build anonymisation samples from a list of presented reports (no PII exposed)
export { buildAnonymisationSamples };

function createSecureReviewToken() {
  return `PVPI-RELINK-${crypto.randomBytes(10).toString("hex").toUpperCase()}`;
}

function createReportNumber(sourceHash) {
  return `ADR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${sourceHash.slice(0, 6).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function createCaseRecordId(fields, sourceHash) {
  const anchor = [fields.patient.patientToken, fields.clinical.suspectedMedication, fields.clinical.adverseReaction].join("|");
  return `PVPI-CASE-${sha256String(anchor || sourceHash).slice(0, 12).toUpperCase()}`;
}
