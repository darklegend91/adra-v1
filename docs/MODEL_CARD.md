# ADRA Model Card

**System:** ADRA — AI-Driven Regulatory Workflow Automation  
**Version:** 0.1.0 · May 2026  
**Context:** CDSCO-IndiaAI Health Innovation Acceleration Hackathon (Stage 1)  
**Deployment:** https://adra-v1.onrender.com (live — full-stack on Render)  
**Author:** Aditya Pathania

---

## 1. System Overview

ADRA is a pharmacovigilance workflow automation platform that processes Adverse Drug Reaction (ADR) and Serious Adverse Event (SAE) reports submitted to CDSCO/PvPI. It applies a pipeline of rule-based, algorithm-based, and trained ML components to anonymise, classify, score, deduplicate, and summarise reports for regulatory reviewer consumption across 22 live REST APIs.

**Intended use:** Internal regulatory review at CDSCO/PvPI reporting centres. Assists human reviewers — does not replace them.

**Out-of-scope:** Diagnosing patients, replacing pharmacovigilance reviewers, generating or modifying clinical facts, autonomous regulatory decisions.

**Core policy:** ADRA stores report facts exactly as extracted from source documents. No AI/ML component may substitute, normalise, or infer clinical values. Reviewer-approved corrections are append-only follow-up records.

---

## 2. Models

### 2.1 CDSCO Four-Class Severity Classifier — Production ML (Live)

| Field | Value |
|---|---|
| **Status** | **Live in production** at https://adra-v1.onrender.com |
| Task | Classify ICSR cases into death / disability / hospitalisation / others |
| Architecture | 4-tier cascade (see below) |
| Primary ML model | TF-IDF + Logistic Regression (trained, weights loaded at startup) |
| Model file | `models/severity_lr.json` (197 KB, 1,608 features) |
| Training data | ADRA_Synthetic_Evaluation_Dataset.xlsx — 2,662 ICSR rows |
| Features used | MedDRA PT + SOC + LLT + Outcome + Narrative (400 chars) + Suspect Drug + Causality |
| Features excluded | `SAE_Seriousness_Criteria` — excluded to prevent label leakage |
| Evaluation method | Stratified 5-fold cross-validation |
| **CV Macro-F1** | **0.9623** |
| **CV MCC** | **0.9500** |
| Training script | `python scripts/train_severity_classifier.py` |

**Production cascade (severityClassifier.js):**

| Tier | Method | Fires when | Confidence |
|---|---|---|---|
| 1 | Seriousness label-map | Structured seriousness field present | 0.95 |
| 2 | Outcome label-map | Seriousness blank, outcome clear (Fatal/Died) | 0.90 |
| 3a | **LR ML model (live)** | Structured labels absent or map to "others" | 0.55–0.99 |
| 3b | Naive Bayes (JSON) | LR confidence < 0.55 | 0.60+ |
| 4 | Keyword regex | All ML tiers inconclusive | 0.78–0.82 |

**Three-model comparison (stratified 5-fold CV, no label leakage):**

| Model | Macro-F1 | MCC |
|---|---|---|
| Gradient Boosting | 0.9528 | 0.9372 |
| Random Forest | 0.9608 | 0.9476 |
| **Logistic Regression (selected)** | **0.9623** | **0.9500** |

**Per-class results — Logistic Regression:**

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| death | 0.956 | 0.947 | 0.951 | 299 |
| disability | 0.941 | 0.978 | 0.959 | 179 |
| hospitalisation | 0.951 | 0.957 | 0.954 | 323 |
| others | 0.987 | 0.984 | 0.986 | 1,861 |
| **Macro** | **0.959** | **0.967** | **0.9623** | **2,662** |

**Class distribution:** others 69.9%, hospitalisation 12.1%, death 11.2%, disability 6.7%  
**Imbalance handling:** `class_weight="balanced"` on all classifiers.

**Live startup confirmation:**
```
[SeverityClassifier] LR model loaded — Macro-F1 0.9623, MCC 0.95, 1608 features
[SeverityClassifier] NB model loaded (fallback)
```

---

### 2.2 CDSCO Four-Class Severity Classifier — Rule Baseline

| Field | Value |
|---|---|
| Method | Deterministic label-map → outcome-map → keyword regex |
| Macro-F1 | 0.789 |
| MCC | 0.712 |
| Role | Production Tier 1 and Tier 2 (highest confidence path) |
| Evaluation | `npm run evaluate` → `reports/eval-YYYY-MM-DD.json` |

---

### 2.3 Completeness Routing Classifier

| Field | Value |
|---|---|
| Task | Route reports to ready_for_processing / needs_followup / manual_review |
| Method | Deterministic: missing mandatory field count + confidence threshold |
| Mandatory fields | Patient initials, age, adverse reaction, suspected medication, reporter contact |
| Routing rule | 0 missing AND confidence ≥ 0.65 → ready; missing > 0 → needs_followup; else → manual_review |
| Accuracy | 1.000 on synthetic dataset (rules match dataset generation) |
| Score formula | `100 − (missingCount × 14) − (confidence < 0.60 ? 12 : 0)` |

---

### 2.4 Duplicate / Follow-Up Detector

| Field | Value |
|---|---|
| Task | Classify incoming report as new / duplicate / follow-up |
| Stage 1 | SHA-256 source hash (exact match) — Precision 1.000, Recall 0.429, F1 0.600 |
| Stage 2 | Blocking key: patient token + suspect drug + MedDRA PT — Precision 1.000, Recall 1.000, F1 1.000 |
| Combined F1 | 1.000 on 462 labelled pairs |
| Evaluation script | `python scripts/evaluate_duplicates.py` → `reports/duplicate_eval.json` |
| Limitation | Synthetic pairs constructed using same blocking key; real-world precision will vary |

---

### 2.5 Confidence Scorer

| Field | Value |
|---|---|
| Task | Assign extraction confidence to each processed report |
| Formula | `fieldCoverage × 0.45 + parserConfidence × 0.35 + sourceTrace × 0.20` |
| Parser defaults | Digital PDF = 0.72, XLSX = 0.78, needs_ocr = 0.25 |
| Range | 0.0 – 1.0 |
| Not a clinical score | Does not measure causality or outcome certainty |

---

### 2.6 TextRank + MMR Extractive Summariser

| Field | Value |
|---|---|
| Task | Concise structured summary for SAE narrations, SUGAM checklists, meeting transcripts |
| Algorithm | TextRank (Mihalcea & Tarau 2004) + Maximal Marginal Relevance diversity selection |
| Fallback | TF-IDF sentence scoring for short documents (< 6 sentences) |
| Source types | sae / checklist / meeting |
| Policy | All output sentences are verbatim source spans — no facts generated or paraphrased |
| ROUGE-1 F | **0.9401** |
| ROUGE-2 F | **0.8979** |
| ROUGE-L F | **0.9401** |
| Evaluation | 100 synthetic SAE narratives, lead-3 reference proxy (CNN/DailyMail convention) |
| Evaluation script | `python scripts/evaluate_rouge.py` → `reports/rouge_eval.json` |

---

### 2.7 PII / PHI Detector

| Field | Value |
|---|---|
| Task | Detect and tokenise personally identifiable and protected health information |
| Method | Rule/regex hybrid |
| Patterns | Aadhaar (12-digit), PAN (XXXXX1234X), Indian mobile (prefix 6–9, 10 digits), MRN/UHID, email, location keywords, sensitive disease keywords |
| Regulations tagged | DPDP Act 2023, NDHM Health Data Management Policy, ICMR Ethical Guidelines, CDSCO Schedule Y |
| Output | Pseudonymised copy (SHA-256 tokens) + analytics copy (banded/generalised) |
| Extraction F1 (soft) | Seriousness F1 **0.993** · Outcome F1 **0.833** · Adverse reaction F1 **0.520** |
| Evaluation script | `python scripts/evaluate_extraction_f1.py` → `reports/extraction_f1.json` |
| Known gap | No transformer NER for free-text narratives; Presidio + scispaCy is the upgrade path |

---

### 2.8 Document Version Comparator

| Field | Value |
|---|---|
| Task | Identify substantive vs cosmetic changes between two document versions |
| Method | Section-aware heading split + sentence-level Jaccard similarity |
| Materiality | high (Jaccard < 0.60) / medium (0.60–0.85) / cosmetic (> 0.85) |
| Output | JSON change-list: section, type, similarity, materiality, added/removed sentences |
| Live endpoint | `POST /api/compare` |

---

### 2.9 ROUGE Evaluator (Pure JavaScript)

| Field | Value |
|---|---|
| Task | Live evaluation of SAE summaries stored in MongoDB |
| Metrics | ROUGE-1 (unigram), ROUGE-2 (bigram), ROUGE-L (LCS), BERTScore proxy (TF-IDF cosine) |
| Algorithm | Lin (2004) — exact n-gram F1 + O(mn) LCS dynamic programming |
| Live result (50 stored reports) | ROUGE-1 F1: **0.4775** · ROUGE-2 F1: **0.4566** · ROUGE-L F1: **0.4775** |
| Python result (100 synthetic) | ROUGE-1 F1: **0.9401** · ROUGE-2 F1: **0.8979** · ROUGE-L F1: **0.9401** |
| Note | JS evaluates real OCR fixture reports (noisier text); Python evaluates clean synthetic narratives |
| Live endpoint | `GET /api/evaluate/rouge` |

---

### 2.10 Privacy Metrics Engine

| Field | Value |
|---|---|
| Task | Measure k-anonymity, l-diversity, t-closeness on the analytics copy |
| Quasi-identifiers (Strategy A) | ageBand + gender + region |
| Sensitive attributes | outcome, seriousness |
| Method | k-suppression → l-suppression → t-closeness on released data |
| **k after suppression (2,662 rows)** | **5 (PASS — target ≥ 5)** |
| Records suppressed | 78 / 2,662 (2.93%) |
| l-diversity | l = 1 (synthetic data regularity — l-generalisation recommended before production) |
| t-closeness (outcome) | 0.4914 (health-data threshold 0.35 — FAIL on synthetic; expected to improve on real data) |
| Evaluation script | `python scripts/evaluate_privacy_metrics.py` → `reports/privacy_eval.json` |

---

### 2.11 Reviewer Priority Queue

| Field | Value |
|---|---|
| Task | Score and tier every report for reviewer triage |
| Formula | `severity × 0.60 + min(missingFields/5, 1) × 0.25 + (1 − confidence) × 0.15` |
| Severity weights | death = 1.0 · disability = 0.85 · hospitalisation = 0.70 · others = 0.30 |
| Tiers | urgent (≥ 0.75) · high (≥ 0.50) · normal (≥ 0.30) · low (< 0.30) |
| Explainability | Per-report reasons list: which signal raised priority |
| Live endpoint | `GET /api/reviewer/queue` |

---

## 3. Privacy Metrics (Annexure I)

All metrics computed on ADRA_Synthetic_Evaluation_Dataset.xlsx (2,662 ICSR rows) using demographic QIs (Strategy A: ageBand + gender + region).

| Metric | Result | Threshold | Status |
|---|---|---|---|
| k-anonymity (before suppression) | k = 1 | — | — |
| **k-anonymity (after suppression)** | **k = 5** | k ≥ 5 | **PASS** |
| Records suppressed | 78 / 2,662 (2.93%) | — | — |
| l-diversity (outcome) | l = 1 | l ≥ 2 | FAIL* |
| l-diversity (seriousness) | l = 1 | l ≥ 2 | FAIL* |
| t-closeness (outcome) | 0.4914 | ≤ 0.35 (health) | FAIL* |
| t-closeness (seriousness) | 0.5666 | ≤ 0.35 (health) | FAIL* |

*Synthetic dataset assigns highly regular outcome/seriousness distributions within demographic groups by design. Real-world CDSCO data with natural clinical variation is expected to improve l and t values. Recommended fix: l-generalisation (merge outcome categories: Fatal → Serious).

---

## 4. Security Architecture

### 4.1 Authentication and Authorisation

| Control | Implementation |
|---|---|
| Password storage | bcryptjs (salted hash, no plaintext) |
| Session tokens | JWT HS-256, 8h expiry, ≥ 32-char secret |
| Route protection | Bearer token middleware on all `/api/*` routes |
| Role-based access | super_admin (all records) / pvpi_member (own records only) |
| User approval | `approvalStatus` field — pending by default |

### 4.2 Data Security

| Control | Implementation |
|---|---|
| Source file storage | None — file buffers discarded after in-memory parse |
| Source hash | SHA-256 of file content — stored for deduplication only |
| PII at rest | Patient/reporter tokens stored, not raw identifiers |
| Secure review token | 32-byte random hex per report — SHA-256 hash stored, not plaintext |
| Token reveal audit | Every reveal logged to AuditEvent MongoDB collection |
| Input limits | Multer: 25 MB per file, 20 files per request; JSON: 2 MB |

### 4.3 Compliance Traceability

| Regulation | Clause | ADRA Enforcement |
|---|---|---|
| DPDP Act 2023 | §5 — Notice | Signup form + policy text |
| DPDP Act 2023 | §8 — Data quality | Immutable records + completeness scoring |
| DPDP Act 2023 | §8(7) — Erasure | Delete-request workflow (planned) |
| NDHM HDMP | §4.2 — Consent for secondary use | Reviewer-only access; audit on every token reveal |
| ICMR Ethical Guidelines | Section 4 | No patient contact; data from submitted reports only |
| CDSCO Schedule Y | SAE reporting | Mandatory field scoring; 4-class severity classification |
| CERT-In | Audit log retention | AuditEvent collection; WORM sink planned for production |

### 4.4 Pre-Production Security Gaps

1. JWT stored in `localStorage` — XSS-readable. Target: `httpOnly` `sameSite=strict` cookie.
2. Secure review tokens generated in-process — encrypted vault required for production.
3. No rate limiting on `/api/auth/login` — brute-force protection needed.
4. No SSO — DigiLocker / NIC eAuth integration required for CDSCO production deployment.

---

## 5. Responsible AI

| Principle | Implementation |
|---|---|
| Safety | Immutable records; append-only corrections; low-confidence reports routed to manual review |
| Transparency | Source trace on every extracted field; confidence formula documented; model basis shown per prediction |
| Accountability | JWT RBAC; AuditEvent collection; guideline version history |
| Non-discrimination | Severity classifier uses no demographic input; identical logic for all records |
| Privacy | Two-layer anonymisation (pseudonymisation + irreversible); k/l/t metrics measured |
| Human oversight | Every report routes to a human reviewer; AI outputs labelled as advisory; no automated regulatory decision |
| Explainability | Reviewer queue shows priorityScore with per-case reasoning (severity, missing fields, confidence, duplicate flag) |

---

## 6. Training and Evaluation Data

| Dataset | Sheet | Rows | Purpose |
|---|---|---|---|
| ADRA_Synthetic_Evaluation_Dataset.xlsx | ADRA_ICSR_Synthetic | 2,662 | Severity ML training, extraction F1, privacy metrics, ROUGE |
| ADRA_Synthetic_Evaluation_Dataset.xlsx | Duplicate_Followup_Pairs | 462 | Duplicate detection evaluation |
| CDSCO OCR fixtures | — | ~10 PDFs | Integration testing of intake pipeline |

**Data provenance:** Synthetic dataset generated to match PvPI ADR Form 1.4, CDSCO Schedule Y SAE definitions, and MedDRA coding. No real patient records. No PHI.

---

## 7. Deployment

| Component | Platform | URL |
|---|---|---|
| Full-stack (frontend + API) | Render (Node.js) | https://adra-v1.onrender.com |
| Database | MongoDB Atlas | Cluster0 (India region) |
| ML model | Loaded from `models/severity_lr.json` at server startup | — |

**Build command on Render:** `npm install && npm run build`  
**Start command:** `node server/index.js`

---

## 8. Known Limitations

1. **No transformer NER** — PII detection relies on regex; Presidio + scispaCy recommended.
2. **OCR not wired** — Scanned/image PDFs flagged `needs_ocr`; Tesseract 5 integration planned.
3. **l-diversity fails on synthetic data** — Synthetic regularity; l-generalisation needed.
4. **Meeting audio not wired** — Whisper integration planned.
5. **SUGAM checklist ingestion** — Schema defined; no real SUGAM bundle ingestion yet.
6. **Token vault** — Secure tokens generated in-process; encrypted vault required for production.

---

## 9. Evaluation Summary (Annexure I)

| Capability | Metric | Value | Script |
|---|---|---|---|
| Severity classification | Macro-F1 | **0.9623** | train_severity_classifier.py |
| Severity classification | MCC | **0.9500** | train_severity_classifier.py |
| Summarisation | ROUGE-1 F | **0.9401** | evaluate_rouge.py (100 synthetic narratives) |
| Summarisation | ROUGE-2 F | **0.8979** | evaluate_rouge.py |
| Summarisation | ROUGE-L F | **0.9401** | evaluate_rouge.py |
| Privacy | k-anonymity (post-suppression) | **k = 5 PASS** | evaluate_privacy_metrics.py |
| Privacy | Suppression rate | **2.93%** | evaluate_privacy_metrics.py |
| Field extraction | Seriousness F1 | **0.993** | evaluate_extraction_f1.py |
| Field extraction | Outcome F1 | **0.833** | evaluate_extraction_f1.py |
| Duplicate detection | F1 (blocking key) | **1.000** | evaluate_duplicates.py |
| OCR | CER | Engine active; scanned fixtures required | server/ai/tesseractService.js |
| Latency | p50/p95/p99 | Live | GET /api/health/latency |

**Run all evaluations:** `python scripts/evaluate_all.py --no-bertscore`

---

*ADRA v0.1.0 · Deployed May 2026 · https://adra-v1.onrender.com*
