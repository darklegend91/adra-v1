# ADRA — Comprehensive AI Solution Overview

**System:** ADRA — AI-Driven Regulatory Workflow Automation  
**Version:** 0.1.0 · May 2026  
**Deployment:** https://adra-v1.onrender.com (live — full-stack on Render)  
**Context:** CDSCO-IndiaAI Health Innovation Acceleration Hackathon (Stage 1)  
**Domain:** Pharmacovigilance · Regulatory AI · Health Data Governance

---

## 1. Functionality and Features

### 1.1 What ADRA Does

ADRA is a full-stack pharmacovigilance automation platform that ingests, processes, anonymises, classifies, scores, deduplicates, and summarises Adverse Drug Reaction (ADR) and Serious Adverse Event (SAE) reports submitted to CDSCO/PvPI reporting centres. It replaces manual, error-prone paper-based workflows with a structured AI pipeline that routes every report to the correct human reviewer action.

**Live at:** https://adra-v1.onrender.com

### 1.2 Core Features

| Feature | Description | Status |
|---|---|---|
| **Multi-format Report Intake** | PDF, XLSX, CSV, JSON, XML, TXT, image. Batch up to 20 files × 25 MB. Digital PDFs via pdf-parse; spreadsheets via xlsx; images flagged for OCR. | Live |
| **AI Field Extraction** | Rule + regex NLP extracts 14 ADR fields as verbatim source spans with per-field source traces. | Live |
| **PII / PHI Detection** | Aadhaar, PAN, Indian mobile, MRN, email, location, sensitive disease detection. Pseudonymised + analytics copy generated. | Live |
| **Privacy Metrics (k/l/t)** | k-anonymity (k=5 PASS after 2.93% suppression on 2,662 rows), l-diversity, t-closeness computed on analytics copy. | Live |
| **Four-Class Severity Classifier (ML)** | Trained LR model (Macro-F1 0.9623, MCC 0.9500) live in production. Cascade: label-map → outcome-map → LR ML → Naive Bayes → keyword regex. | **ML Active** |
| **Completeness Scoring** | Checks 5 mandatory CDSCO Form 1.4 fields. Routes to ready / needs_followup / manual_review. Score = 100 − missingCount×14. | Live |
| **Duplicate / Follow-Up Detection** | SHA-256 hash + patient token + drug + reaction blocking key. F1 1.000 on 462 labelled pairs. | Live |
| **SAE / Document Summarisation** | TextRank + MMR extractive. Three source types: SAE, SUGAM checklist, meeting. ROUGE-1 0.9401. All output verbatim source spans. | Live |
| **Document Version Comparison** | Section-aware Jaccard diff. Materiality: high / medium / cosmetic. JSON change-list with added/removed sentences. | Live |
| **Reviewer Priority Queue** | severity×0.6 + missing×0.25 + low-confidence×0.15. Tiers: urgent / high / normal / low. Per-record explainability. | Live |
| **OCR Pipeline** | Tesseract.js — text + PII bounding boxes from images. CER formula implemented. | Live |
| **Inspection Report Generation** | CDSCO 8-section template. Critical/Major/Minor deficiency classification via domain regex. | Live |
| **RAG Knowledge Retrieval** | Keyword token-overlap over anonymised ragChunks. Filters by medicine/reaction. | Live |
| **Guideline Versioning** | Editable scoring profiles in MongoDB. Score snapshots reference guideline version. Append-only. | Live |
| **Audit Trail** | AuditEvent collection — login, intake, token access, guideline saves. super_admin access only. | Live |
| **19-Page Analytics Dashboard** | Overview · Intake · Records · Medicine · Pivot · Cohorts · Confidence · AI/ML · Anonymisation · RAG · Guidelines · Queue · Compare · Relations · Inspection · Annexure I · Audit | Live |

---

## 2. Core AI Technologies

| Module | Technology | Role |
|---|---|---|
| **Severity Classifier (ML — Primary)** | TF-IDF + Logistic Regression (scikit-learn, trained, 1,608 features) | Classifies ICARs into 4 canonical classes from MedDRA + narrative when structured labels absent |
| **Severity Classifier (Rule — Tier 1/2)** | Deterministic label-map + outcome-map | High-confidence path when structured seriousness/outcome field is present |
| **Severity Classifier (NB — Tier 3b)** | Naive Bayes (JSON weights, `models/severity_nb.json`) | Secondary ML fallback if LR confidence < 0.55 |
| **Severity Classifier (Regex — Tier 4)** | Keyword patterns (DEATH_RE, DISABILITY_RE, HOSPITALISATION_RE) | Last-resort fallback |
| **Field Extractor** | Rule + regex NLP (14 field patterns) | Pulls patient, reporter, clinical fields from raw text as verbatim spans |
| **SAE Summariser** | TextRank (PageRank on TF-IDF cosine similarity graph) + MMR | Extractive 3-sentence brief from clinical narratives |
| **ROUGE Evaluator (JS)** | Lin (2004) ROUGE-1/2/L + TF-IDF cosine BERTScore proxy | Live evaluation of stored SAE summaries |
| **ROUGE Evaluator (Python)** | rouge-score library | Offline batch evaluation on synthetic dataset |
| **PII/PHI Detector** | Regex + keyword trigger NER | Identifies and tokenises personal and health identifiers |
| **Privacy Engine** | Custom k/l/t (JS + Python) | Measures and enforces privacy guarantees on analytics copy |
| **Duplicate Detector** | SHA-256 hash + blocking key similarity | Two-stage de-duplication with case linkage |
| **Document Comparator** | Jaccard similarity + section-aware heading split | Section-level diff with materiality scoring |
| **Confidence Scorer** | Weighted linear formula | `fieldCoverage×0.45 + parser×0.35 + sourceTrace×0.20` |
| **Priority Queue Scorer** | Weighted multi-signal formula | `severity×0.60 + missing×0.25 + (1−confidence)×0.15` |

---

## 3. Training and Validation Data

### 3.1 Primary Dataset

**File:** `data/ADRA_Synthetic_Evaluation_Dataset.xlsx`

| Sheet | Rows | Purpose |
|---|---|---|
| ADRA_ICSR_Synthetic | **2,662** | Severity ML training, extraction F1, privacy metrics, ROUGE |
| Duplicate_Followup_Pairs | **462** | Duplicate / follow-up detection evaluation |

**Secondary:** `data/CDSCO_AI_Datasets.xlsx` — real-world CDSCO structure reference for field mapping validation.

### 3.2 Data Provenance

Synthetic dataset generated to exactly match **PvPI ADR Reporting Form 1.4** using:
- **MedDRA coding** — PT, LLT, SOC fields per MedDRA hierarchy
- **CDSCO Schedule Y SAE definitions** — 7 canonical seriousness criteria mapped to 4 classes
- **Indian pharmacovigilance context** — drugs from PvPI system, Indian phone/Aadhaar/PAN patterns, regional demographics
- **No real patient records** — zero PHI; all synthetically generated

### 3.3 Dataset Coverage

| Dimension | Coverage |
|---|---|
| Drug classes | Antibacterial, Anticoagulant, Cardiovascular, Analgesic/NSAID, Antidiabetic, CNS, Immunomodulator (30+ drugs) |
| MedDRA SOCs | 12+ system-organ classes |
| Seriousness criteria | All 7 CDSCO Schedule Y categories → 4 canonical classes |
| Demographics | Age 1–90+, both sexes, 10+ Indian regions |
| Outcomes | Recovered, Recovering, Not Recovered, Fatal, Unknown |
| Causality | Certain, Probable, Possible, Unlikely, Unclassified |

### 3.4 Class Distribution (Severity — 2,662 rows)

| Class | Count | Proportion |
|---|---|---|
| death | 299 | 11.2% |
| disability | 179 | 6.7% |
| hospitalisation | 323 | 12.1% |
| others | 1,861 | 69.9% |

**Imbalance handling:** `class_weight="balanced"` on all trained classifiers. Stratified k-fold preserves class proportions in every fold.

---

## 4. Data Preparation Process and Strategies

### 4.1 Intake Pipeline (4 stages)

```
Stage 1 — File type dispatch (ocrService.js)
  PDF      → pdf-parse  (digital text + metadata)
  XLSX/XLS → xlsx       (row × column grid)
  CSV      → delimiter parser
  JSON/XML → structural flattening
  Image    → Tesseract.js OCR → text + bounding boxes

Stage 2 — ADR field extraction (nlpExtractor.js)
  14 fields via rule/regex cascade
  All values stored as verbatim source spans
  Per-field source trace: {field, value, source, confidence}

Stage 3 — Tokenisation and banding (textUtils.js + privacyModel.js)
  Patient initials → SHA-256(salt + initials) → PATIENT-TOKEN-xxxx
  Reporter contact → SHA-256(salt + contact) → REPORTER-TOKEN-xxxx
  Age → band  (<18 · 18-29 · 30-44 · 45-59 · 60-74 · 75+)
  Region → zone  (North · South · East · West · Other India)
  Drug → ATC class
  Reaction → MedDRA SOC
  Outcome → generalised category
  Seriousness → 4-class canonical label

Stage 4 — Privacy suppression (privacyMetrics.js)
  k-suppression: remove equivalence classes with k < 5
  l-suppression: remove classes with l < 2 on sensitive attribute
  Result: 78 records suppressed (2.93%) from 2,662 synthetic rows
```

### 4.2 ML Training Data Preparation (Python)

```python
# Features: clinical content only — NO seriousness label (prevents leakage)
def build_text(row):
    return " ".join([
        MedDRA_PT, MedDRA_SOC, MedDRA_LLT,
        Outcome,
        Narrative[:400],   # first 400 chars
        Suspect_Drug,
        Causality_Assessment
    ])

# Label mapping: 7 CDSCO criteria → 4 canonical classes
SERIOUSNESS_MAP = {
    "Death": "death", "Life-threatening": "death",
    "Disability/incapacity": "disability", "Congenital anomaly": "disability",
    "Hospitalisation": "hospitalisation", "Required hospitalisation": "hospitalisation",
    "Other medically important": "others", "Non-serious": "others",
}

# Class balancing + stratified CV
class_weight = "balanced"
cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
```

---

## 5. AI/ML Technology Selection, Training, Hyperparameter Tuning, and Refinement

### 5.1 Technology Selection Rationale

| Decision | Choice | Rationale |
|---|---|---|
| ML language | Python (scikit-learn) | Rich ML ecosystem; ROUGE/privacy evaluation libraries |
| Production inference | JavaScript (lrClassifier.js) | Weights exported to JSON; no Python runtime needed at inference |
| Severity classifier | TF-IDF + LR | Outperformed RF and GB on 5-fold CV; sparse high-dim text suits linear models |
| Summariser | TextRank + MMR | No-fabrication guarantee; deterministic; ROUGE 0.940 |
| PII detector | Rule/regex | High precision on structured Indian identifiers |
| Privacy metrics | Custom k/l/t | Full control over QI definition and health-data thresholds |
| Document comparison | Jaccard similarity | Lightweight; section-aware; tunable materiality threshold |
| Database | MongoDB Atlas | Schema-flexible; geographically distributed; audit collection support |

### 5.2 Three-Model Comparison (Stratified 5-Fold CV)

| Model | Macro-F1 | MCC | Notes |
|---|---|---|---|
| Gradient Boosting | 0.9528 | 0.9372 | Sequential boosting; strong on imbalanced but slower |
| Random Forest | 0.9608 | 0.9476 | Ensemble; handles feature interactions well |
| **Logistic Regression (selected)** | **0.9623** | **0.9500** | Best — sparse TF-IDF features suit linear classifiers |

### 5.3 Hyperparameters — Logistic Regression + TF-IDF

| Parameter | Value | Rationale |
|---|---|---|
| `ngram_range` | (1, 2) | Captures unigrams ("fatal") and bigrams ("not recovered", "required hospitalisation") |
| `max_features` | 12,000 (CV) / 5,000 (export) | CV: maximum vocabulary; Export: smaller JSON file for JS inference |
| `sublinear_tf` | True | Log-normalised TF reduces high-frequency term dominance |
| `C` | 1.0 | Default regularisation; prevents overfitting on 2,662 rows |
| `max_iter` | 1,000 | Ensures convergence on multi-class problem |
| `class_weight` | balanced | Upweights death (11.2%) and disability (6.7%) minority classes |
| `solver` | lbfgs | Efficient for multi-class L2 regularisation |

### 5.4 Per-Class Results — Best Model (LR)

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| death | 0.956 | 0.947 | 0.951 | 299 |
| disability | 0.941 | 0.978 | 0.959 | 179 |
| hospitalisation | 0.951 | 0.957 | 0.954 | 323 |
| others | 0.987 | 0.984 | 0.986 | 1,861 |
| **Macro** | **0.959** | **0.967** | **0.9623** | **2,662** |

### 5.5 Model Export for JS Production Inference

After training, the LR model is exported to `models/severity_lr.json` (197 KB):
- `vocabulary` — 1,608 TF-IDF feature → index mappings
- `idf` — IDF weights per feature
- `coef` — 4 × 1,608 coefficient matrix
- `intercept` — 4-class intercepts

`server/ai/lrClassifier.js` loads this file at startup and runs inference in pure JavaScript:
1. Tokenise input → build unigrams + bigrams
2. Apply sublinear TF + IDF weights → L2 normalise
3. Dot product with coefficient matrix + intercept → logits
4. Softmax → class probabilities → argmax

**Live startup log:**
```
[SeverityClassifier] LR model loaded — Macro-F1 0.9623, MCC 0.95, 1608 features
```

### 5.6 Summariser Tuning

| Parameter | Value | Effect |
|---|---|---|
| maxSentences | 3 (default) | Matches CNN/DailyMail lead-3 evaluation convention |
| Position weight (1st sentence) | ×2.5 | First sentence states the case |
| Position weight (top 25%) | ×1.5 | Early sentences carry more information |
| Position weight (bottom 25%) | ×0.8 | Late sentences often conclusions/caveats |
| Domain keyword boost | +0.15 per match | 19 pharmacovigilance keywords boosted |
| MMR λ | 0.6 | Balances relevance (60%) vs diversity (40%) |

**ROUGE results (100 synthetic SAE narratives):** ROUGE-1 F 0.9401 · ROUGE-2 F 0.8979 · ROUGE-L F 0.9401

---

## 6. Solution Monitoring and Enhancement

### 6.1 Live Monitoring (Production)

| Mechanism | Implementation |
|---|---|
| Latency tracking | Per-route p50/p95/p99 over rolling 100 requests — `GET /api/health/latency` |
| ML model status | `modelMode: "ml-active"` shown on AI/ML dashboard; startup log confirms LR load |
| Confidence scores | Every report gets 0–1 confidence; < 0.65 routes to manual_review |
| Audit log | AuditEvent MongoDB collection — login, intake, token access, guideline saves |
| Reviewer queue | Priority scores recalculated live on every `/api/reviewer/queue` call |
| Missing field tracking | `missingFields[]` on every report; overview heatmap shows field health |

### 6.2 Evaluation Harness

```bash
# Full Python Annexure I evaluation (runs all 5 scripts)
python scripts/evaluate_all.py --no-bertscore
# → reports/annexure_i.json

# Individual scripts
python scripts/train_severity_classifier.py  # → reports/severity_eval.json
python scripts/evaluate_rouge.py             # → reports/rouge_eval.json
python scripts/evaluate_privacy_metrics.py  # → reports/privacy_eval.json
python scripts/evaluate_extraction_f1.py    # → reports/extraction_f1.json
python scripts/evaluate_duplicates.py       # → reports/duplicate_eval.json

# JavaScript harness
npm run evaluate                             # → reports/eval-YYYY-MM-DD.json
```

### 6.3 Enhancement Roadmap

| Priority | Enhancement | Impact |
|---|---|---|
| A1 | Tesseract 5 / PaddleOCR native OCR | Closes scanned-PDF gap; enables real CER measurement |
| A2 | Microsoft Presidio + scispaCy NER | Transformer-grade PII recall in free-text narratives |
| A3 | Whisper / faster-whisper for meeting audio | Completes Feature 2 (three-source summarisation) |
| A4 | l-generalisation on analytics copy | Achieves l ≥ 2 on real data; closes l-diversity gap |
| B1 | BullMQ + Redis async OCR/NLP workers | 100+ file batch processing without blocking intake |
| B2 | Encrypted token vault (KMS) | Separates secure review tokens; audited reveal workflow |
| B3 | MongoDB aggregation dashboards | 100k+ record analytics without client-side loading |
| C1 | SHAP explanations on LR model | Reviewer-visible feature attribution per prediction |
| C2 | Active learning loop | Reviewer corrections feed next training cycle |

---

## 7. Deployment Architecture

```
Internet
    │
    ▼
Render Web Service (free tier)
https://adra-v1.onrender.com
    │
    ├── Build: npm install && npm run build
    │          (Vite builds client/dist at deploy time)
    │
    ├── Start: node server/index.js
    │
    ├── Express 5 API (22 routes)
    │   ├── Static files: client/dist/ (CSS, JS, HTML)
    │   ├── API routes: /api/*
    │   └── SPA fallback: all non-API routes → index.html
    │
    ├── AI/ML modules (server/ai/)
    │   ├── LR model loaded from models/severity_lr.json
    │   ├── NB model loaded from models/severity_nb.json
    │   └── All 11 AI modules active
    │
    └── MongoDB Atlas
        ├── reports (50 processed records)
        ├── users
        ├── auditevents
        └── guidelineprofiles
```

**Environment variables on Render:**

| Variable | Value |
|---|---|
| NODE_ENV | production |
| MONGODB_URI | MongoDB Atlas connection string |
| MONGODB_DB | adra |
| JWT_SECRET | 64-char random hex |
| JWT_EXPIRES_IN | 8h |
| RENDER_EXTERNAL_URL | Auto-injected by Render |

---

## 8. Solution Replicability Across Multiple Sectors

The five core pipeline layers — intake, extraction, anonymisation, classification, reviewer workflow — are domain-agnostic and re-parameterisable for any regulated document processing domain.

### 8.1 Clinical Trials

| ADRA Component | Adaptation |
|---|---|
| ADR intake pipeline | AE form ingestion (CIOMS, MedWatch, E2B(R3)) |
| Severity classifier | ICH E2A seriousness classification |
| Duplicate detector | Patient-trial-arm deduplication across sites |
| Summariser | Per-patient narrative synopsis for DSMB review |
| Privacy engine | k-anonymity before publication (FDA/EMA submission) |
| Reviewer queue | Expedited 7-day / 15-day / periodic safety report routing |

### 8.2 Insurance Claims

| ADRA Component | Adaptation |
|---|---|
| Intake pipeline | PDF discharge summaries, XLSX hospital bills, image receipts |
| Field extractor | ICD-10 code, procedure code, amount, provider, dates |
| Severity classifier | Claim risk: high-value / complex / routine / possible fraud |
| Duplicate detector | Same patient + provider + diagnosis window |
| Privacy engine | k-anonymity for actuarial sharing |
| Reviewer queue | High-value claims → senior adjudicator; routine → auto-approval |

### 8.3 Legal / Regulatory Filing Review

| ADRA Component | Adaptation |
|---|---|
| Intake pipeline | NDA, CTA, Import Licence, SUGAM bundles |
| Document comparator | Redline diff between successive filing versions |
| Summariser | Per-section executive summary for legal reviewer packages |
| Completeness scorer | Schedule Y / GCP / Schedule M compliance checklist |
| Severity classifier | Deficiency: critical / major / minor / compliant |

### 8.4 Government Grievance Workflow

| ADRA Component | Adaptation |
|---|---|
| Intake pipeline | PDF/handwritten grievance letters |
| Field extractor | Petitioner, complaint category, department, urgency |
| Severity classifier | Urgency: health/safety critical / high / normal / info |
| Duplicate detector | Same petitioner + same issue deduplication |
| Reviewer queue | SLA tracking — acknowledgement 3 days, resolution 30 days |
| Audit trail | RTI (Right to Information) compliance |

### 8.5 Banking / NBFC Compliance Reporting

| ADRA Component | Adaptation |
|---|---|
| Intake pipeline | RBI CRILC, NPA classification, SARFAESI notices |
| Field extractor | Borrower details, loan account, NPA date, classification stage |
| Severity classifier | Risk: fraud / NPA D1-D3 / SMA-0/1/2 / standard |
| Privacy engine | k-anonymity for credit bureau sharing |
| Summariser | Branch-level NPA summary for board packs |

### 8.6 Replicability Principles

1. **Schema-driven extraction** — `nlpExtractor.js` field config is swappable; change the field schema, not the code
2. **Guideline-versioned scoring** — Any regulatory checklist modelled as a versioned `GuidelineProfile` in MongoDB
3. **Canonical 4-class output** — Any severity taxonomy maps to critical/high/normal/low via SERIOUSNESS_MAP pattern
4. **Configurable privacy QIs** — k/l/t QI set is a parameter; any domain specifies its own quasi-identifiers
5. **Immutable audit design** — Append-only records + AuditEvent collection apply directly to any regulated sector

---

## 9. Evaluation Summary (Annexure I Alignment)

| Annexure I Parameter | Metric | Value | Source |
|---|---|---|---|
| Severity classification | Macro-F1 | **0.9623** | train_severity_classifier.py — LR 5-fold CV |
| Severity classification | MCC | **0.9500** | train_severity_classifier.py |
| Summarisation | ROUGE-1 F | **0.9401** | evaluate_rouge.py — 100 synthetic SAE narratives |
| Summarisation | ROUGE-2 F | **0.8979** | evaluate_rouge.py |
| Summarisation | ROUGE-L F | **0.9401** | evaluate_rouge.py |
| Privacy (k-anonymity) | k after suppression | **5 (PASS)** | evaluate_privacy_metrics.py |
| Privacy (suppression) | Records removed | **78 / 2.93%** | evaluate_privacy_metrics.py |
| Field extraction | Seriousness F1 | **0.993** | evaluate_extraction_f1.py |
| Field extraction | Outcome F1 | **0.833** | evaluate_extraction_f1.py |
| Duplicate detection | F1 (blocking key) | **1.000** | evaluate_duplicates.py — 462 labelled pairs |
| OCR | CER | Engine active | server/ai/tesseractService.js — upload scanned form |
| Latency | p50/p95/p99 | Live | GET /api/health/latency |

**Run all:** `python scripts/evaluate_all.py --no-bertscore` → `reports/annexure_i.json`

---

*ADRA v0.1.0 · Live at https://adra-v1.onrender.com · May 2026*
