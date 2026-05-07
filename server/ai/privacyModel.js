// Hybrid rule-based + pattern NER for PII/PHI detection.
// Covers Indian-specific identifiers (Aadhaar, PAN, Indian phone, pin code, MRN)
// plus generic biomedical PHI per DPDP Act 2023 / NDHM / ICMR guidelines.

import { tokenFor } from "./textUtils.js";

// --- Indian-specific PII patterns ---
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const INDIAN_PHONE_RE = /(?<!\d)(\+91[-\s]?)?[6-9]\d{9}(?!\d)/g;
const PINCODE_RE = /\b[1-9]\d{5}\b/g;
const MRN_RE = /\b(MRN|MR|UHID|IP|OP|CR|HID)[-/]?\s*\d{4,12}\b/gi;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const DATE_RE = /\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})\b/g;
const IP_ADDRESS_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

// PHI keyword triggers (NDHM / ICMR context)
const LOCATION_TRIGGERS = /\b(address|village|district|city|state|pin\s*code|pincode|locality|street|area|colony|ward|taluk|tehsil)\b/i;
const NAME_TRIGGERS = /\b(patient\s+name|name\s+of\s+patient|subject\s+name|reporter\s+name)\b/i;
const SENSITIVE_DISEASE_RE = /\b(HIV|AIDS|tuberculosis|TB|hepatitis\s+[BC]|cancer|oncolog\w*|psychiatric|mental\s+(health|illness)|substance\s+abuse|alcohol\s+depend\w*|narcot\w*)\b/i;

export function detectPrivacyFindings(fields, text) {
  const findings = [];

  // --- Structured field findings (high confidence) ---
  if (fields.patient.initials) {
    findings.push({
      entity: "Patient initials",
      type: "PII",
      action: "Tokenised",
      token: fields.patient.patientToken,
      basis: "Patient field extraction",
      regulation: "DPDP Act 2023 §2(t), NDHM §4.2"
    });
  }

  if (fields.reporter.name) {
    findings.push({
      entity: "Reporter name",
      type: "PII",
      action: "Tokenised",
      token: fields.reporter.reporterToken,
      basis: "Reporter field extraction",
      regulation: "DPDP Act 2023 §2(t)"
    });
  }

  if (fields.reporter.email) {
    findings.push({
      entity: "Reporter email",
      type: "PII",
      action: "Tokenised",
      token: tokenFor("email", fields.reporter.email),
      basis: "Email pattern match",
      regulation: "DPDP Act 2023 §2(t), IT Act 2000"
    });
  }

  if (fields.reporter.phone) {
    findings.push({
      entity: "Reporter phone",
      type: "PII",
      action: "Tokenised",
      token: tokenFor("phone", fields.reporter.phone),
      basis: "Indian phone pattern",
      regulation: "DPDP Act 2023 §2(t)"
    });
  }

  // --- Free-text pattern scanning ---
  if (!text) return findings;

  const textFindings = scanText(text);
  return [...findings, ...textFindings];
}

function scanText(text) {
  const findings = [];

  const aadhaarMatches = [...text.matchAll(AADHAAR_RE)];
  if (aadhaarMatches.length) {
    findings.push({
      entity: `Aadhaar-like number (${aadhaarMatches.length} occurrence(s))`,
      type: "PII",
      action: "Redact",
      token: tokenFor("aadhaar", aadhaarMatches[0][0]),
      basis: "12-digit Aadhaar pattern (UIDAI format)",
      regulation: "DPDP Act 2023 §2(t), Aadhaar Act 2016"
    });
  }

  const panMatches = [...text.matchAll(PAN_RE)];
  if (panMatches.length) {
    findings.push({
      entity: `PAN-like number (${panMatches.length} occurrence(s))`,
      type: "PII",
      action: "Redact",
      token: tokenFor("pan", panMatches[0][0]),
      basis: "PAN card pattern (Income Tax Act)",
      regulation: "DPDP Act 2023 §2(t)"
    });
  }

  const phoneMatches = [...text.matchAll(INDIAN_PHONE_RE)];
  if (phoneMatches.length) {
    findings.push({
      entity: `Indian phone number (${phoneMatches.length} occurrence(s))`,
      type: "PII",
      action: "Tokenise",
      token: tokenFor("phone", phoneMatches[0][0]),
      basis: "Indian mobile/landline pattern (6-9 prefix, 10 digits)",
      regulation: "DPDP Act 2023 §2(t)"
    });
  }

  const mrnMatches = [...text.matchAll(MRN_RE)];
  if (mrnMatches.length) {
    findings.push({
      entity: `Medical Record Number (${mrnMatches.length} occurrence(s))`,
      type: "PHI",
      action: "Tokenise",
      token: tokenFor("mrn", mrnMatches[0][0]),
      basis: "MRN/UHID/IP/OP prefix pattern",
      regulation: "NDHM Health Data Management Policy §4, ICMR §4"
    });
  }

  const emailMatches = [...text.matchAll(EMAIL_RE)];
  if (emailMatches.length) {
    findings.push({
      entity: `Email address (${emailMatches.length} occurrence(s))`,
      type: "PII",
      action: "Tokenise",
      token: tokenFor("email", emailMatches[0][0]),
      basis: "Email pattern",
      regulation: "DPDP Act 2023 §2(t), IT Act 2000"
    });
  }

  if (LOCATION_TRIGGERS.test(text)) {
    findings.push({
      entity: "Address/location text",
      type: "PII/PHI",
      action: "Generalise",
      token: tokenFor("location", text.slice(0, 60)),
      basis: "Location keyword trigger",
      regulation: "DPDP Act 2023 §2(t), NDHM §4.2"
    });
  }

  if (SENSITIVE_DISEASE_RE.test(text)) {
    findings.push({
      entity: "Sensitive disease indication",
      type: "PHI",
      action: "Tag — do not expose in analytics copy",
      token: tokenFor("sensitive-disease", text.match(SENSITIVE_DISEASE_RE)[0]),
      basis: "Sensitive category disease detected (HIV/TB/oncology/psychiatric)",
      regulation: "ICMR Ethical Guidelines §4, NDHM §5.2"
    });
  }

  if (NAME_TRIGGERS.test(text)) {
    findings.push({
      entity: "Patient/reporter name field detected in text",
      type: "PII",
      action: "Tokenise",
      token: tokenFor("name", "name-field"),
      basis: "Name label keyword trigger",
      regulation: "DPDP Act 2023 §2(t)"
    });
  }

  return findings;
}

// Build the two-step anonymisation output for a single entity value.
export function buildAnonymisationSample(entity, type, rawValue, pseudoToken) {
  return {
    raw: rawValue,
    type,
    pseudo: pseudoToken || tokenFor(type.toLowerCase(), rawValue),
    anon: generalise(type, rawValue),
    confidence: type === "PII" ? 0.95 : 0.85,
    basis: `${type} — pseudonymisation (step 1) + irreversible generalisation (step 2) per DPDP Act 2023.`,
    regulation: type === "PII" ? "DPDP Act 2023 §2(t)" : "NDHM / ICMR guidelines"
  };
}

// Build representative samples from actual report privacy findings
export function buildAnonymisationSamples(reports) {
  const samples = [];
  for (const report of reports.slice(0, 20)) {
    const findings = report.privacyFindings || [];
    for (const finding of findings.slice(0, 2)) {
      if (samples.length >= 12) break;
      samples.push({
        raw: `[${finding.entity}]`,
        type: finding.type,
        pseudo: finding.token,
        anon: generaliseFromFinding(finding),
        confidence: 0.92,
        basis: finding.basis,
        regulation: finding.regulation || "DPDP Act 2023"
      });
    }
  }
  return samples;
}

function generalise(type, value) {
  if (type === "PII" && value.match(/\d/)) return "NUMERIC_ID_REDACTED";
  if (type === "PII") return "PERSONAL_NAME_REDACTED";
  if (type === "PHI") return "HEALTH_INFO_REDACTED";
  return "REDACTED";
}

function generaliseFromFinding(finding) {
  if (finding.action === "Generalise") return "LOCATION_GENERALISED";
  if (finding.type === "PHI") return "PHI_CATEGORY_PRESERVED";
  return "TOKEN_APPLIED";
}
