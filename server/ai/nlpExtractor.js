import { bandAge, bandWeight, cleanText, cleanValue, exactString, firstMatch, tokenFor } from "./textUtils.js";

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
  const adverseReaction = exactString(rowCandidate.adverseEvent) || machine("MedDRA_PT") || narrativeReaction || (!machineReadable ? firstMatch(text, [
    /^MedDRA_PT:[ \t]*([^\n]{2,100})/im,
    /MedDRA\s+PT\s*[:\-]?\s*([^\n]{3,100})/i,
    /\bPT\s*[:\-]?\s*([^\n]{3,100})/i,
    /(?:adverse\s*(?:event|reaction)|reaction)\s*[:\-]?\s*([^\n]{3,120})/i,
    /description\s+of\s+reaction\s*[:\-]?\s*([^\n]{3,120})/i
  ]) : "");
  const suspectedMedication = exactString(rowCandidate.medicineName) || machine("Suspect_Drug") || (!machineReadable ? firstMatch(text, [
    /^Suspect_Drug:[ \t]*([^\n]{2,120})/im,
    /\bi\s+([A-Za-z][A-Za-z0-9 /+-]{1,80}?)\s+N\/A\s+N\/A\s+N\/A\s+\d/i,
    /(?:suspected\s*(?:medication|drug|medicine)|medicine\s*name|drug\s*name)\s*[:\-]?\s*([^\n]{2,120})/i,
    /(?:medication\(s\)|suspected medication\(s\))\s*[:\-]?\s*([^\n]{2,120})/i
  ]) : "");
  const reporterName = machine("Reporter_Name") || machine("Reporter_Type") || firstMatch(text, [
    /^Reporter_Name:[ \t]*([^\n]{3,100})/im,
    /^Reporter_Type:[ \t]*([^\n]{3,100})/im,
    /Name\s*&\s*Address\s*[:\-]?\s*([^\n]{3,100})/i,
    /reporter(?:'s)?\s*name\s*[:\-]?\s*([^\n]{3,100})/i,
    /name\s+of\s+reporter\s*[:\-]?\s*([^\n]{3,100})/i
  ]);
  const reporterEmail = firstMatch(text, [/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i]);
  const reporterPhone = firstMatch(text, [/Contact\s+No-?\s*[:\-]?\s*(\+?\d[\d\s-]{8,14}\d)/i, /\b(\+?\d[\d\s-]{8,14}\d)\b/]);
  const outcome = exactString(rowCandidate.outcome) || machine("Outcome") || (!machineReadable ? checkedOutcome(text) || findTaxonomy(text, OUTCOME_TERMS) : "");
  const seriousness = machine("SAE_Seriousness_Criteria") || (!machineReadable ? findTaxonomy(text, SERIOUSNESS_TERMS) || (String(rowCandidate.riskFlags || "").includes("serious") ? "Other medically important" : "") : "");
  const dose = exactString(rowCandidate.dose) || machine("Drug_Dose_mg") || (!machineReadable ? firstMatch(text, /\bi\s+[A-Za-z][^\n]*?\s+(\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg))\s+/i) || cleanLayoutCapture(firstMatch(text, /dose\s*[:\-]?\s*([^\n]{1,50})/i)) : "");
  const route = exactString(rowCandidate.route) || machine("Drug_Route") || (!machineReadable ? firstMatch(text, /\bi\s+[A-Za-z][^\n]*?\s+\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg)\s+([A-Za-z]+)\s+/i) || cleanLayoutCapture(firstMatch(text, /route\s*[:\-]?\s*([^\n]{1,50})/i)) : "");
  const frequency = exactString(rowCandidate.frequency) || machine("Dose_Frequency") || (!machineReadable ? firstMatch(text, /\bi\s+[A-Za-z][^\n]*?\s+\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg)\s+[A-Za-z]+\s+([A-Za-z]+)\s+/i) || cleanLayoutCapture(firstMatch(text, /frequency\s*[:\-]?\s*([^\n]{1,50})/i)) : "");

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
      reactionOnsetDate: machine("Onset_Date") || (!machineReadable ? firstMatch(text, /(?:onset|event\s*\/\s*reaction\s*start\s*date|reaction\s*start)\s*(?:\(dd\/mm\/yyyy\))?\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) : ""),
      narrative: extractNarrative(text)
    },
    sourceTrace: buildSourceTrace({ patientInitials, age, gender, weight, suspectedMedication, adverseReaction, dose, route, frequency, reporterName, reporterEmail, reporterPhone, outcome, seriousness })
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
  "Onset_Date"
];

function machineField(text, label) {
  const markerIndex = text.indexOf("ADRA_MACHINE_READABLE_ADR");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextLabels = MACHINE_LABELS
    .filter((candidate) => candidate !== label)
    .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (markerIndex >= 0) {
    const source = text.slice(markerIndex);
    const match = source.match(new RegExp(`(?:^|\\n)${escaped}:[ \\t]*(.*?)(?=\\n(?:${nextLabels}):|$)`, "is"));
    return cleanValue(match?.[1] || "");
  }
  const match = text.match(new RegExp(`(?:^|\\s)${escaped}:[ \\t]*(.*?)(?=\\s+(?:${nextLabels}):|$)`, "is"));
  return cleanValue(match?.[1] || "");
}

function cleanLayoutCapture(value) {
  const cleaned = cleanValue(value || "");
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  const layoutWords = ["route", "frequency", "therapy dates", "indication", "causality"];
  if (layoutWords.some((word) => lower.includes(word))) return "";
  return cleaned;
}
