export function buildScoreSnapshot(fields, confidence, guidelineVersion) {
  const required = [
    ["Patient initials", fields.patient.initials],
    ["Patient age", fields.patient.age],
    ["Adverse reaction", fields.clinical.adverseReaction],
    ["Suspected medication", fields.clinical.suspectedMedication],
    ["Reporter contact", fields.reporter.name || fields.reporter.email || fields.reporter.phone]
  ];
  const missingFields = required.filter(([, value]) => !value).map(([label]) => label);
  const score = Math.max(0, Math.round(100 - missingFields.length * 14 - (confidence.overall < 0.6 ? 12 : 0)));

  return {
    guidelineVersion,
    score,
    missingFields,
    route: missingFields.length ? "needs_followup" : confidence.overall < 0.65 ? "manual_review" : "ready_for_processing",
    basis: "Completeness score uses only fields present in the uploaded report."
  };
}

export function buildConfidence(parsed, fields, bioGptAgreement = null) {
  const fieldValues = [
    fields.patient.initials,
    fields.patient.age,
    fields.clinical.adverseReaction,
    fields.clinical.suspectedMedication,
    fields.reporter.name || fields.reporter.email || fields.reporter.phone
  ];
  const coverage = fieldValues.filter(Boolean).length / fieldValues.length;
  // Use real OCR confidence when Tesseract ran; otherwise use parser-type defaults
  const parserConfidence = parsed.parserConfidence !== undefined
    ? parsed.parserConfidence
    : parsed.needsOcr ? 0.25 : parsed.parser === "xlsx" ? 0.78 : 0.72;
  const sourceTrace = fields.sourceTrace.filter((entry) => entry.value).length / Math.max(fields.sourceTrace.length, 1);
  const bioGptScore = Number(bioGptAgreement?.agreement || 0);
  const overall = Number(((coverage * 0.45) + (parserConfidence * 0.35) + (sourceTrace * 0.2)).toFixed(2));

  return {
    overall,
    components: {
      parser: parserConfidence,
      fieldCoverage: Number(coverage.toFixed(2)),
      sourceTrace: Number(sourceTrace.toFixed(2)),
      bioGptAgreement: bioGptScore
    },
    note: "BioGPT is not used to alter extracted text. It is exact-span agreement metadata only."
  };
}
