# ADRA Project Report

**System:** ADRA — AI-Driven Regulatory Workflow Automation  
**Hackathon:** CDSCO-IndiaAI Health Innovation Acceleration Hackathon  
**Stage:** 1 (Virtual, 45 days)  
**Version:** 0.1.0 | **Date:** May 2026

---

## Executive Summary

ADRA is a full-stack pharmacovigilance workflow prototype that integrates all five features specified in the hackathon problem statement. It is a working application — not slides or mockups — with a real MongoDB database, JWT-authenticated APIs, an intake pipeline that processes PDF/CSV/XLSX/JSON/XML reports in memory, 17 dashboard pages, and a verifiable evaluation harness (`npm run evaluate`) that produces all Annexure I classification metrics as a JSON report.

The system enforces a non-negotiable core principle: no AI/ML component may substitute, normalise, or infer clinical facts. Every extracted value is a verbatim source span. Corrections are append-only follow-up records. This principle directly implements the regulatory immutability requirements of CDSCO Schedule Y and NDHM Health Data Management Policy.

---

## Key Findings from Analysis

### a. Detection Methodology

#### PII/PHI Detection (Feature 1)

ADRA uses a hybrid rule-based approach implemented in `server/ai/privacyModel.js`:

**Structured identifiers (high-precision regex):**
- Aadhaar number: `\b\d{4}[\s-]\d{4}[\s-]\d{4}\b`
- PAN card: `\b[A-Z]{5}[0-9]{4}[A-Z]\b`
- MRN / patient ID: contextual keyword + 6–10 digit sequence
- Indian mobile: `\b[6-9]\d{9}\b`
- Email: RFC-compliant pattern
- Date of birth: multiple date format patterns

**Free-text clinical entities (rule heuristics):**
- Named person detection: title + capitalised name sequence (Dr., Mr., Mrs., Prof.)
- Location generalisation: known city/state names from Indian geography
- Hospital/institution: keyword-proximity detection

**Regulation tagging:** Every detected finding is tagged with the applicable regulation clause (DPDP Act 2023, NDHM §4, ICMR Section 4, CDSCO Schedule Y) to provide compliance traceability.

**Two-step anonymisation:**
1. **Pseudonymisation (de-identification):** Patient initials → `PATIENT-TOKEN-<SHA256-prefix>`, reporter name/email/phone → `REPORTER-TOKEN-<SHA256-prefix>`. Secure review token (`PVPI-RELINK-<20-hex-random>`) generated per report for authorised re-linking.
2. **Irreversible generalisation:** Age → 5-band (Under-18, 18-40, 41-60, 61-70, 71+), weight → 3-band, region → 5-zone (North/South/East/West/Central), medicine → ATC class, reaction → MedDRA SOC, outcome → Fatal/Recovered/Not-recovered, seriousness → 3-class.

**NLP extraction pipeline** (`server/ai/nlpExtractor.js`): Rule/regex extraction of all CDSCO ADR form 1.4 fields across five sections — patient, reporter, PvPI metadata, clinical, source trace.

**Completeness and field coverage** (`server/ai/scoringModel.js`): Five mandatory fields checked; missing fields listed explicitly; processing route assigned (ready / needs_followup / manual_review).

---

#### Document Comparison Algorithm (Feature 3)

Implemented in `server/ai/documentComparison.js`:

1. **Section-aware splitting:** Documents are split on heading patterns (`## Heading`, `SECTION N`, numbered headings). Each section is compared independently.
2. **Sentence-level diff:** Within each section, sentences are compared pairwise by Jaccard token similarity.
3. **Change classification:**
   - Jaccard < 0.30 → **high materiality** (substantive new content or deletion)
   - Jaccard 0.30–0.60 → **medium materiality** (meaningful reword)
   - Jaccard > 0.60 → **cosmetic** (minor wording adjustment)
4. **Output:** JSON change-list with `{ section, type, similarity, materiality, textA, textB }` for every changed sentence pair. Available at `POST /api/compare`.

---

### b. Anonymisation Report

**Sample transformation (from processed ADR Form 35):**

| Field | Raw value | Pseudonymised | Analytics copy |
|---|---|---|---|
| Patient name/initials | F.P. | PATIENT-TOKEN-3A7F… | — |
| Patient age | 69 | 69 (stored internally) | 61-70 (band) |
| Patient gender | Female | Female | Female |
| Reporter name | Dr. Indrajit Gupta | REPORTER-TOKEN-8C2E… | — |
| Reporter email | khalsacharles@example.net | REPORTER-TOKEN-8C2E… | — |
| Reporter phone | 06862110225 | REPORTER-TOKEN-8C2E… | — |
| Medicine | Heparin | Heparin (clinical fact) | Anticoagulant (ATC class) |
| Reaction | Sepsis | Sepsis (clinical fact) | Infections & infestations (SOC) |
| Region/centre | National Coord. Centre | National Coord. Centre | North (zone) |

**Privacy metrics on 2,662-row synthetic dataset (demographic QIs: ageBand, gender, region):**

| Metric | Before suppression | After combined suppression |
|---|---|---|
| k-anonymity | k = 1 | k ≥ 5 ✓ |
| Records released | 2,662 | 2,638 (0.9% suppressed) |
| l-diversity (outcome) | l = 1 ✗ | l ≥ 2 ✓ |
| l-diversity (seriousness) | l = 1 ✗ | l ≥ 2 ✓ |
| t-closeness | measured | measured on released set |

Suppression strategy: k-suppression (remove equivalence classes < 5 records) followed by l-suppression (remove classes where any sensitive attribute has < 2 distinct values). Both steps implemented in `server/ai/privacyMetrics.js`.

---

### c. Flagging Mechanism

**Completeness flags on SAE reports:**

Each report receives one of three route flags based on mandatory field coverage and extraction confidence:

| Route | Condition | Action |
|---|---|---|
| `ready_for_processing` | All 5 mandatory fields present AND confidence ≥ 0.65 | Queue for reviewer |
| `needs_followup` | Any mandatory field missing | Request follow-up from reporter |
| `manual_review` | Fields present but confidence < 0.65 | Route to senior reviewer |

Mandatory fields: Patient initials, Patient age, Adverse reaction, Suspected medication, Reporter contact.

**Missing field flags:** Every report stores an explicit `missingFields` array listing field labels (e.g. `["Patient initials", "Reporter contact"]`) that drive the reviewer queue.

**Duplicate detection methodology:**

1. **Exact match:** Source SHA-256 hash comparison (catches re-submissions of identical files).
2. **Candidate blocking:** Patient token + suspected medication (exact string) + adverse reaction (exact string) match across existing records.
3. **Relation classification:** Matched candidate with no new clinical information → `duplicate`. Matched candidate with new outcome/seriousness/onset/dose/route → `follow-up`. No match → `new`.
4. **Evaluation:** F1 = 1.000 on 462 labelled pairs in synthetic dataset (note: constructed using same blocking keys).

---

### d. Classification Criteria

ADRA classifies every ICSR case into one of four CDSCO canonical severity categories:

| Class | Criteria applied |
|---|---|
| **death** | SAE_Seriousness_Criteria ∈ {Death, Life-threatening} OR Outcome ∈ {Fatal} OR narrative keywords: fatal, died, death, life-threatening |
| **disability** | SAE_Seriousness_Criteria ∈ {Disability/incapacity, Congenital anomaly} OR narrative keywords: disability, incapacity, incapacitated, congenital anomaly |
| **hospitalisation** | SAE_Seriousness_Criteria ∈ {Hospitalisation, Required hospitalisation} OR narrative keywords: hospitalised, admitted, emergency room |
| **others** | All remaining cases (Non-serious, Other medically important, no match above) |

Classification is implemented in `server/ai/severityClassifier.js` using a three-stage pipeline: label-map → outcome-map → keyword regex over narrative. The label-map takes precedence; keyword regex applies only when structured fields are absent.

**Evaluation results (2,662 ICSR rows):**

| Metric | Value |
|---|---|
| Macro-F1 | 0.789 |
| MCC (Matthews Correlation Coefficient) | 0.712 |
| Macro Precision | 0.778 |
| Macro Recall | 0.925 |

Full confusion matrix and per-class breakdown are in `reports/eval-2026-05-07.json`.

**Reviewer prioritisation logic:** Reports are ranked in the reviewer queue by: severity class (death > disability > hospitalisation > others) × seriousness flag × confidence score × missing field count. Signal strength per medicine-reaction pair is computed as: `prevalence × 0.45 + serious_rate × 0.35 + avg_confidence × 0.20`.

---

### e. Three-Source Summarisation Strategy

Implemented in `server/ai/summariser.js`. All three source types share a common TF-IDF pipeline with domain-specific keyword dictionaries and standardised JSON output schemas.

**Source Type 1 — SAE Case Narration:**

Schema slots: Reporter type and region | Suspect drug and dose | Adverse reaction and onset | Seriousness and outcome | Dechallenge/rechallenge | Causality assessment.

Method: Two-stage — (1) structured slot-filling from extracted fields (exact values from source document), (2) TF-IDF extractive summary of the narrative text for free-text sections.

Policy: Every slot is populated from verbatim extracted fields. If a field is missing, the slot reads "Not extracted" rather than inferred text.

**Source Type 2 — SUGAM Application Checklist:**

Schema slots: Application type and identifier | Mandatory fields present/missing | Key supporting documents | Deficiencies flagged | Reviewer action required.

Method: Checklist keyword dictionary (`checklist`, `mandatory`, `required`, `submit`, `approval`, `clinical`, `trial`, `licence`, `schedule`, `annex`) boosts sentences describing checklist items. Top-N sentences extracted preserving document order.

**Source Type 3 — Meeting Transcripts:**

Schema slots: Key decisions | Action items with owners | Pending items | Next steps and deadlines.

Method: Decision/action keyword dictionary (`decision`, `action`, `resolved`, `agreed`, `pending`, `deadline`, `responsible`, `approved`) boosts relevant sentences. Produces a 5-sentence structured summary.

**API endpoint:** `POST /api/summarise { text, sourceType, maxSentences }` — authenticated, returns `{ summary, sentences, sourceType, schema, method, compressionRatio, note }`.

**Evaluation:** Average compression ratio 97% on 100 SAE narratives (avg source length 185 chars). ROUGE-1/2/L and BERTScore can be computed by running `python scripts/evaluate_rouge.py`.

---

### f. Sample Outputs and Visualisations

**Sample SAE structured summary (ADR Form 35 — Heparin/Sepsis):**

```json
{
  "structuredSummary": [
    { "slot": "Reporter type and region", "text": "Reporter: Dr. Indrajit Gupta. Centre: National Coordination Centre." },
    { "slot": "Suspect drug and dose", "text": "Suspect drug: Heparin. Dose: Not extracted. Route: Not extracted." },
    { "slot": "Adverse reaction and onset", "text": "Reaction: Sepsis. Onset: 26/12/2024." },
    { "slot": "Seriousness and outcome", "text": "Seriousness: Death. Outcome: Fatal." },
    { "slot": "Dechallenge/rechallenge", "text": "Dechallenge: Not documented. Rechallenge: Not documented." },
    { "slot": "Causality assessment", "text": "WHO-UMC: Not documented. Narrative available: true." }
  ],
  "method": "structured-slot-fill + extractive-tfidf"
}
```

**Sample document comparison output:**

```json
{
  "sections": [
    {
      "section": "Clinical Data",
      "changes": [
        {
          "type": "modified",
          "similarity": 0.22,
          "materiality": "high",
          "textA": "Patient showed mild hepatotoxicity.",
          "textB": "Patient developed severe hepatic failure requiring ICU admission."
        }
      ]
    }
  ],
  "overallSimilarity": 0.61,
  "changeSummary": { "high": 1, "medium": 2, "cosmetic": 4 }
}
```

---

## Model Evaluation

### Performance Against Annexure I Metrics

| Metric | Required | Current Status |
|---|---|---|
| CER (OCR) | ICDAR 2019 ArT / SROIE | Not measured — OCR engine not yet wired |
| k-anonymity | Public health benchmark | k ≥ 5 after suppression ✓ |
| l-diversity | Public health benchmark | l ≥ 2 after combined suppression ✓ |
| t-closeness | Public health benchmark | Measured on released dataset |
| FUNSD entity F1 | FUNSD benchmark | Not measured — layout pipeline not yet wired |
| ROUGE-1/2/L | CNN/DailyMail or XSum | Run `python scripts/evaluate_rouge.py` |
| BERTScore | CNN/DailyMail or XSum | Run `python scripts/evaluate_rouge.py` |
| Macro-F1 (severity) | Synthetic + held-out | **0.789** ✓ |
| MCC (severity) | Synthetic + held-out | **0.712** ✓ |
| Latency | Per document | Not formally measured; typical < 2s per PDF |

### Key Limitations

1. **Severity classifier is rule-based**, not a trained ML model. Annexure I requires multiple model families compared under cross-validation. This is the highest-priority technical gap.
2. **Disability class precision is 0.261** due to keyword overlap with "others" cases.
3. **OCR not wired**: scanned/image-only PDFs receive `needs_ocr` status. Tesseract 5 is the integration path.
4. **Meeting audio not integrated**: Whisper / faster-whisper is the recommended component.
5. **SUGAM portal not integrated**: API contract is documented; endpoints are mocked for Stage 1.
6. **ROUGE scores require Python**: `pip install rouge-score bert-score openpyxl pandas` then `python scripts/evaluate_rouge.py`.

---

## Implementation Plan

### Suggested Improvements

1. **Train a severity classifier** using the 2,662-row synthetic dataset: TF-IDF + Logistic Regression baseline, gradient-boosted trees (LightGBM), and fine-tuned BioBERT/ClinicalBERT. Compare under stratified 5-fold CV. Report Macro-F1, MCC, and per-class confusion matrix.
2. **Add transformer NER for PII:** Integrate Microsoft Presidio (2025 release includes MedicalNERRecognizer) plus scispaCy `en_ner_bc5cdr_md` for biomedical entity coverage.
3. **Wire Tesseract 5 OCR** via `node-tesseract-ocr` npm package. Measure CER on held-out scanned ADR form fixtures against ICDAR/SROIE conventions.
4. **Implement Whisper** (or faster-whisper) for meeting transcript audio. Add diarisation and decisions/actions extraction.
5. **Produce ROUGE/BERTScore numbers** by running `python scripts/evaluate_rouge.py` on the 100 synthetic SAE narratives.
6. **Implement sentence embedding comparison** in the document comparator to catch semantic paraphrasing (upgrade from Jaccard).
7. **Active learning loop:** Every reviewer correction becomes a labelled training example for the next model iteration, tied to the guideline version in effect at correction time.

### Data Needs

- Annotated ICSR forms in Hindi and regional languages (multilingual extraction gap)
- Real SUGAM application bundle samples for checklist summarisation tuning
- Handwritten inspection note images for TrOCR fine-tuning
- Reviewer correction history for active learning

### Scaling and Security for Later Phases

**Scalability:**
- Replace in-process report processing with BullMQ + Redis async worker queues
- Add MongoDB cursor pagination and server-side aggregation for all dashboard APIs
- Materialise analytics aggregates into separate MongoDB collections
- Add vector store (Qdrant / pgvector) for anonymised RAG chunk retrieval

**Security:**
- Move secure review tokens into a separate encrypted token vault (HashiCorp Vault or KMS-backed MongoDB collection) with per-reveal audit and justification
- Ship audit events to WORM-mode object storage (S3 Object Lock or equivalent) for tamper-evident logging
- Containerise (Docker + Kubernetes / ECS) with private VPC, no public ingress beyond API gateway
- Implement field-level encryption on MongoDB for PII-adjacent fields
- CERT-In aligned logging retention and incident response runbook

**Data governance:**
- DPDP Act 2023 compliance traceability matrix (one row per clause → enforcement point in code)
- NDHM §4 consent audit trail per data access event
- ICMR Section 4 ethical review for any data used in model training

---

## References

- CDSCO PvPI Suspected ADR Reporting Form 1.4
- CDSCO Schedule Y — SAE definitions and reporting requirements
- DPDP Act 2023 (Digital Personal Data Protection Act)
- National Digital Health Mission (NDHM) Health Data Management Policy
- ICMR Ethical Guidelines for Biomedical and Health Research Involving Human Participants
- CERT-In Guidelines on Information Security Practices
- IndiaAI-CDSCO Hackathon Problem Statement and Evaluation Parameters (Annexure I)
