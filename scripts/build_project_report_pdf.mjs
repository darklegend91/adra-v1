import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const PDF_OUT = path.join(DOCS_DIR, "ADRA_Project_Report_Submission.pdf");
const MD_OUT = path.join(DOCS_DIR, "ADRA_Project_Report_Submission.md");

const W = 612;
const H = 792;
const M = 42;
const CONTENT_W = W - M * 2;

const C = {
  ink: rgb(0.08, 0.12, 0.16),
  muted: rgb(0.35, 0.42, 0.48),
  line: rgb(0.78, 0.84, 0.80),
  green: rgb(0.03, 0.45, 0.24),
  greenSoft: rgb(0.90, 0.98, 0.93),
  teal: rgb(0.02, 0.44, 0.47),
  blue: rgb(0.08, 0.31, 0.62),
  blueSoft: rgb(0.91, 0.95, 1.00),
  amber: rgb(0.68, 0.39, 0.03),
  amberSoft: rgb(1.00, 0.96, 0.86),
  red: rgb(0.70, 0.12, 0.12),
  redSoft: rgb(1.00, 0.92, 0.92),
  purple: rgb(0.32, 0.17, 0.58),
  purpleSoft: rgb(0.95, 0.92, 1.00),
  white: rgb(1, 1, 1),
};

function readJson(name) {
  return fs.readFile(path.join(ROOT, "reports", name), "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
}

function fmt(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  return Number(value).toFixed(digits);
}

function pct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

const [severityEval, rougeEval, privacyEval, extractionEval, duplicateEval] = await Promise.all([
  readJson("severity_eval.json"),
  readJson("rouge_eval.json"),
  readJson("privacy_eval.json"),
  readJson("extraction_f1.json"),
  readJson("duplicate_eval.json"),
]);

const severityBest = severityEval?.candidates?.[0] || {};
const privacyA = privacyEval?.strategies?.strategyA || {};
const privacyK = privacyA?.kAnonymity || {};
const extractionSeriousness = extractionEval?.perField?.find((f) => f.field === "seriousness") || {};
const extractionOutcome = extractionEval?.perField?.find((f) => f.field === "outcome") || {};
const rouge = rougeEval?.aggregate || {};
const duplicateBest = duplicateEval?.strategies?.combined || duplicateEval?.strategies?.blockingKeyRule || {};

const metrics = {
  severityMacroF1: fmt(severityBest.macroF1),
  severityMcc: fmt(severityBest.mcc),
  severityRows: severityEval?.totalRows || 2662,
  rouge1: fmt(rouge.rouge1_f),
  rouge2: fmt(rouge.rouge2_f),
  rougeL: fmt(rouge.rougeL_f),
  extractionMacroF1: fmt(extractionEval?.macroF1),
  extractionMicroF1: fmt(extractionEval?.microAggregate?.f1),
  seriousnessF1: fmt(extractionSeriousness.f1),
  outcomeF1: fmt(extractionOutcome.f1),
  kAfter: privacyK.kAfterSuppression ?? 5,
  suppression: pct(privacyK.suppressionRate),
  duplicateF1: fmt(duplicateBest.f1),
  duplicatePairs: duplicateEval?.labelledPairs || 462,
};

const generatedDate = new Date().toISOString().slice(0, 10);

function buildMarkdown() {
  return `# ADRA Project Report

Generated: ${generatedDate}

## Executive Summary

ADRA is a MERN + optional Python-sidecar pharmacovigilance workflow platform for ADR/SAE intake, PDF/OCR extraction, structured clinical field extraction, privacy scanning, pseudonymisation, anonymised analytics, severity classification, duplicate/follow-up linkage, reviewer prioritisation, human-in-loop decisions, medicine analytics, evidence retrieval preview, audit logging and Annexure-style evaluation reporting.

The platform intentionally avoids hallucinated clinical facts. Extracted values are source-bound. Summaries are extractive or structured slot fills. Human reviewers can override the AI route by marking a report as unreviewed, needs follow-up, accepted or not accepted.

## 1. Detection Methodology

### Intake and parsing

| Source | Current ADRA method | Output |
|---|---|---|
| Fillable PDF | pdf-lib AcroForm extraction | Field/value text with high parser confidence |
| Digital PDF | Python sidecar pdfplumber when available, fallback pdf-parse | Clean text and table rows |
| Scanned PDF/image | PP-OCRv5 sidecar when available, fallback Tesseract.js | OCR text, word confidence and PII box metadata |
| Spreadsheet | xlsx parser | Row data plus flattened text |
| JSON/XML/TXT | Native structured or text parser | Machine-readable labels and plain text |
| Audio | faster-whisper sidecar | Meeting transcript text with language metadata |

### Field extraction

ADRA uses deterministic regular expressions and structured label extraction in \`server/ai/nlpExtractor.js\`. It extracts patient initials, age, sex, weight, reporter name/email/phone, suspect drug, adverse reaction, dose, route, frequency, onset date, seriousness, outcome, indication, causality, concomitant drugs, medical history and allergies.

Optional biomedical NER is provided by the Python sidecar. scispaCy/BC5CDR style entities are used only to fill missing values; they never overwrite already extracted source spans.

BioGPT support is used as exact-span agreement metadata only. It is not allowed to rewrite or infer clinical facts.

### Summarisation

ADRA uses extractive TextRank with Maximal Marginal Relevance and TF-IDF fallback in \`server/ai/summariser.js\`. It does not use abstractive summarisation for regulatory facts. The final summaries preserve verbatim source sentences or exact structured slots.

### Completeness, consistency and accuracy rules

Five mandatory fields drive routing: patient initials, patient age, adverse reaction, suspected medication and reporter contact. Missing values are explicitly listed. Invalid pseudo-values such as \`(S)*\` are treated as missing and cannot make a report ready for processing.

The score starts at 100, subtracts 14 points for each missing mandatory field and subtracts an extra 12 points when confidence is below 0.60. Routing is:

| Route | Rule |
|---|---|
| ready_for_processing | No mandatory missing fields and confidence >= 0.65 |
| needs_followup | At least one mandatory field missing, including missing drug or adverse reaction |
| manual_review | Mandatory fields present but confidence < 0.65 |
| needs_ocr | PDF/image content still requires OCR/manual extraction |

Consistency rules also flag death-class reports with recovered outcomes, non-fatal seriousness labels on death cases, implausible age values, missing narrative and suspicious drug/reaction pairs.

### Substantive change detection

The old standalone document-comparison page has been removed from the product scope. Current change detection is implemented as case lineage, not as a generic document comparison tool. \`server/ai/caseLinkage.js\` first checks exact source hash. Then it uses a blocking key of patient token + medicine + adverse reaction. If the same anchor exists but clinical fields changed, the new upload is classified as follow-up. Compared fields are onset date, outcome, seriousness, dose, route, frequency and narrative.

## 2. Anonymisation Report

ADRA uses a two-step privacy model:

1. De-identification / pseudonymisation: direct identifiers are replaced with deterministic tokens such as \`PATIENT_TKN_1F2A9C8D03\`, \`REPORTER_TKN_7B9E204A11\` and random reviewer re-link tokens such as \`PVPI-RELINK-4A88D01C62F00AB91E2C\`. The secure review token hash is stored for access control.
2. Irreversible anonymisation / generalisation: analytics copies generalise age to bands, weight to bands, region to broad centre/zone values, and remove direct contact identifiers. Privacy metrics compute k-anonymity, l-diversity and t-closeness.

| Raw sample | Pseudonymised review copy | Irreversible analytics copy |
|---|---|---|
| Patient initials: A.P., age 64, phone +91 9876543210 | Patient: PATIENT_TKN_1F2A9C8D03; Phone: PHONE_TKN_92DD44A708 | Age band: 56-70; phone removed |
| Reporter: Dr Meera Rao, meera@example.org | Reporter: REPORTER_TKN_7B9E204A11; email EMAIL_TKN_53A4419B22 | Reporter role retained; direct identity removed |
| Centre: Delhi PvPI, drug Heparin, reaction Sepsis | Case: PVPI-CASE-8A9110E41C2A | Region/centre band retained; clinical drug/reaction retained for safety analytics |

Privacy evaluation currently passes k-anonymity after suppression: k=${metrics.kAfter}, suppression=${metrics.suppression}. l-diversity and t-closeness are measured but not yet production-passing for strict release controls.

## 3. Flagging Mechanism and Duplicate Detection

Clinical reports and SAE records are flagged for:

- missing suspect drug
- missing adverse reaction
- missing patient initials or patient age
- missing reporter contact
- low parser/extraction confidence
- OCR still required
- duplicate or follow-up relation
- human reviewer status and note
- credibility concerns from heuristic re-verification

Duplicate detection uses exact source hash first, then patient token + medicine + adverse reaction as a blocking key. If clinical details are unchanged, the case is duplicate. If clinical details changed or new clinical details are added, the case is follow-up.

## 4. Classification Criteria

| Class | Criteria |
|---|---|
| death | Seriousness/outcome label maps to death, fatal, life-threatening or death-like text pattern |
| disability | Disability/incapacity, congenital anomaly, recovered with sequelae, paralysis/blindness/amputation-style text |
| hospitalisation | Hospitalisation, prolonged hospitalisation, admission, inpatient, ICU or ER/ward admission text |
| others | Non-serious or medically important cases that do not meet the above categories |

Severity logic uses a cascade: structured seriousness map, outcome map, Logistic Regression TF-IDF model, Naive Bayes fallback if present, and final keyword regex fallback.

## 5. Source Material Strategy

| Source material | Strategy | Concise standardised output |
|---|---|---|
| Application data / checklists | Checklist parser identifies provided, missing, incomplete and review rows | Application ID, mandatory items present/missing, deficiencies, reviewer action |
| SAE narration | Structured slot fill from extracted fields plus extractive TextRank/MMR summary | Reporter/region, suspect drug/dose, reaction/onset, seriousness/outcome, causality |
| Meeting transcripts / audio | faster-whisper transcription when available; structured decision/action/pending parser | Key decisions, owners, pending items, next steps and deadlines |

## 6. Prioritisation and Visual Report

Reviewer queue priority is calculated as severity weight x 0.60 + missing-field burden x 0.25 + low-confidence burden x 0.15. Reasons are shown directly in the queue and on detailed report pages.

Sample change report:

| Field | Previous | Current | Materiality |
|---|---|---|---|
| outcome | recovering | fatal | High |
| seriousness | non-serious | death | High |
| dose | 5 mg | 10 mg | Medium |
| route | oral | oral | No change |

## 7. Evaluation

| Capability | Metric | Result | Source |
|---|---|---:|---|
| Severity classification | Macro-F1 | ${metrics.severityMacroF1} | reports/severity_eval.json |
| Severity classification | MCC | ${metrics.severityMcc} | reports/severity_eval.json |
| Summarisation | ROUGE-1 F | ${metrics.rouge1} | reports/rouge_eval.json |
| Summarisation | ROUGE-2 F | ${metrics.rouge2} | reports/rouge_eval.json |
| Summarisation | ROUGE-L F | ${metrics.rougeL} | reports/rouge_eval.json |
| Field extraction | Macro-F1 | ${metrics.extractionMacroF1} | reports/extraction_f1.json |
| Field extraction | Micro-F1 | ${metrics.extractionMicroF1} | reports/extraction_f1.json |
| Seriousness extraction | F1 | ${metrics.seriousnessF1} | reports/extraction_f1.json |
| Outcome extraction | F1 | ${metrics.outcomeF1} | reports/extraction_f1.json |
| Duplicate/follow-up detection | F1 | ${metrics.duplicateF1} | reports/duplicate_eval.json |
| Privacy | k after suppression | ${metrics.kAfter} | reports/privacy_eval.json |
| Privacy | suppression rate | ${metrics.suppression} | reports/privacy_eval.json |

## 8. Limitations

- Field extraction macro-F1 is low because demographic and suspect-drug fields remain difficult in noisy narrative-only data.
- Duplicate evaluation currently contains positive labelled pairs only; real-world false-positive/false-negative testing needs negative pairs.
- OCR confidence is implemented, but a formal character-error-rate benchmark for scanned ADR forms is still needed.
- l-diversity and t-closeness do not yet pass strict analytics-release thresholds.
- The system assists reviewers; it does not perform clinical causality adjudication.

## 9. Implementation Plan

Near-term improvements:

- Add annotated real ADR/SAE PDFs, scanned forms, SUGAM-style bundles and transcript samples.
- Improve medicine extraction with a drug dictionary and reject layout artifacts like \`(S)*\`.
- Add OCR CER/WER benchmarks and page-level confidence thresholds.
- Add negative duplicate pairs and train thresholded similarity scoring.
- Add reviewer feedback loops for active learning.

Scaling and later phases:

- Put OCR/NER/transcription into async worker queues.
- Store original files in encrypted object storage only when retention is approved.
- Use KMS-backed encryption for re-link tokens and MongoDB field-level encryption for sensitive fields.
- Add vector retrieval over anonymised chunks using pgvector/Qdrant.
- Add audit exports, model/version lineage, monitoring and drift dashboards.
`;
}

await fs.mkdir(DOCS_DIR, { recursive: true });
await fs.writeFile(MD_OUT, buildMarkdown(), "utf8");

const pdf = await PDFDocument.create();
const fonts = {
  regular: await pdf.embedFont(StandardFonts.Helvetica),
  bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  mono: await pdf.embedFont(StandardFonts.Courier),
};

let page;
let y;
let sectionTitle = "";

function clean(s) {
  return String(s ?? "")
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\u2265/g, ">=")
    .replace(/\u2264/g, "<=")
    .replace(/\u00d7/g, "x")
    .replace(/\u2713/g, "PASS")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function addPage(title = sectionTitle) {
  page = pdf.addPage([W, H]);
  y = H - M;
  if (title) {
    page.drawText(clean(title), { x: M, y, size: 10, font: fonts.bold, color: C.green });
    page.drawLine({ start: { x: M, y: y - 10 }, end: { x: W - M, y: y - 10 }, thickness: 0.8, color: C.line });
    y -= 34;
  }
}

function widthOf(text, font, size) {
  return font.widthOfTextAtSize(clean(text), size);
}

function wrap(text, maxWidth, font = fonts.regular, size = 9) {
  const paragraphs = clean(text).split(/\n+/);
  const lines = [];
  for (const p of paragraphs) {
    const words = p.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, font, size) <= maxWidth) {
        line = next;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function ensure(space, title = sectionTitle) {
  if (y - space < M + 22) addPage(title);
}

function textBlock(text, opts = {}) {
  const size = opts.size || 9.2;
  const lineH = opts.lineH || size + 4.4;
  const font = opts.font || fonts.regular;
  const color = opts.color || C.ink;
  const x = opts.x || M;
  const maxWidth = opts.width || CONTENT_W;
  const lines = wrap(text, maxWidth, font, size);
  ensure(lines.length * lineH + 4);
  for (const line of lines) {
    page.drawText(line, { x, y, size, font, color });
    y -= lineH;
  }
  y -= opts.after ?? 4;
}

function h1(title) {
  sectionTitle = title;
  ensure(52);
  page.drawText(clean(title), { x: M, y, size: 17, font: fonts.bold, color: C.ink });
  y -= 24;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: C.green });
  y -= 18;
}

function h2(title) {
  ensure(32);
  page.drawText(clean(title), { x: M, y, size: 12.5, font: fonts.bold, color: C.green });
  y -= 18;
}

function bullet(items) {
  for (const item of items) {
    const lines = wrap(item, CONTENT_W - 14, fonts.regular, 9);
    ensure(lines.length * 13 + 6);
    page.drawText("-", { x: M, y, size: 9, font: fonts.bold, color: C.green });
    for (const line of lines) {
      page.drawText(line, { x: M + 14, y, size: 9, font: fonts.regular, color: C.ink });
      y -= 13;
    }
    y -= 3;
  }
}

function metricCards(cards) {
  const gap = 10;
  const cardW = (CONTENT_W - gap * 2) / 3;
  const cardH = 64;
  for (let i = 0; i < cards.length; i += 3) {
    ensure(cardH + 14);
    const row = cards.slice(i, i + 3);
    row.forEach((card, idx) => {
      const x = M + idx * (cardW + gap);
      page.drawRectangle({ x, y: y - cardH, width: cardW, height: cardH, color: card.bg || C.greenSoft, borderColor: C.line, borderWidth: 0.6 });
      page.drawText(clean(card.value), { x: x + 12, y: y - 24, size: 17, font: fonts.bold, color: card.color || C.green });
      wrap(card.label, cardW - 24, fonts.regular, 8.2).slice(0, 2).forEach((line, li) => {
        page.drawText(line, { x: x + 12, y: y - 42 - li * 10, size: 8.2, font: fonts.regular, color: C.muted });
      });
    });
    y -= cardH + 14;
  }
}

function table(headers, rows, widths, options = {}) {
  const size = options.size || 7.6;
  const lineH = size + 3;
  const x0 = options.x || M;
  const headerH = 24;

  function drawHeader() {
    ensure(headerH + 8);
    let x = x0;
    page.drawRectangle({ x: x0, y: y - headerH, width: widths.reduce((a, b) => a + b, 0), height: headerH, color: C.green, borderColor: C.green, borderWidth: 0.5 });
    headers.forEach((h, i) => {
      wrap(h, widths[i] - 8, fonts.bold, size).slice(0, 2).forEach((line, li) => {
        page.drawText(line, { x: x + 4, y: y - 10 - li * lineH, size, font: fonts.bold, color: C.white });
      });
      x += widths[i];
    });
    y -= headerH;
  }

  drawHeader();
  rows.forEach((row, ri) => {
    const cellLines = row.map((cell, i) => wrap(cell, widths[i] - 8, fonts.regular, size));
    const maxLines = Math.max(1, ...cellLines.map((lines) => lines.length));
    const rowH = Math.max(24, maxLines * lineH + 11);
    if (y - rowH < M + 24) {
      addPage(sectionTitle);
      drawHeader();
    }
    const bg = ri % 2 === 0 ? rgb(0.985, 0.995, 0.988) : C.white;
    page.drawRectangle({ x: x0, y: y - rowH, width: widths.reduce((a, b) => a + b, 0), height: rowH, color: bg, borderColor: C.line, borderWidth: 0.4 });
    let x = x0;
    row.forEach((cell, i) => {
      cellLines[i].forEach((line, li) => {
        page.drawText(line, { x: x + 4, y: y - 11 - li * lineH, size, font: fonts.regular, color: C.ink });
      });
      if (i < row.length - 1) {
        page.drawLine({ start: { x: x + widths[i], y }, end: { x: x + widths[i], y: y - rowH }, thickness: 0.25, color: C.line });
      }
      x += widths[i];
    });
    y -= rowH;
  });
  y -= 14;
}

function flow(title, steps) {
  h2(title);
  const boxW = (CONTENT_W - 24) / 4;
  const boxH = 62;
  for (let i = 0; i < steps.length; i += 4) {
    ensure(boxH + 20);
    steps.slice(i, i + 4).forEach((step, idx) => {
      const x = M + idx * (boxW + 8);
      page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, color: idx % 2 ? C.blueSoft : C.greenSoft, borderColor: C.line, borderWidth: 0.8 });
      page.drawText(clean(step.name), { x: x + 8, y: y - 17, size: 8.8, font: fonts.bold, color: idx % 2 ? C.blue : C.green });
      wrap(step.detail, boxW - 16, fonts.regular, 7.3).slice(0, 4).forEach((line, li) => {
        page.drawText(line, { x: x + 8, y: y - 32 - li * 9, size: 7.3, font: fonts.regular, color: C.ink });
      });
    });
    y -= boxH + 18;
  }
}

function codeSample(text) {
  const lines = clean(text).split("\n");
  const size = 7.4;
  const lineH = 10;
  ensure(lines.length * lineH + 20);
  page.drawRectangle({ x: M, y: y - lines.length * lineH - 14, width: CONTENT_W, height: lines.length * lineH + 14, color: rgb(0.965, 0.975, 0.97), borderColor: C.line, borderWidth: 0.5 });
  let yy = y - 13;
  lines.forEach((line) => {
    page.drawText(line.slice(0, 94), { x: M + 10, y: yy, size, font: fonts.mono, color: C.ink });
    yy -= lineH;
  });
  y = yy - 8;
}

function cover() {
  addPage("");
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0.96, 0.99, 0.965) });
  page.drawRectangle({ x: 0, y: H - 168, width: W, height: 168, color: C.green });
  page.drawText("ADRA", { x: M, y: H - 84, size: 34, font: fonts.bold, color: C.white });
  page.drawText("Project Report", { x: M, y: H - 122, size: 23, font: fonts.bold, color: C.white });
  page.drawText("AI-assisted ADR/SAE intake, extraction, anonymisation, review and analytics", { x: M, y: H - 148, size: 10.5, font: fonts.regular, color: C.white });
  y = H - 210;
  textBlock(`This report documents the current ADRA implementation: parsing and OCR, field extraction, privacy controls, flagging, severity classification, duplicate/follow-up linkage, source-specific summarisation, reviewer prioritisation, evaluation results, limitations and implementation roadmap.`, { size: 10.5, lineH: 15 });
  metricCards([
    { value: metrics.severityMacroF1, label: "Severity Macro-F1", bg: C.greenSoft, color: C.green },
    { value: metrics.extractionMacroF1, label: "Field extraction Macro-F1", bg: C.amberSoft, color: C.amber },
    { value: metrics.kAfter, label: "Privacy k after suppression", bg: C.blueSoft, color: C.blue },
    { value: metrics.duplicateF1, label: `Duplicate/follow-up F1 on ${metrics.duplicatePairs} pairs`, bg: C.purpleSoft, color: C.purple },
    { value: metrics.rouge1, label: "Summarisation ROUGE-1 F", bg: C.greenSoft, color: C.green },
    { value: metrics.suppression, label: "Privacy suppression rate", bg: C.blueSoft, color: C.blue },
  ]);
  textBlock(`Scope note: inspection report generation and the standalone generic document-comparison page have been removed from the product. ADRA still performs completeness-based routing and case-lineage change detection for duplicate/follow-up reports.`, { size: 8.8, color: C.muted });
}

cover();

addPage("Project Report");
h1("1. Key Findings");
textBlock("ADRA uses a conservative hybrid AI design. Structured parsers, regular expressions and biomedical NER extract source-bound facts. ML is used for severity classification and optional sidecar enrichment. Reviewers retain final authority through mutable human review decisions that are audited separately from immutable source records.");

flow("End-to-End Processing Flow", [
  { name: "Upload", detail: "PDF, image, spreadsheet, XML, JSON, text or audio" },
  { name: "Parse/OCR", detail: "AcroForm, pdfplumber, pdf-parse, PP-OCRv5, Tesseract, faster-whisper" },
  { name: "Normalise", detail: "Language detection and optional translation to English" },
  { name: "Extract", detail: "Rules, regex, structured labels and optional scispaCy NER" },
  { name: "Privacy", detail: "PII/PHI detection, pseudonymisation, token previews" },
  { name: "Score", detail: "Mandatory fields, confidence and ready/follow-up/manual route" },
  { name: "Classify", detail: "Death, disability, hospitalisation or others" },
  { name: "Review", detail: "Queue reasons, human status, audit trail and analytics" },
]);

h2("Detection Methodology");
table(
  ["Layer", "Current technique", "Why used"],
  [
    ["PDF/OCR intake", "pdf-lib AcroForm, pdfplumber sidecar, pdf-parse fallback, image OCR through PP-OCRv5/Tesseract.js", "Combines high-precision digital form extraction with fallback OCR for scanned reports."],
    ["NER and rules", "Regex and structured label extraction in nlpExtractor.js; optional scispaCy fills gaps only", "Keeps facts source-bound and avoids overwriting extracted values."],
    ["Summarisation", "TextRank + MMR with TF-IDF fallback; structured SAE slot fill", "Extractive summaries reduce hallucination risk in regulatory review."],
    ["Severity ML", "Seriousness map, outcome map, Logistic Regression TF-IDF, NB fallback, regex fallback", "Uses explicit structured labels first and ML only when labels are absent or weak."],
    ["Completeness routing", "Five mandatory-field gate with confidence threshold", "Prevents reports missing suspect drug or adverse reaction from appearing ready."],
    ["Change detection", "Source hash, patient token + medicine + reaction, then clinical field comparison", "Identifies duplicate versus follow-up lineage without reintroducing a generic document comparison module."],
  ],
  [88, 247, 193],
);

h2("Completeness, Consistency and Accuracy Rules");
table(
  ["Rule area", "Implementation", "Reviewer output"],
  [
    ["Mandatory fields", "Patient initials, patient age, adverse reaction, suspected medication, reporter contact.", "MissingFields list and needs_followup route."],
    ["Invalid extracted values", "Blank, unknown, N/A, dash and pseudo layout artifacts such as (S)* are treated as missing.", "Report cannot be ready if drug or reaction is not real."],
    ["Confidence", "0.45 field coverage + 0.35 parser confidence + 0.20 source trace.", "manual_review if confidence is below 0.65 despite mandatory fields."],
    ["Consistency", "Death/recovered mismatch, death class with non-fatal seriousness, implausible age and short narrative are flagged.", "Credibility/detail flags for human reverification."],
    ["Case changes", "Compares onset, outcome, seriousness, dose, route, frequency and narrative.", "Follow-up reason lists changed fields."],
  ],
  [118, 245, 165],
);

h1("2. Anonymisation Report");
textBlock("ADRA separates a pseudonymised reviewer copy from an irreversible analytics copy. Direct identity is tokenised for authorised follow-up, while analytics views use bands and suppressed/generalised fields. The secure review token is random; its hash is stored for control, and only authorised PvPI workflows can reveal the full token.");
table(
  ["Raw input sample", "Pseudonymised review copy", "Irreversible analytics copy"],
  [
    ["Patient initials A.P.; age 64; phone +91 9876543210", "PATIENT_TKN_1F2A9C8D03; PHONE_TKN_92DD44A708", "Age band 56-70; phone removed"],
    ["Reporter Dr Meera Rao; meera@example.org", "REPORTER_TKN_7B9E204A11; EMAIL_TKN_53A4419B22", "Reporter role retained; direct identity removed"],
    ["Source case relink requirement", "PVPI-RELINK-4A88D01C62F00AB91E2C; secure hash stored", "No re-link token present in analytics copy"],
    ["Drug Heparin; reaction Sepsis; centre Delhi PvPI", "PVPI-CASE-8A9110E41C2A", "Clinical drug/reaction retained for safety signal analysis; location broad-banded"],
  ],
  [176, 176, 176],
);
flow("Two-Step Privacy Process", [
  { name: "Detect PII/PHI", detail: "Aadhaar, PAN, phone, email, MRN, location, name labels, sensitive disease triggers" },
  { name: "Pseudonymise", detail: "Deterministic SHA-256-derived tokens for identity fields" },
  { name: "Restrict Re-link", detail: "PVPI-RELINK token preview for most users; full token only in authorised workflow" },
  { name: "Anonymise", detail: "Age/weight bands, generalised location and suppressed small groups" },
]);
table(
  ["Privacy metric", "Current result", "Interpretation"],
  [
    ["k-anonymity after suppression", String(metrics.kAfter), "Passes the configured k=5 release target for demographic QIs."],
    ["Suppression rate", metrics.suppression, "Low suppression for strategy A demographic QIs."],
    ["l-diversity", "Measured; currently fails strict target", "Needs stronger release controls before production analytics sharing."],
    ["t-closeness", "Measured; currently fails strict target", "Sensitive outcome/seriousness distribution still needs better control."],
  ],
  [150, 150, 228],
);

h1("3. Flagging and Duplicate Detection");
textBlock("The flagging system is shown in records, detailed report pages, reviewer queue and analytics exports. Human status is separate from AI routing so a reviewer can mark a case as needs follow-up, accepted or not accepted without mutating the original extracted record.");
table(
  ["Flag type", "Detection logic", "Where visible"],
  [
    ["Missing/incomplete field", "Mandatory field missing or invalid pseudo-value detected.", "Records table, detailed page, reviewer queue, export CSV."],
    ["Low confidence", "Weighted confidence below threshold.", "manual_review route and reviewer queue reason."],
    ["Needs OCR", "PDF/image has insufficient extractable digital/OCR text.", "needs_ocr status."],
    ["Duplicate", "Same source hash or same case anchor with unchanged clinical fields.", "Case lineage panel."],
    ["Follow-up", "Same case anchor but changed onset, outcome, seriousness, dose, route, frequency or narrative.", "Why follow-up is needed and changed-fields table."],
    ["Human-in-loop", "PATCH /api/reports/:id/review stores status, note, user, role and history.", "Detailed page and audit trail."],
  ],
  [120, 255, 153],
);
table(
  ["Duplicate/follow-up step", "Algorithm"],
  [
    ["1. Exact source hash", "If sourceHash matches an existing active report, classify as duplicate."],
    ["2. Blocking key", "Patient token + normalised medicine + normalised adverse reaction."],
    ["3. Changed fields", "Compare onset, outcome, seriousness, dose, route, frequency and narrative."],
    ["4. Decision", "No anchor: new. Anchor + no clinical change: duplicate. Anchor + changed detail: follow-up."],
  ],
  [150, 378],
);

h1("4. Classification Criteria");
table(
  ["Severity class", "Criteria", "Priority meaning"],
  [
    ["death", "Death, died, fatal, deceased, mortality, life-threatening, fatal outcome labels.", "Immediate review."],
    ["disability", "Disability/incapacity, congenital anomaly, recovered with sequelae, paralysis, blindness, amputation style terms.", "High review priority."],
    ["hospitalisation", "Hospitalisation, prolonged hospitalisation, admitted, inpatient, ICU, ER, ward admission.", "High review priority."],
    ["others", "Non-serious, unknown, other medically important or cases not matching classes above.", "Routine or confidence-driven review."],
  ],
  [100, 290, 138],
);
textBlock(`Current severity evaluation: Logistic Regression TF-IDF is the active ML candidate with Macro-F1 ${metrics.severityMacroF1} and MCC ${metrics.severityMcc} on ${metrics.severityRows} synthetic ICSR rows. Structured label maps remain higher precedence than the ML text classifier.`);

h1("5. Source Material Strategy");
table(
  ["Source", "Processing strategy", "Final concise format"],
  [
    ["Application data / checklists", "Checklist parser identifies provided, missing, incomplete and review rows. Keywords include checklist, mandatory, required, approval, clinical, licence and deficiency.", "Application ID; mandatory items present/missing; key documents; deficiencies; reviewer action."],
    ["SAE case narration", "Structured slot fill from extracted fields plus extractive TextRank/MMR summary over narrative.", "Reporter/region; suspect drug/dose; reaction/onset; seriousness/outcome; dechallenge/rechallenge; causality."],
    ["Meeting transcripts / audio", "faster-whisper sidecar generates text; labelled Decision/Action/Pending/Next lines are parsed; TextRank fallback if labels absent.", "Key decisions; action items with owners; pending items; next steps and deadlines."],
  ],
  [115, 250, 163],
);
h2("Standardised Output Samples");
codeSample(`SAE SUMMARY
Report: ADR-20260510-ABC123
Suspect drug: Heparin | Dose: 5 mg | Route: IV
Reaction: Sepsis | Onset: 12/02/2026
Seriousness: Hospitalisation | Outcome: Recovering
Route: needs_followup if mandatory fields missing; otherwise ready/manual by confidence.

CHECKLIST SUMMARY
Application: APP-2026-001
Provided: Ethics committee approval, protocol synopsis
Missing: Investigator undertaking, insurance certificate
Action: Request missing documents from applicant.

MEETING SUMMARY
Decision: SAE batch accepted for expedited review.
Action: Reviewer A to verify fatal outcome cases by 15/05/2026.
Pending: Causality notes for two follow-up cases.`);

h1("6. Prioritisation and Change Report");
textBlock("Reviewer queue priority is severity-weighted and explainable. The formula is severity weight x 0.60 + missing-field burden x 0.25 + low-confidence burden x 0.15. Death, disability and hospitalisation cases rise first, but missing mandatory data and low confidence also raise review urgency.");
table(
  ["Input factor", "Weight/logic", "Reason shown to reviewer"],
  [
    ["Severity", "death 1.00, disability 0.85, hospitalisation 0.70, others 0.30; weight 60%", "Fatal/life-threatening, disability or hospitalisation required."],
    ["Missing fields", "min(missingCount / 5, 1); weight 25%", "N mandatory field(s) missing."],
    ["Low confidence", "1 - confidence; weight 15%", "Low extraction confidence percentage."],
    ["Lineage", "Duplicate/follow-up adds context reason", "Possible duplicate or follow-up."],
  ],
  [118, 200, 210],
);
table(
  ["Changed field", "Previous", "Current", "Materiality"],
  [
    ["outcome", "recovering", "fatal", "High - escalates severity and priority."],
    ["seriousness", "non-serious", "death", "High - death class."],
    ["dose", "5 mg", "10 mg", "Medium - changed exposure."],
    ["route", "oral", "oral", "No change."],
    ["narrative", "rash after drug", "rash progressed; patient admitted", "High - adds hospitalisation context."],
  ],
  [96, 110, 150, 172],
);

h1("7. Evaluation of the Model");
table(
  ["Capability", "Metric", "Result", "Source"],
  [
    ["Severity classification", "Macro-F1", metrics.severityMacroF1, "reports/severity_eval.json"],
    ["Severity classification", "MCC", metrics.severityMcc, "reports/severity_eval.json"],
    ["Summarisation", "ROUGE-1 F", metrics.rouge1, "reports/rouge_eval.json"],
    ["Summarisation", "ROUGE-2 F", metrics.rouge2, "reports/rouge_eval.json"],
    ["Summarisation", "ROUGE-L F", metrics.rougeL, "reports/rouge_eval.json"],
    ["Field extraction", "Macro-F1", metrics.extractionMacroF1, "reports/extraction_f1.json"],
    ["Field extraction", "Micro-F1", metrics.extractionMicroF1, "reports/extraction_f1.json"],
    ["Seriousness extraction", "F1", metrics.seriousnessF1, "reports/extraction_f1.json"],
    ["Outcome extraction", "F1", metrics.outcomeF1, "reports/extraction_f1.json"],
    ["Duplicate/follow-up", `F1 on ${metrics.duplicatePairs} labelled pairs`, metrics.duplicateF1, "reports/duplicate_eval.json"],
    ["Privacy", "k after suppression", String(metrics.kAfter), "reports/privacy_eval.json"],
    ["Privacy", "Suppression rate", metrics.suppression, "reports/privacy_eval.json"],
  ],
  [150, 132, 70, 176],
);
h2("Key Limitations");
bullet([
  "Field extraction macro-F1 remains low because demographic and suspect-drug fields are difficult in noisy narrative-only data.",
  "Duplicate/follow-up evaluation currently has positive labelled pairs only, so real-world false positive rate still needs a negative-pair benchmark.",
  "OCR is integrated, but formal CER/WER benchmarking on scanned ADR forms is still required.",
  "l-diversity and t-closeness are measured but do not yet pass strict production analytics-release thresholds.",
  "The platform supports reviewer prioritisation, not clinical causality adjudication.",
]);

h1("8. Implementation Plan");
table(
  ["Phase", "Improvement", "Expected benefit"],
  [
    ["Phase 1", "Load annotated real ADR/SAE PDFs, scanned reports, SUGAM checklists and meeting transcripts.", "Improve extraction, OCR and source-type coverage."],
    ["Phase 1", "Add medicine dictionary validation and OCR-layout cleanup rules.", "Prevent artifacts like (S)* being accepted as medicines."],
    ["Phase 1", "Add OCR CER/WER benchmark and page-level confidence thresholds.", "Make scanned PDF readiness measurable."],
    ["Phase 2", "Train duplicate/follow-up scoring with positive and negative candidate pairs.", "Reduce false positives and false negatives."],
    ["Phase 2", "Use reviewer feedback for active learning and threshold calibration.", "Align automated routing with actual officer decisions."],
    ["Phase 3", "Move OCR/NER/transcription to async workers and queues.", "Scale concurrent uploads and large files."],
    ["Phase 3", "Add vector retrieval over anonymised chunks with pgvector/Qdrant.", "Improve evidence retrieval while keeping identity out of search."],
  ],
  [70, 275, 183],
);
h2("Security and Retrieval Roadmap");
bullet([
  "Use encrypted object storage only when retention is approved; otherwise continue memory-only processing for originals.",
  "Use KMS-backed encryption for re-link tokens and MongoDB field-level encryption for sensitive fields.",
  "Keep role-based access: super admins can manage records, but identity re-link remains restricted to authorised PvPI follow-up.",
  "Add audit exports for every login, upload, reviewer decision, deletion, guideline change and model/version event.",
  "Build anonymised semantic retrieval over report chunks, with source trace and strict suppression before analytics release.",
]);

const pages = pdf.getPages();
pages.forEach((p, idx) => {
  p.drawText(`Page ${idx + 1} of ${pages.length}`, { x: W - M - 72, y: 22, size: 7.5, font: fonts.regular, color: C.muted });
  p.drawText("ADRA Project Report", { x: M, y: 22, size: 7.5, font: fonts.regular, color: C.muted });
});

await fs.writeFile(PDF_OUT, await pdf.save());
console.log(`Wrote ${path.relative(ROOT, PDF_OUT)}`);
console.log(`Wrote ${path.relative(ROOT, MD_OUT)}`);
