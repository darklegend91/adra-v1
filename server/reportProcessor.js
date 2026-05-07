import crypto from "crypto";
import { runBioGptExactSpanTagging } from "./ai/biogptService.js";
import { buildRagChunks, extractAdrFields } from "./ai/nlpExtractor.js";
import { buildSourceMetadata, parseSourceDocument } from "./ai/ocrService.js";
import { buildAnonymisationSamples, detectPrivacyFindings } from "./ai/privacyModel.js";
import { buildConfidence, buildScoreSnapshot } from "./ai/scoringModel.js";
import { classifySeverity } from "./ai/severityClassifier.js";
import { buildSaeSummaryFromFields } from "./ai/summariser.js";
import { bandAge, bandWeight, sha256, sha256String } from "./ai/textUtils.js";

const DEFAULT_GUIDELINE_VERSION = "guideline-v1";

export async function processUploadedReport({ file, user, guidelineVersion = DEFAULT_GUIDELINE_VERSION }) {
  const sourceHash = sha256(file.buffer);
  const sourceMetadata = buildSourceMetadata(file);
  const parsed = await parseSourceDocument(file, sourceMetadata);
  const extractedFields = extractAdrFields(parsed);
  const bioGpt = runBioGptExactSpanTagging(parsed, extractedFields);
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
      saeSummary
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
    ragChunks: buildRagChunks(extractedFields, parsed.text)
  };
}

export function presentReport(report, user) {
  const tokenVisible = user.role === "pvpi_member" && String(report.createdByUserId) === String(user.id);
  const latestScore = report.scoreSnapshots?.[report.scoreSnapshots.length - 1] || {};
  return {
    id: report.reportNumber,
    caseId: report.caseRecordId,
    uploaderId: report.createdByUserId,
    uploaderName: report.extractedFields?.pvpi?.submittedBy || user.name,
    center: report.createdByCenter,
    relation: report.caseRelation,
    score: latestScore.score || 0,
    confidence: report.confidence?.overall || 0,
    status: report.processingStatus === "needs_ocr" ? "needs_ocr" : latestScore.route,
    medicine: report.medicineName || "Not extracted",
    adverseReaction: report.adverseReaction || "Not extracted",
    gender: report.gender || "Not extracted",
    ageBand: report.ageBand || "Unknown",
    weightBand: report.weightBand || "Unknown",
    seriousness: report.seriousness || "Unknown",
    outcome: report.outcome || "Unknown",
    severityClass: report.severityClass || report.unknownFields?.severityClassification?.class || "others",
    severityBasis: report.unknownFields?.severityClassification?.basis || "",
    saeSummary: report.unknownFields?.saeSummary || null,
    reportDate: report.extractedFields?.pvpi?.receivedAt || report.createdAt?.toISOString?.().slice(0, 10) || "",
    missingFields: latestScore.missingFields || [],
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
    createdAt: report.createdAt,
    immutable: report.immutable
  };
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
