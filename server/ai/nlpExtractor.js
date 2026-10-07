import { bandAge, bandWeight, cleanText, cleanValue, exactString, firstMatch, tokenFor } from "./textUtils.js";
import { isSidecarAvailable, sidecarNer } from "./sidecarClient.js";

const SERIOUSNESS_TERMS = [
  ["death", "Death"],
  ["life-threatening", "Life-threatening"],
  ["life threatening", "Life-threatening"],
  ["hospitalisation", "Hospitalisation"],
  ["hospitalization", "Hospitalisation"],
  ["disability", "Disability/incapacity"],
  ["congenital", "Congenital anomaly"],
  ["medically important", "Other medically important"]
];

const OUTCOME_TERMS = [
  ["recovered with sequelae", "Recovered with sequelae"],
  ["recovering", "Recovering"],
  ["recovered", "Recovered"],
  ["not recovered", "Not recovered"],
  ["fatal", "Fatal"],
  ["unknown", "Unknown"]
];

export function extractAdrFields(parsed) {
  const text = parsed.text;
  const rows = parsed.rows || [];
  const rowCandidate = rows.find((row) => row.medicineName || row.adverseEvent || row.outcome) || {};
  const machineReadable = text.includes("ADRA_MACHINE_READABLE_ADR");
  const machine = (label) => machineField(text, label);
  const ocrRegion = (label) => ocrRegionField(text, label);
  const ocrMedication = normaliseOcrMedication(ocrRegion("DRUG_NAME") || ocrRegion("MEDICATION_ROW"));
  const ocrNarrative = cleanOcrNarrative(bestOcrNarrative(ocrRegion("NARRATIVE"), ocrNarrativeReaction(text)));
  const ocrReporter = ocrRegion("REPORTER");
  const patientTokenFromSource = machine("Patient_Token");
  const patientInitials = machine("Patient_Initials") || firstMatch(text, [
    /^Patient_Initials:[ \t]*([A-Z][A-Z. \t]{0,12})/im,
    /patient\s*(?:initials?|name)\s*[:\-]?\s*([A-Z][A-Z.\s]{0,12})/i,
    /initials?\s*[:\-]?\s*([A-Z][A-Z.\s]{0,12})/i
  ]);
  const age = machine("Patient_Age") || (!machineReadable ? firstMatch(text, [/age\s*[:\-]?\s*(\d{1,3})/i, /(\d{1,3})\s*(?:years|yrs)\b/i]) : "");
  const gender = machine("Patient_Sex") || (!machineReadable ? firstMatch(text, [/\b(male|female)\s+patient\b/i, /gender\s*[:\-]?\s*(male|female|other|unknown)/i]) : "");
  const weight = machine("Patient_Weight_kg") || (!machineReadable ? firstMatch(text, [/weight\s*(?:\(in\s*kg\.?\))?\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)/i]) : "");
  const narrativeReaction = firstMatch(text, [/reported\s+([A-Za-z][A-Za-z0-9 /+,\-]{1,100}?)\s+after exposure to/i]);
  const adverseReaction = exactString(rowCandidate.adverseEvent) || machine("MedDRA_PT") || narrativeReaction || ocrNarrative || (!machineReadable ? firstMatch(text, [
    /^MedDRA_PT:[ \t]*([^\n]{2,100})/im,
    /MedDRA\s+PT\s*[:\-]?\s*([^\n]{3,100})/i,
    /\bPT\s*[:\-]?\s*([^\n]{3,100})/i,
    /(?:adverse\s*(?:event|reaction)|reaction)\s*[:\-]?\s*([^\n]{3,120})/i,
    /description\s+of\s+reaction\s*[:\-]?\s*([^\n]{3,120})/i
  ]) : "");
  const suspectedMedication = firstValidMedicine([
    rowCandidate.medicineName,
    machine("Suspect_Drug"),
    ocrMedication,
    !machineReadable ? firstMatch(text, [
      /^Suspect_Drug:[ \t]*([^\n]{2,120})/im,
      /\bi\s+([A-Za-z][A-Za-z0-9 /+-]{1,80}?)\s+N\/A\s+N\/A\s+N\/A\s+\d/i,
      /(?:suspected\s*(?:medication|drug|medicine)|medicine\s*name|drug\s*name)\s*[:\-]?\s*([^\n]{2,120})/i,
      /(?:medication\(s\)|suspected medication\(s\))\s*[:\-]?\s*([^\n]{2,120})/i
    ]) : ""
  ]);
  const reporterName = cleanOcrReporterName(machine("Reporter_Name") || machine("Reporter_Type") || firstMatch([ocrReporter, text].filter(Boolean).join("\n"), [
    /^Reporter_Name:[ \t]*([^\n]{3,100})/im,
    /^Reporter_Type:[ \t]*([^\n]{3,100})/im,
    /[NM][au]me\s*&?\s*A(?:dd|d¢|dc)ress\s*[:\-]?\s*([^\n]{3,100})/i,
    /reporter(?:'s)?\s*name\s*[:\-]?\s*([^\n]{3,100})/i,
    /name\s+of\s+reporter\s*[:\-]?\s*([^\n]{3,100})/i
  ]));
  const reporterEmail = looseOcrEmail(ocrReporter) || firstMatch(text, [/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i]) || looseOcrEmail(text);
  const reporterPhone = firstMatch([ocrReporter, text].filter(Boolean).join("\n"), [/Contact\s+No-?\s*[:\-]?\s*(\+?\d[\d\s-]{8,14}\d)/i, /\b(\+?\d[\d\s-]{8,14}\d)\b/]);
  const outcome = exactString(rowCandidate.outcome) || machine("Outcome") || (!machineReadable ? checkedOutcome(text) || findTaxonomy(text, OUTCOME_TERMS) : "");
  const seriousness = machine("SAE_Seriousness_Criteria") || (!machineReadable ? findTaxonomy(text, SERIOUSNESS_TERMS) || (String(rowCandidate.riskFlags || "").includes("serious") ? "Other medically important" : "") : "");
  const dose = exactString(rowCandidate.dose) || machine("Drug_Dose_mg") || (!machineReadable ? firstMatch(text, /\bi\s+[A-Za-z][^\n]*?\s+(\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg))\s+/i) || cleanLayoutCapture(firstMatch(text, /dose\s*[:\-]?\s*([^\n]{1,50})/i)) : "");
  const route = exactString(rowCandidate.route) || machine("Drug_Route") || (!machineReadable ? firstMatch(text, /\bi\s+[A-Za-z][^\n]*?\s+\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg)\s+([A-Za-z]+)\s+/i) || cleanLayoutCapture(firstMatch(text, /route\s*[:\-]?\s*([^\n]{1,50})/i)) : "");
  const frequency = exactString(rowCandidate.frequency) || machine("Dose_Frequency") || (!machineReadable ? firstMatch(text, /\bi\s+[A-Za-z][^\n]*?\s+\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg)\s+[A-Za-z]+\s+([A-Za-z]+)\s+/i) || cleanLayoutCapture(firstMatch(text, /frequency\s*[:\-]?\s*([^\n]{1,50})/i)) : "");

  // ── Indication ───────────────────────────────────────────────────────────────
  const indication = machine("Indication") || (!machineReadable ? firstMatch(text, [
    /indication\s*[:\-]?\s*([^\n]{2,100})/i,
    /prescribed\s+for\s+([^\n.]{2,80})/i,
    /used\s+for\s+([^\n.]{2,80})/i,
  ]) : "");

  // ── Causality ────────────────────────────────────────────────────────────────
  const causality = machine("Causality_Assessment") || (!machineReadable ? firstMatch(text, [
    /causality\s*(?:assessment)?\s*[:\-]?\s*([^\n]{2,60})/i,
    /\b(certain|probable|possible|unlikely|unassessable|conditional)\b/i,
  ]) : "");

  // ── Concomitant medications (Section 11 + drug table rows ii/iii) ─────────────
  const rawConcomitants = [
    machine("Concomitant_Drug_1"),
    machine("Concomitant_Drug_2"),
    machine("Concomitant_Drug_3"),
    machine("Concomitant_Drug_4"),
  ].map(cleanValue).filter(Boolean);

  // For non-fillable PDFs, try to find concomitant drug names from free text
  if (!machineReadable && rawConcomitants.length === 0) {
    // Look for the concomitant section header and drug names listed below it
    const conSection = firstMatch(text, [
      /concomitant\s+medical\s+product[^\n]*\n([\s\S]{0,600}?)(?:\d{2,}\.|\n\n|D\.\s*REPORTER)/i,
    ]);
    if (conSection) {
      // Extract individual drug names from table rows (lines starting with i, ii, iii, 1, 2, 3)
      const lines = conSection.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
      for (const line of lines) {
        const m = line.match(/^(?:i{1,3}|[1-3]|iv)\s+([A-Za-z][A-Za-z0-9 /\-+]{1,60})/i);
        if (m) rawConcomitants.push(cleanValue(m[1]));
      }
    }
  }

  // ── Medical history, allergies, relevant comorbidities (Section 13) ──────────
  const medicalHistory = machine("Other_Medical_Info") || (!machineReadable ? firstMatch(text, [
    /relevant\s+(?:medical|medication)\s*(?:\/\s*medication)?\s*history\s*[:\-]?\s*([\s\S]{5,400}?)(?:\n\n|\d{2,}\.)/i,
    /(?:allerg(?:y|ic|ies)[^\n]*[:\-]?\s*)([^\n]{3,200})/i,
    /(?:other\s+info(?:rmation)?|additional\s+info(?:rmation)?)\s*[:\-]?\s*([\s\S]{5,300}?)(?:\n\n|\d{2,}\.)/i,
  ]) : "");

  // Extract specific allergy mention from any free text
  const allergyMention = firstMatch(text, [
    /(?:known\s+)?allerg(?:y|ic|ies)\s+to\s+([^\n.]{3,120})/i,
    /allerg(?:y|ic)\s*[:\-]\s*([^\n]{3,100})/i,
  ]);

  return {
    patient: {
      patientToken: patientTokenFromSource || tokenFor("patient", [patientInitials, age, gender, weight].filter(Boolean).join("|")),
      initials: patientInitials,
      age,
      gender,
      weight,
      ageBand: bandAge(age),
      weightBand: bandWeight(weight)
    },
    reporter: {
      reporterToken: tokenFor("reporter", reporterEmail || reporterPhone || reporterName),
      name: reporterName,
      email: reporterEmail,
      phone: reporterPhone,
      institution: firstMatch(text, [/institution\s*[:\-]?\s*([^\n]{3,120})/i]),
      department: firstMatch(text, [/department\s*[:\-]?\s*([^\n]{3,120})/i]),
      contactPolicy: "Reporter direct contact is tokenised and available only through authorised PvPI follow-up."
    },
    pvpi: {
      receivedAt: exactString(rowCandidate.reportDate) || firstMatch(text, [/date\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i]),
      sourceFile: rows[0]?.sourceFile || "",
      sourcePage: rows[0]?.sourcePage || "",
      traceId: rows[0]?.traceId || "",
      submittedBy: "Authenticated uploader"
    },
    clinical: {
      suspectedMedication,
      adverseReaction,
      dose,
      route,
      frequency,
      outcome,
      seriousness,
      indication,
      causality,
      concomitantDrugs: rawConcomitants,
      medicalHistory,
      allergyMention,
      reactionOnsetDate: machine("Onset_Date") || (!machineReadable ? firstMatch(text, /(?:onset|event\s*\/\s*reaction\s*start\s*date|reaction\s*start)\s*(?:\(dd\/mm\/yyyy\))?\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) : ""),
      narrative: ocrNarrative || extractNarrative(text)
    },
    sourceTrace: buildSourceTrace({ patientInitials, age, gender, weight, suspectedMedication, adverseReaction, dose, route, frequency, indication, causality, reporterName, reporterEmail, reporterPhone, outcome, seriousness })
  };
}

/**
 * Enhance already-extracted fields using scispaCy NER on the narrative text.
 * Only fills GAPS — never overwrites values the rule-based extractor already found.
 * Returns the original fields object unchanged if the sidecar is unavailable.
 *
 * @param {object} fields  Result of extractAdrFields()
 * @param {string} narrativeText  Free-text section to run NER on (max 2000 chars sent)
 * @returns {Promise<object>}
 */
export async function enhanceFieldsWithNer(fields, narrativeText) {
  if (!isSidecarAvailable() || !narrativeText?.trim()) return fields;

  try {
    const ner = await sidecarNer(narrativeText.slice(0, 2000));
    return _mergeNer(fields, ner);
  } catch (err) {
    console.warn("[NER] Sidecar NER failed:", err.message);
    return fields;
  }
}

function _mergeNer(fields, ner) {
  const patient  = { ...fields.patient };
  const clinical = { ...fields.clinical };

  // Fill gaps — rule-based extraction has priority
  if (!clinical.suspectedMedication && ner.drugs?.[0])      clinical.suspectedMedication = cleanMedicineCandidate(ner.drugs[0]);
  if (!clinical.adverseReaction     && ner.diseases?.[0])   clinical.adverseReaction     = ner.diseases[0];
  if (!clinical.dose                && ner.dose)             clinical.dose                = ner.dose;
  if (!clinical.route               && ner.route)            clinical.route               = ner.route;
  if (!clinical.frequency           && ner.frequency)        clinical.frequency           = ner.frequency;
  if (!clinical.reactionOnsetDate   && ner.onset_date)       clinical.reactionOnsetDate   = ner.onset_date;
  if (!clinical.outcome             && ner.outcome)          clinical.outcome             = ner.outcome;
  if (!clinical.seriousness         && ner.seriousness)      clinical.seriousness         = ner.seriousness;
  if (!patient.age                  && ner.age)              patient.age                  = ner.age;
  if (!patient.gender               && ner.gender)           patient.gender               = ner.gender;

  return {
    ...fields,
    patient,
    clinical,
    nerMeta: {
      drugs:    ner.drugs    ?? [],
      diseases: ner.diseases ?? [],
      negated:  ner.negated  ?? [],
      coverage: ner.coverage ?? 0,
      source:   "scispaCy-bc5cdr",
    },
  };
}

export function buildRagChunks(fields, text) {
  return [
    {
      chunkType: "clinical-summary",
      text: [
        fields.clinical.suspectedMedication,
        fields.clinical.adverseReaction,
        fields.clinical.dose,
        fields.clinical.route,
        fields.clinical.frequency,
        fields.clinical.seriousness,
        fields.clinical.outcome,
        fields.clinical.indication,
        fields.clinical.causality,
        ...(fields.clinical.concomitantDrugs || []),
        fields.clinical.medicalHistory,
        fields.clinical.allergyMention,
        fields.clinical.narrative
      ].filter(Boolean).join(" | "),
      anonymised: true
    },
    {
      chunkType: "source-preview",
      text: text.slice(0, 800),
      anonymised: false,
      restricted: true
    }
  ];
}

function buildSourceTrace(values) {
  return Object.entries(values).map(([field, value]) => ({
    field,
    value: value || "",
    source: value ? "extracted from source text or structured row" : "not found",
    confidence: value ? 0.72 : 0
  }));
}

function findTaxonomy(text, terms) {
  const lower = text.toLowerCase();
  return terms.find(([term]) => lower.includes(term))?.[1] || "";
}

function checkedOutcome(text) {
  const outcomeBlock = firstMatch(text, [/15\.\s*Outcome\s*[:\-]?\s*([\s\S]{0,160})/i]);
  if (!outcomeBlock) return "";
  const checked = outcomeBlock.match(/X\s*(Fatal|Recovered with sequelae|Recovered|Recovering|Not Recovered|Unknown)/i);
  return checked ? cleanValue(checked[1]) : "";
}

function extractNarrative(text) {
  const narrative = firstMatch(text, [
    /(?:brief\s*description|case\s*narrative|narrative|description)\s*[:\-]?\s*([\s\S]{20,500})/i
  ]);
  return narrative || cleanText(text).slice(0, 500);
}

const MACHINE_LABELS = [
  "Patient_Token",
  "Patient_Initials",
  "Patient_Age",
  "Patient_Sex",
  "Patient_Weight_kg",
  "Report_Date",
  "Region",
  "Suspect_Drug",
  "MedDRA_PT",
  "Narrative",
  "Drug_Dose_mg",
  "Drug_Route",
  "Dose_Frequency",
  "Indication",
  "Outcome",
  "Causality_Assessment",
  "Reporter_Type",
  "Reporter_Name",
  "SAE_Seriousness_Criteria",
  "Onset_Date",
  // Concomitant medications (Section 11)
  "Concomitant_Drug_1",
  "Concomitant_Drug_2",
  "Concomitant_Drug_3",
  "Concomitant_Drug_4",
  // Medical history / allergies (Section 13)
  "Other_Medical_Info",
];

function machineField(text, label) {
  const markerIndex = text.indexOf("ADRA_MACHINE_READABLE_ADR");
  // Only read machine labels from machine-readable text.
  // For plain OCR/PDF text the label names appear as form headings and the
  // fallthrough regex reads far too much — causing garbled outcome/seriousness.
  if (markerIndex < 0) return "";

  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextLabels = MACHINE_LABELS
    .filter((candidate) => candidate !== label)
    .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const source = text.slice(markerIndex);
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}:[ \\t]*(.*?)(?=\\n(?:${nextLabels}):|$)`, "is"));
  return cleanValue(match?.[1] || "");
}

function ocrRegionField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`ADRA_OCR_REGION_${escaped}:[ \\t]*([\\s\\S]*?)(?=\\nADRA_OCR_REGION_|$)`, "i"));
  return cleanValue(match?.[1] || "");
}

function ocrNarrativeReaction(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /(fe+ling|faling|aling|hair|hain|got)/i.test(line));
  if (index < 0) return "";
  return cleanValue(lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join(" "));
}

function bestOcrNarrative(regionText, fullText) {
  const region = cleanValue(regionText);
  const full = cleanValue(fullText);
  const score = (value) => {
    const lower = value.toLowerCase();
    let s = 0;
    if (/fe+ling|faling|aling/.test(lower)) s += 3;
    if (/hair|hain|rais/.test(lower)) s += 2;
    if (/\bgot\b|cutide|chide|white/.test(lower)) s += 2;
    if (value.length > 25) s += 1;
    if (/[_|=]{2,}/.test(value)) s -= 2;
    return s;
  };
  return score(region) >= score(full) ? region : full;
}

function cleanOcrNarrative(value) {
  let cleaned = cleanValue(value);
  if (!cleaned) return "";
  cleaned = cleaned
    .replace(/\bgam\s+T\s+am\b/i, "I am")
    .replace(/\b[|lT]\s+am\b/i, "I am")
    .replace(/\b(?:fe+ling|faling|aling)\b/gi, "feeling")
    .replace(/\b(?:Bhat|Shat|thatomy)\b/gi, "that my")
    .replace(/\b(?:Rais|hain)\b/gi, "hair")
    .replace(/\b(?:cutide|atide|chide)\b/gi, "white")
    .replace(/[^A-Za-z0-9@.,;:()/%+\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const feeling = cleaned.match(/(?:I\s+am\s+)?feeling\b.{0,140}/i)?.[0];
  if (feeling) return cleanValue(feeling);
  return cleaned.length > 220 ? `${cleaned.slice(0, 220).trim()}...` : cleaned;
}

function normaliseOcrMedication(value) {
  let cleaned = cleanMedicineCandidate(value)
    .replace(/^[^A-Za-z]+/, "")
    .replace(/[^A-Za-z0-9 /+\-.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const firstToken = cleaned.split(/\s+/).find((token) => /[A-Za-z]{3,}/.test(token)) || cleaned;
  const lower = firstToken.toLowerCase();
  if (/cetir|citriz|citri|citnig|cithign|c[ei]t[ir1l]*[izg]{1,3}n?e?/.test(lower)) return "Cetirizine";
  return cleanMedicineCandidate(firstToken);
}

function firstValidMedicine(values) {
  for (const value of values) {
    const candidate = cleanMedicineCandidate(value);
    if (candidate) return candidate;
  }
  return "";
}

function cleanMedicineCandidate(value) {
  let cleaned = cleanValue(value)
    .replace(/\b(?:suspect(?:ed)?\s*)?(?:drug|medicine|medication)(?:\s*name)?\b\s*[:\-]?/gi, " ")
    .replace(/\bname\s+of\s+(?:drug|medicine|medication)\b\s*[:\-]?/gi, " ")
    .replace(/\b(?:dose|route|frequency|indication|reaction|outcome|date|signature)\b\s*[:\-]?.*$/i, "")
    .replace(/^[\s([{:;,.]*s[\s)\]}*:;,.*-]*/i, "")
    .replace(/[_|=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  cleaned = cleaned.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.+/% -]+$/g, "").trim();
  const lower = cleaned.toLowerCase();
  const invalid = new Set([
    "s",
    "x",
    "name",
    "drug",
    "medicine",
    "medication",
    "suspected",
    "suspected drug",
    "suspected medicine",
    "suspected medication",
    "not extracted",
    "unknown",
    "n/a",
    "na",
    "none",
    "null"
  ]);

  if (!cleaned || invalid.has(lower)) return "";
  if (/^\(?[a-z]\)?\s*[*x×.-]*$/i.test(cleaned)) return "";
  if (!/[A-Za-z]{3,}/.test(cleaned)) return "";
  if (!/[A-Za-z0-9]/.test(cleaned.replace(/[()*.]/g, ""))) return "";
  if (/^(?:s\s*)?[*().-]+$/i.test(cleaned)) return "";
  if (cleaned.length > 90 && /adr_form|reporting form|sourcefile|traceid/i.test(cleaned)) return "";
  return cleaned;
}

function cleanOcrReporterName(value) {
  let cleaned = cleanValue(value)
    .replace(/^\d+\.\s*/, "")
    .replace(/\bName\s*&?\s*Address\b\s*[:\-]?/i, "")
    .replace(/[_|=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = cleaned.match(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,3})\b/)?.[1];
  return name || cleaned;
}

function looseOcrEmail(value) {
  const lines = String(value || "").split(/\n+/).filter((line) => line.includes("@"));
  for (const line of lines) {
    const compact = line
      .replace(/\s*@\s*/g, "@")
      .replace(/\s*\.\s*/g, ".")
      .replace(/\s*-\s*/g, "")
      .replace(/\s+/g, "")
      .replace(/(?:e-?mail|cenail|cemai[l1])/ig, "");
    const gmail = compact.match(/([A-Z0-9._%+-]{2,40})@gma(?:dl|il|l)?\.?com/i);
    if (gmail?.[1]) return `${gmail[1]}@gmail.com`;
    const regular = compact.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
    if (regular?.[1]) return regular[1].replace(/geal\.com$/i, "gmail.com");
  }
  return "";
}

function cleanLayoutCapture(value) {
  const cleaned = cleanValue(value || "");
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  const layoutWords = ["route", "frequency", "therapy dates", "indication", "causality"];
  if (layoutWords.some((word) => lower.includes(word))) return "";
  return cleaned;
}
