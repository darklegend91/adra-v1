const CLINICAL_COMPARE_FIELDS = [
  ["reactionOnsetDate", "clinical.reactionOnsetDate"],
  ["outcome", "clinical.outcome"],
  ["seriousness", "clinical.seriousness"],
  ["dose", "clinical.dose"],
  ["route", "clinical.route"],
  ["frequency", "clinical.frequency"],
  ["narrative", "clinical.narrative"]
];

export function classifyCaseRelation(processedReport, candidateReports = []) {
  const candidates = candidateReports.map((report) => normaliseCandidate(report)).filter(Boolean);
  const current = normaliseCandidate(processedReport);
  if (!current) return newLinkage("new", [], "No usable extracted patient/case anchor was available.");

  const exactSourceDuplicate = candidates.find((candidate) => (
    current.sourceHash && candidate.sourceHash === current.sourceHash
  ));
  if (exactSourceDuplicate) {
    return newLinkage("duplicate", [duplicateEntry(exactSourceDuplicate, "Same uploaded source hash.")], "Same source document hash already exists.");
  }

  const sameCaseCandidates = candidates.filter((candidate) => sameCaseAnchor(current, candidate));
  if (!sameCaseCandidates.length) {
    return newLinkage("new", [], "No previous report matched patient token + medicine + adverse reaction.");
  }

  const changedCandidates = sameCaseCandidates
    .map((candidate) => ({ candidate, changes: clinicalChanges(current, candidate) }))
    .filter((entry) => entry.changes.length);

  if (changedCandidates.length) {
    return newLinkage(
      "followup",
      changedCandidates.map(({ candidate, changes }) => followupEntry(candidate, changes)),
      "Same patient/medicine/reaction anchor exists, but clinical details changed or new details were added."
    );
  }

  return newLinkage(
    "duplicate",
    sameCaseCandidates.map((candidate) => duplicateEntry(candidate, "Same patient, medicine, reaction and clinical details.")),
    "Same patient/medicine/reaction anchor exists without meaningful new clinical details."
  );
}

export function applyCaseLinkage(processedReport, linkage) {
  return {
    ...processedReport,
    caseRelation: linkage.relation,
    duplicateHistory: linkage.relation === "duplicate" ? linkage.matches : [],
    followupHistory: linkage.relation === "followup" ? linkage.matches : [],
    unknownFields: {
      ...processedReport.unknownFields,
      caseLinkage: {
        relation: linkage.relation,
        basis: linkage.basis,
        evaluatedAt: new Date().toISOString(),
        matchCount: linkage.matches.length
      }
    }
  };
}

function newLinkage(relation, matches, basis) {
  return { relation, matches, basis };
}

function normaliseCandidate(report) {
  const fields = report.extractedFields || {};
  const patientToken = fields.patient?.patientToken || "";
  return {
    reportNumber: report.reportNumber || report.id || "",
    caseRecordId: report.caseRecordId || report.caseId || "",
    sourceHash: report.sourceHash || "",
    patientToken,
    medicine: normaliseValue(report.medicineName || report.medicine || fields.clinical?.suspectedMedication),
    reaction: normaliseValue(report.adverseReaction || fields.clinical?.adverseReaction),
    clinical: fields.clinical || {},
    createdAt: report.createdAt || ""
  };
}

function sameCaseAnchor(current, candidate) {
  return Boolean(
    current.patientToken
    && candidate.patientToken
    && current.patientToken === candidate.patientToken
    && current.medicine
    && candidate.medicine
    && current.medicine === candidate.medicine
    && current.reaction
    && candidate.reaction
    && current.reaction === candidate.reaction
  );
}

function clinicalChanges(current, candidate) {
  return CLINICAL_COMPARE_FIELDS
    .map(([label, path]) => {
      const currentValue = normaliseValue(getPath(current, path));
      const candidateValue = normaliseValue(getPath(candidate, path));
      if (!currentValue) return null;
      if (!candidateValue) {
        return {
          field: label,
          previous: "",
          current: currentValue,
          basis: "New clinical detail is present in this upload."
        };
      }
      if (currentValue !== candidateValue) {
        return {
          field: label,
          previous: candidateValue,
          current: currentValue,
          basis: "Clinical detail differs from earlier report."
        };
      }
      return null;
    })
    .filter(Boolean);
}

function duplicateEntry(candidate, basis) {
  return {
    reportNumber: candidate.reportNumber,
    caseRecordId: candidate.caseRecordId,
    relation: "duplicate",
    basis
  };
}

function followupEntry(candidate, changes) {
  return {
    reportNumber: candidate.reportNumber,
    caseRecordId: candidate.caseRecordId,
    relation: "followup",
    changedFields: changes,
    basis: `${changes.length} clinical field(s) changed or added.`
  };
}

function getPath(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

function normaliseValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}
