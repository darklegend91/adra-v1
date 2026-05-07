const BIOGPT_FIELDS = [
  ["suspectedMedication", "clinical.suspectedMedication"],
  ["adverseReaction", "clinical.adverseReaction"],
  ["outcome", "clinical.outcome"],
  ["seriousness", "clinical.seriousness"]
];

export function runBioGptExactSpanTagging(parsed, fields) {
  const text = parsed.text || "";
  const findings = BIOGPT_FIELDS.map(([label, path]) => {
    const value = getPath(fields, path);
    const presentAsExactSpan = Boolean(value && text.toLowerCase().includes(String(value).toLowerCase()));
    return {
      field: label,
      value: value || "",
      presentAsExactSpan,
      action: "agreement_check_only",
      basis: presentAsExactSpan ? "Exact value appears in source text." : "No exact source span found."
    };
  });
  const populated = findings.filter((finding) => finding.value).length;
  const agreed = findings.filter((finding) => finding.value && finding.presentAsExactSpan).length;

  return {
    enabled: false,
    model: "BioGPT",
    mode: "exact-source-span-agreement-only",
    agreement: populated ? Number((agreed / populated).toFixed(2)) : 0,
    findings,
    guardrails: [
      "BioGPT must not predict missing facts.",
      "BioGPT must not normalise or replace source terms.",
      "BioGPT must not overwrite OCR, form, or structured extraction output."
    ],
    note: "BioGPT runtime is not configured in this prototype. This service records the allowed integration contract without modifying report data."
  };
}

function getPath(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}
