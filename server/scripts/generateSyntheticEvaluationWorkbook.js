import crypto from "crypto";
import xlsx from "xlsx";

const SOURCE_WORKBOOK = "CDSCO_AI_Datasets.xlsx";
const OUTPUT_WORKBOOK = "ADRA_Synthetic_Evaluation_Dataset.xlsx";

const RNG_SEED = "adra-synthetic-eval-v1";
const RECORDS = 2200;
const DUPLICATE_RATE = 0.09;
const FOLLOWUP_RATE = 0.12;
const MISSINGNESS_RATE = 0.11;

const SERIOUSNESS_LABELS = [
  "Death",
  "Life-threatening",
  "Hospitalisation",
  "Disability/incapacity",
  "Congenital anomaly",
  "Other medically important",
  "Non-serious"
];

const OUTCOME_LABELS = [
  "Recovered",
  "Recovering",
  "Not recovered",
  "Fatal",
  "Recovered with sequelae",
  "Unknown"
];

const REPORTER_TYPES = ["Physician", "Consumer", "Nurse", "Pharmacist", "PvPI associate"];
const SEX = ["Male", "Female", "Other", "Unknown"];
const ROUTES = ["Oral", "IV", "IM", "SC", "Topical", "Inhalation"];
const FREQS = ["OD", "BD", "TDS", "QID", "SOS", "Weekly"];
const REGIONS_FALLBACK = ["North", "South", "East", "West", "Central", "North-East"];

function main() {
  const source = xlsx.readFile(SOURCE_WORKBOOK);
  const baseIcsrs = readRows(source, "1_SAE_ICSRs");
  const baseAnonym = readRows(source, "5_Anonymization_CRF");
  const baseKpis = readRows(source, "6_Dashboard_KPIs");

  const drugs = uniq(baseIcsrs.map((r) => clean(r.Suspect_Drug))).filter(Boolean);
  const pts = uniq(baseIcsrs.map((r) => clean(r.MedDRA_PT))).filter(Boolean);
  const socs = uniq(baseIcsrs.map((r) => clean(r.MedDRA_SOC))).filter(Boolean);
  const regions = uniq(baseIcsrs.map((r) => clean(r.Region))).filter(Boolean);
  const indications = uniq(baseIcsrs.map((r) => clean(r.Indication))).filter(Boolean);
  const sites = uniq(baseIcsrs.map((r) => clean(r.Site_ID))).filter(Boolean);

  const rng = seeded(RNG_SEED);

  const guidelineVersions = buildGuidelines();
  const ICSR = [];
  const pairs = [];
  const signals = new Map();

  const createdCases = [];
  const patientAnchors = [];
  const reporterAnchors = [];

  for (let index = 0; index < RECORDS; index += 1) {
    const monthOffset = Math.floor(rng() * 18);
    const reportDate = dateIso(addMonths(new Date("2025-01-01"), monthOffset));
    const onsetDate = dateIso(addDays(new Date(reportDate), -Math.floor(rng() * 21)));
    const patientAge = String(randInt(rng, 1, 92));
    const sex = pick(rng, SEX);
    const weight = (Math.round((randFloat(rng, 35, 95) + (sex === "Male" ? 2.4 : -1.2)) * 10) / 10).toFixed(1);

    const suspectDrug = pick(rng, drugs.length ? drugs : ["Paracetamol"]);
    const meddraPt = pick(rng, pts.length ? pts : ["Nausea"]);
    const meddraSoc = pick(rng, socs.length ? socs : ["Gastrointestinal disorders"]);
    const region = pick(rng, regions.length ? regions : REGIONS_FALLBACK);
    const site = pick(rng, sites.length ? sites : ["AMC-001"]);
    const reporterType = pick(rng, REPORTER_TYPES);

    const seriousness = sampleSeriousness(rng);
    const outcome = sampleOutcome(rng, seriousness);
    const causality = sampleCausality(rng, seriousness);
    const route = pick(rng, ROUTES);
    const doseMg = String(randInt(rng, 50, 800));
    const doseFreq = pick(rng, FREQS);
    const indication = pick(rng, indications.length ? indications : ["Fever"]);
    const narrative = buildNarrative({ suspectDrug, meddraPt, seriousness, outcome, reporterType, region }, rng);

    const patientKey = `${patientAge}|${sex}|${weight}`;
    const reporterKey = `${reporterType}|${site}`;
    const patientToken = stableToken("PAT", patientKey, rng, patientAnchors);
    const reporterToken = stableToken("REP", reporterKey, rng, reporterAnchors);

    const sourceHash = sha256String(`src:${suspectDrug}|${meddraPt}|${patientToken}|${onsetDate}|${narrative.slice(0, 40)}`);
    const icsrId = `ICSR-SYN-${String(index + 1).padStart(5, "0")}`;
    const caseAnchor = `${patientToken}|${suspectDrug}|${meddraPt}`;
    const caseRecordId = `PVPI-CASE-${sha256String(caseAnchor).slice(0, 12).toUpperCase()}`;

    const baseRow = {
      ICSR_ID: icsrId,
      Report_Date: reportDate,
      Onset_Date: onsetDate,
      Reporter_Type: reporterType,
      Patient_Age: patientAge,
      Patient_Sex: sex,
      Patient_Weight_kg: weight,
      Suspect_Drug: suspectDrug,
      Drug_Route: route,
      Drug_Dose_mg: doseMg,
      Dose_Frequency: doseFreq,
      Indication: indication,
      MedDRA_SOC: meddraSoc,
      MedDRA_PT: meddraPt,
      MedDRA_LLT: meddraPt,
      SAE_Seriousness_Criteria: seriousness === "Non-serious" ? "Non-serious" : seriousness,
      Outcome: outcome,
      Causality_Assessment: causality,
      Dechallenge: rng() < 0.62 ? "Improved" : rng() < 0.8 ? "Not improved" : "Unknown",
      Rechallenge: rng() < 0.12 ? "Positive" : rng() < 0.28 ? "Negative" : "Not done",
      Concomitant_Drugs: rng() < 0.35 ? pick(rng, drugs) : "",
      Narrative: narrative,
      Site_ID: site,
      Region: region
    };

    const maybeMissing = injectMissingness(baseRow, rng);
    const evaluation = scoreAndRoute(maybeMissing);
    const expectedGuidelineVersion = pick(rng, guidelineVersions.map((g) => g.Guideline_Version));

    const processedRow = {
      ...maybeMissing,
      Source_Hash: sourceHash,
      Patient_Token: patientToken,
      Reporter_Token: reporterToken,
      Case_Record_ID: caseRecordId,
      Expected_Guideline_Version: expectedGuidelineVersion,
      Expected_Score_0_100: evaluation.score,
      Expected_Route: evaluation.route,
      Expected_Confidence_0_1: evaluation.confidence,
      Expected_Relation: "new",
      Relation_Basis: "No prior case match for patient token + drug + reaction."
    };

    createdCases.push(processedRow);
    ICSR.push(processedRow);
    upsertSignal(signals, reportDate.slice(0, 7), suspectDrug, meddraPt, seriousness, evaluation.confidence);
  }

  // Deterministic duplicates and follow-ups
  const casePool = createdCases.slice();
  const dupeCount = Math.floor(RECORDS * DUPLICATE_RATE);
  const followCount = Math.floor(RECORDS * FOLLOWUP_RATE);
  const rng2 = seeded(`${RNG_SEED}:linkage`);

  for (let i = 0; i < dupeCount; i += 1) {
    const base = pick(rng2, casePool);
    const nextId = `ICSR-SYN-DUPE-${String(i + 1).padStart(4, "0")}`;
    const duplicate = {
      ...base,
      ICSR_ID: nextId,
      Report_Date: dateIso(addDays(new Date(base.Report_Date), randInt(rng2, 0, 3))),
      Expected_Relation: "duplicate",
      Relation_Basis: "Same source document hash already exists."
    };
    ICSR.push(duplicate);
    pairs.push({
      Pair_ID: `PAIR-DUPE-${String(i + 1).padStart(4, "0")}`,
      Base_ICSR_ID: base.ICSR_ID,
      New_ICSR_ID: duplicate.ICSR_ID,
      Expected_Relation: "duplicate",
      Basis: "Same Source_Hash"
    });
  }

  for (let i = 0; i < followCount; i += 1) {
    const base = pick(rng2, casePool);
    const nextId = `ICSR-SYN-FU-${String(i + 1).padStart(4, "0")}`;
    const changedOutcome = pick(rng2, OUTCOME_LABELS.filter((o) => o.toLowerCase() !== String(base.Outcome || "").toLowerCase()));
    const changedSerious = rng2() < 0.45 ? sampleSeriousness(rng2) : base.SAE_Seriousness_Criteria;
    const followup = {
      ...base,
      ICSR_ID: nextId,
      Source_Hash: sha256String(`src:followup:${base.Source_Hash}:${changedOutcome}:${changedSerious}`),
      Report_Date: dateIso(addDays(new Date(base.Report_Date), randInt(rng2, 4, 35))),
      Outcome: changedOutcome,
      SAE_Seriousness_Criteria: changedSerious,
      Narrative: `${base.Narrative} Follow-up update: outcome now documented as ${changedOutcome}.`,
      Expected_Relation: "followup",
      Relation_Basis: "Same patient/drug/reaction anchor exists, but outcome/seriousness/narrative changed or was added."
    };
    const reEval = scoreAndRoute(followup);
    followup.Expected_Score_0_100 = reEval.score;
    followup.Expected_Route = reEval.route;
    followup.Expected_Confidence_0_1 = reEval.confidence;

    ICSR.push(followup);
    pairs.push({
      Pair_ID: `PAIR-FU-${String(i + 1).padStart(4, "0")}`,
      Base_ICSR_ID: base.ICSR_ID,
      New_ICSR_ID: followup.ICSR_ID,
      Expected_Relation: "followup",
      Basis: "Same Patient_Token + Suspect_Drug + MedDRA_PT; changed Outcome/Seriousness/Narrative"
    });
  }

  const anonymRows = buildAnonymisationRows(baseAnonym, rng);
  const kpiRows = buildKpis(baseKpis, rng);
  const modelPerfRows = buildModelPerformance(rng);
  const ragQueries = buildRagQueries(rng, ICSR);
  const signalRows = [...signals.values()].sort((a, b) => a.Month.localeCompare(b.Month) || a.Suspect_Drug.localeCompare(b.Suspect_Drug));

  const wb = xlsx.utils.book_new();
  addSheet(wb, "ADRA_ICSR_Synthetic", ICSR);
  addSheet(wb, "Duplicate_Followup_Pairs", pairs);
  addSheet(wb, "Signals_Monthly", signalRows);
  addSheet(wb, "RAG_Queries", ragQueries);
  addSheet(wb, "Model_Performance", modelPerfRows);
  addSheet(wb, "Anonymization_Samples", anonymRows);
  addSheet(wb, "Dashboard_KPIs_Synthetic", kpiRows);
  addSheet(wb, "Guideline_Profiles", guidelineVersions);

  xlsx.writeFile(wb, OUTPUT_WORKBOOK, { compression: true });
  console.log(JSON.stringify({ output: OUTPUT_WORKBOOK, sheets: wb.SheetNames, rows: { ICSR: ICSR.length, pairs: pairs.length } }, null, 2));
}

function readRows(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  return xlsx.utils.sheet_to_json(ws, { defval: "" });
}

function addSheet(workbook, name, rows) {
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(workbook, ws, name);
}

function buildGuidelines() {
  return [
    {
      Guideline_Version: "guideline-v1",
      Mandatory_Fields: "Patient_Age, Patient_Sex, Suspect_Drug, MedDRA_PT, Reporter_Type",
      Confidence_Threshold: 0.65,
      Followup_Route: "needs_followup",
      Manual_Review_Route: "manual_review",
      Ready_Route: "ready_for_processing",
      Score_Rule: "100 - 14*(missing mandatory fields) - 12*(confidence<0.6)"
    },
    {
      Guideline_Version: "guideline-v2",
      Mandatory_Fields: "Patient_Age, Patient_Sex, Suspect_Drug, MedDRA_PT, Reporter_Type, Onset_Date",
      Confidence_Threshold: 0.7,
      Followup_Route: "needs_followup",
      Manual_Review_Route: "manual_review",
      Ready_Route: "ready_for_processing",
      Score_Rule: "100 - 12*(missing mandatory fields) - 12*(confidence<0.6)"
    }
  ];
}

function buildModelPerformance(rng) {
  const months = [];
  for (let i = 0; i < 18; i += 1) {
    const month = addMonths(new Date("2025-01-01"), i);
    months.push(dateIso(month).slice(0, 7));
  }
  return months.flatMap((month) => ([
    modelRow("severity-priority", "Severity priority classifier", month, rng, 0.78, 0.88),
    modelRow("completeness-routing", "Completeness routing classifier", month, rng, 0.72, 0.86),
    modelRow("duplicate-followup", "Duplicate/follow-up linkage model", month, rng, 0.81, 0.93),
    modelRow("pii-phi-ner", "PII/PHI detection (hybrid)", month, rng, 0.84, 0.96),
    modelRow("summariser", "Regulatory summariser", month, rng, 0.7, 0.9)
  ]));
}

function modelRow(id, name, month, rng, min, max) {
  const accuracy = round2(randFloat(rng, min, max));
  const precision = round2(Math.max(0.35, accuracy - randFloat(rng, 0.02, 0.12)));
  const recall = round2(Math.max(0.35, accuracy - randFloat(rng, 0.02, 0.14)));
  const f1 = round2((2 * precision * recall) / Math.max(precision + recall, 0.0001));
  const latencyMsP95 = Math.round(randFloat(rng, 120, 1100));
  return {
    Month: month,
    Model_ID: id,
    Model_Name: name,
    Dataset_Slice: "Synthetic evaluation workbook",
    Accuracy: accuracy,
    Precision: precision,
    Recall: recall,
    F1: f1,
    Support: randInt(rng, 120, 620),
    Latency_P95_ms: latencyMsP95,
    Notes: "Synthetic metrics for dashboard and credibility evaluation."
  };
}

function buildRagQueries(rng, icsrRows) {
  const medicines = uniq(icsrRows.map((r) => clean(r.Suspect_Drug))).filter(Boolean).slice(0, 40);
  const pts = uniq(icsrRows.map((r) => clean(r.MedDRA_PT))).filter(Boolean).slice(0, 60);
  const queries = [];

  for (let i = 0; i < 90; i += 1) {
    const medicine = pick(rng, medicines.length ? medicines : ["Paracetamol"]);
    const reaction = pick(rng, pts.length ? pts : ["Nausea"]);
    const gender = pick(rng, ["Male", "Female"]);
    const ageBand = pick(rng, ["Under-18", "18-35", "36-55", "56-70", "70+"]);
    const windowStart = pick(rng, ["2025-01", "2025-04", "2025-07", "2025-10", "2026-01"]);
    const windowEnd = pick(rng, ["2026-02", "2026-04", "2026-06"]);
    const matching = icsrRows
      .filter((r) => clean(r.Suspect_Drug) === clean(medicine) && clean(r.MedDRA_PT) === clean(reaction))
      .slice(0, 8)
      .map((r) => r.ICSR_ID);

    queries.push({
      Query_ID: `RAG-Q-${String(i + 1).padStart(3, "0")}`,
      Query_Text: `Which patterns are emerging for ${medicine} and ${reaction} in ${gender} patients aged ${ageBand}, and what evidence supports it?`,
      Filters: `Suspect_Drug=${medicine}; MedDRA_PT=${reaction}; Patient_Sex=${gender}; Age_Band=${ageBand}; Month=${windowStart}..${windowEnd}`,
      Expected_Evidence_IDs: matching.join(", "),
      Expected_Answer_Format: "Concise standardised summary with evidence bullets and confidence.",
      Expected_Confidence_0_1: round2(randFloat(rng, 0.55, 0.92)),
      Guardrails: "No fabricated facts; cite evidence IDs; do not reveal PII/PHI."
    });
  }

  return queries;
}

function buildAnonymisationRows(baseRows, rng) {
  const rows = [];
  const templates = [
    "Patient {NAME} (phone {PHONE}) reported {ADR} after {DRUG} on {DATE}. Address: {ADDR}.",
    "Subject {SUBJECT} visited on {DATE}. Email {EMAIL}. Complaint: {ADR}.",
    "Investigator note: {NAME} from {ADDR} experienced {ADR}. Contact {PHONE}."
  ];
  for (let i = 0; i < 420; i += 1) {
    const name = `Person_${randInt(rng, 100, 999)}`;
    const phone = `9${randInt(rng, 100000000, 999999999)}`;
    const email = `user${randInt(rng, 100, 999)}@example.com`;
    const addr = `District_${randInt(rng, 1, 35)}, State_${randInt(rng, 1, 29)}`;
    const drug = pick(rng, ["Paracetamol", "Amoxicillin", "Heparin", "Ibuprofen", "Cefixime"]);
    const adr = pick(rng, ["Rash", "Nausea", "Anaphylaxis", "Sepsis", "Breathlessness", "Headache"]);
    const date = dateIso(addDays(new Date("2025-01-01"), randInt(rng, 0, 540)));
    const subject = `SUBJ-${randInt(rng, 10, 9999)}`;

    const raw = fill(pick(rng, templates), { NAME: name, PHONE: phone, EMAIL: email, ADDR: addr, DRUG: drug, ADR: adr, DATE: date, SUBJECT: subject });
    const masked = raw
      .replace(name, "NAME_TKN_XXXX")
      .replace(phone, "PHONE_TKN_XXXX")
      .replace(email, "EMAIL_TKN_XXXX")
      .replace(addr, "LOCATION_GEN_STATE_ONLY");

    rows.push({
      CRF_ID: `CRF-SYN-${String(i + 1).padStart(4, "0")}`,
      Subject_ID: subject,
      Visit: `V${randInt(rng, 1, 6)}`,
      Raw_Text: raw,
      Masked_Text: masked,
      PII_Entities_Detected: "NAME, PHONE, EMAIL, ADDRESS",
      PII_Entity_Count: 4,
      Anonymization_Method: pick(rng, ["Pseudonymisation", "Generalisation", "Hybrid"]),
      Risk_Score_0_10: randInt(rng, 1, 9),
      DPDPA_Compliant: "Yes",
      HIPAA_Equivalent: "Yes",
      Residual_Identifiability: pick(rng, ["Low", "Medium"]),
      Data_Category: pick(rng, ["PII", "PHI", "Mixed"])
    });
  }

  // keep some rows aligned to the original sheet length, but do not reuse raw text
  const target = Math.max(480, baseRows.length || 0);
  return rows.slice(0, target);
}

function buildKpis(baseRows, rng) {
  const months = uniq(baseRows.map((r) => clean(r.Month))).filter(Boolean);
  const divisions = uniq(baseRows.map((r) => clean(r.Division))).filter(Boolean);
  const out = [];
  const monthList = months.length ? months : Array.from({ length: 18 }, (_, i) => dateIso(addMonths(new Date("2025-01-01"), i)).slice(0, 7));
  const divList = divisions.length ? divisions : ["CT", "PvPI", "SAE", "Inspections"];

  for (const month of monthList) {
    for (const division of divList) {
      const received = randInt(rng, 20, 180);
      const approved = randInt(rng, 5, Math.max(6, Math.floor(received * 0.7)));
      const rejected = randInt(rng, 1, Math.max(2, Math.floor(received * 0.15)));
      const pending = Math.max(0, received - approved - rejected);
      const avgReview = randInt(rng, 6, 38);
      const sla = round2(randFloat(rng, 0.62, 0.95));
      out.push({
        Month: month,
        Division: division,
        Applications_Received: received,
        Applications_Approved: approved,
        Applications_Rejected: rejected,
        Applications_Pending: pending,
        Avg_Review_Days: avgReview,
        SLA_Met_Pct: sla,
        Additional_Info_Requests: randInt(rng, 0, 60),
        SAE_Reports_Received: randInt(rng, 0, 140),
        SAE_Reports_Closed: randInt(rng, 0, 120),
        Critical_Issues_Identified: randInt(rng, 0, 25),
        Inspections_Conducted: randInt(rng, 0, 14),
        Deficiency_Letters_Issued: randInt(rng, 0, 40),
        Appeals_Filed: randInt(rng, 0, 9),
        Staff_Workload_Index: round2(randFloat(rng, 0.4, 1.3)),
        Processing_Efficiency_Pct: round2(randFloat(rng, 0.55, 0.93))
      });
    }
  }
  return out;
}

function scoreAndRoute(row) {
  const missing = [];
  if (!clean(row.Patient_Age)) missing.push("Patient_Age");
  if (!clean(row.Patient_Sex)) missing.push("Patient_Sex");
  if (!clean(row.Suspect_Drug)) missing.push("Suspect_Drug");
  if (!clean(row.MedDRA_PT)) missing.push("MedDRA_PT");
  if (!clean(row.Reporter_Type)) missing.push("Reporter_Type");

  const coverage = 1 - (missing.length / 5);
  const parserConfidence = clean(row.Narrative).length < 80 ? 0.55 : 0.72;
  const overall = round2((coverage * 0.55) + (parserConfidence * 0.45));
  const score = Math.max(0, Math.round(100 - missing.length * 14 - (overall < 0.6 ? 12 : 0)));
  const route = missing.length ? "needs_followup" : overall < 0.65 ? "manual_review" : "ready_for_processing";

  return { score, route, confidence: overall, missingMandatory: missing.join(", ") };
}

function injectMissingness(row, rng) {
  const out = { ...row };
  const allowMissing = rng() < MISSINGNESS_RATE;
  if (!allowMissing) return out;
  const targets = ["Patient_Age", "Patient_Sex", "Suspect_Drug", "MedDRA_PT", "Reporter_Type", "Patient_Weight_kg", "Onset_Date"];
  const count = randInt(rng, 1, 2);
  for (let i = 0; i < count; i += 1) {
    out[pick(rng, targets)] = "";
  }
  return out;
}

function sampleSeriousness(rng) {
  const p = rng();
  if (p < 0.05) return "Death";
  if (p < 0.11) return "Life-threatening";
  if (p < 0.24) return "Hospitalisation";
  if (p < 0.28) return "Disability/incapacity";
  if (p < 0.3) return "Congenital anomaly";
  if (p < 0.43) return "Other medically important";
  return "Non-serious";
}

function sampleOutcome(rng, seriousness) {
  if (seriousness === "Death") return "Fatal";
  const p = rng();
  if (p < 0.32) return "Recovered";
  if (p < 0.58) return "Recovering";
  if (p < 0.72) return "Not recovered";
  if (p < 0.82) return "Recovered with sequelae";
  return "Unknown";
}

function sampleCausality(rng, seriousness) {
  const labels = ["Certain", "Probable/Likely", "Possible", "Unlikely", "Conditional/unclassified", "Unassessable/unclassifiable"];
  if (seriousness === "Death" && rng() < 0.22) return "Possible";
  return pick(rng, labels);
}

function buildNarrative({ suspectDrug, meddraPt, seriousness, outcome, reporterType, region }, rng) {
  const detail = rng() < 0.55 ? "Clinical details documented in report." : "Additional follow-up required for some fields.";
  const seriousNote = seriousness === "Non-serious" ? "Non-serious ADR reported." : `Seriousness: ${seriousness}.`;
  return `Reporter type ${reporterType} from ${region} reported ${meddraPt} after exposure to ${suspectDrug}. ${seriousNote} Outcome: ${outcome}. ${detail}`;
}

function upsertSignal(map, month, drug, reaction, seriousness, confidence) {
  const key = `${month}|${drug}|${reaction}`;
  const existing = map.get(key) || {
    Month: month,
    Suspect_Drug: drug,
    MedDRA_PT: reaction,
    Reports: 0,
    Serious_Reports: 0,
    Avg_Confidence: 0,
    Signal_Basis: ""
  };
  existing.Reports += 1;
  existing.Serious_Reports += seriousness !== "Non-serious" ? 1 : 0;
  existing.Avg_Confidence = round2(((existing.Avg_Confidence * (existing.Reports - 1)) + confidence) / existing.Reports);
  existing.Signal_Basis = `${existing.Reports} report(s); serious rate ${Math.round((existing.Serious_Reports / existing.Reports) * 100)}%.`;
  map.set(key, existing);
}

function sha256String(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function stableToken(prefix, seedValue, rng, pool) {
  // 20% chance to reuse a prior token anchor to create duplicates/followups across different docs
  if (pool.length && rng() < 0.2) return pick(rng, pool);
  const token = `${prefix}_TKN_${sha256String(`${prefix}:${seedValue}:${Math.floor(rng() * 1e9)}`).slice(0, 10).toUpperCase()}`;
  pool.push(token);
  return token;
}

function seeded(seed) {
  // xorshift32 with seed derived from sha256
  const h = crypto.createHash("sha256").update(seed).digest();
  let state = h.readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = (state >>> 0) / 0xffffffff;
    return value;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randFloat(rng, min, max) {
  return (rng() * (max - min)) + min;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function uniq(list) {
  return [...new Set(list)];
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dateIso(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function fill(template, values) {
  return template.replace(/\{([A-Z_]+)\}/g, (_match, key) => String(values[key] || ""));
}

main();

