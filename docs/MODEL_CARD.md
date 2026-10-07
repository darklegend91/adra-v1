# ADRA Full Solution Model Card

**System:** ADRA - AI-Driven Regulatory Workflow Automation  
**Version:** 0.1.0  
**Updated:** May 2026  
**Context:** CDSCO-IndiaAI Health Innovation Acceleration Hackathon, Stage 1 prototype  
**Deployment target:** Full-stack MERN application with optional Python ML sidecar  
**Author:** Aditya Pathania

---

## 1. Executive Summary

ADRA is a working pharmacovigilance and regulatory workflow prototype for ADR/SAE report intake, extraction, anonymisation, completeness scoring, duplicate/follow-up linkage, severity classification, reviewer prioritisation, evidence retrieval, summarisation, credibility screening, audit logging, and Annexure I metric reporting.

The solution is designed for regulatory reviewers at CDSCO/PvPI-style reporting centres. It is an assistive decision-support tool, not an autonomous medical or regulatory decision system. Every AI/ML output is advisory and must remain under human reviewer control.

**Submission status:** Good to submit as a working prototype, with transparent partials for field extraction, l-diversity/t-closeness, and production security hardening.

---

## 2. Intended Use

| Item | Description |
|---|---|
| Intended users | CDSCO/PvPI reviewers and pharmacovigilance officers |
| Intended workflow | Process submitted reports, prioritise reviewer queues, identify duplicate/follow-up cases, summarise evidence, and generate evaluation metrics |
| Decision role | Human-in-the-loop advisory support |
| Data scope | ADR/SAE documents, structured files, text notes, and synthetic evaluation data |
| Deployment mode | Node.js/Express API, React frontend, MongoDB, optional Python sidecar on localhost/controlled infrastructure |

## 3. Out-of-Scope Use

ADRA must not be used to:

- Diagnose or treat patients.
- Replace medical judgement or regulatory reviewer approval.
- Autonomously accept, reject, or escalate regulatory cases.
- Infer missing clinical facts that are not present in source documents.
- Rewrite patient, medicine, reaction, seriousness, outcome, or reporter facts as if they were source truth.
- Claim production-grade privacy certification without additional release controls and security review.

---

## 4. Core Safety Policy

ADRA follows a source-trace-first policy.

| Principle | Implementation |
|---|---|
| Source preservation | Extracted facts are stored as found in source documents. |
| No fact invention | ML and sidecar modules may add evidence, confidence, labels, and review hints, but must not overwrite clinical facts. |
| Human oversight | Reviewer queue, flags, credibility grades, and severity labels are advisory. |
| Immutable records | Original processed reports are append-only; corrections are represented as follow-up records. |
| Auditability | Login, intake, review-token reveal, guideline save, and analysis events are auditable through MongoDB `AuditEvent`. |

---

## 5. System Architecture

| Layer | Current implementation |
|---|---|
| Frontend | React 19 + Vite single-page application |
| Backend | Node.js + Express 5 REST API |
| Database | MongoDB through Mongoose models |
| Auth | bcrypt password hashing + JWT bearer tokens + role-scoped access |
| Core processing | `server/reportProcessor.js` orchestrates parse, extraction, sidecar enrichment, privacy, scoring, summary, RAG chunks, and case linkage |
| AI modules | `server/ai/*` for severity, extraction, privacy, scoring, OCR, RAG text chunks, summarisation, and credibility support |
| Optional sidecar | FastAPI service under `python/sidecar` for OCR, NER, language detection, translation, voice, PDF extraction, and credibility support |
| Evaluation | JS and Python scripts under `scripts/`, with generated JSON reports under `reports/` |

## 6. Application Capabilities

| Capability | Status | Main code paths |
|---|---|---|
| ADR/SAE intake | Live | `POST /api/intake/reports`, `server/reportProcessor.js` |
| Fixture intake | Live | `POST /api/intake/fixtures` |
| Role-scoped records | Live | `GET /api/reports` |
| Severity classification | Live | `server/ai/severityClassifier.js`, `server/ai/lrClassifier.js` |
| Completeness scoring | Live | `server/ai/scoringModel.js` |
| Duplicate/follow-up linkage | Live | `server/ai/caseLinkage.js` |
| Privacy detection/anonymisation | Live | `server/ai/privacyModel.js`, `server/ai/privacyMetrics.js` |
| OCR | Live for image endpoint; parser support in intake | `server/ai/tesseractService.js`, `server/ai/ocrService.js`, sidecar OCR |
| Summarisation | Live | `server/ai/summariser.js`, `POST /api/summarise` |
| RAG keyword evidence search | Live | `POST /api/rag/query` |
| Reviewer queue | Live | `GET /api/reviewer/queue` |
| Credibility monitor | Live advisory | `POST /api/credibility/analyze`, `python/sidecar/routes/credibility.py` |
| Annexure I dashboard | Live | `GET /api/evaluate/annexure`, `client/src/App.jsx` Annexure page |
| Audit trail | Live for super_admin | `GET /api/audit` |
| Guideline profiles | Live | `GET/POST /api/guidelines` |

---

## 7. Model and Algorithm Cards

### 7.1 Four-Class SAE Severity Classifier

| Field | Value |
|---|---|
| Task | Classify reports into `death`, `disability`, `hospitalisation`, or `others` |
| Production method | Cascaded classifier: structured label map -> outcome map -> Logistic Regression -> Naive Bayes fallback -> regex fallback |
| Primary ML model | TF-IDF + Logistic Regression |
| Model file | `models/severity_lr.json` |
| Training data | `data/ADRA_Synthetic_Evaluation_Dataset.xlsx`, sheet `ADRA_ICSR_Synthetic` |
| Rows | 2,662 |
| Features | MedDRA PT/SOC/LLT, outcome, narrative, suspect drug, causality |
| Excluded leakage field | `SAE_Seriousness_Criteria` |
| Evaluation | Stratified 5-fold cross-validation |
| Selected model | Logistic Regression (TF-IDF) |
| Macro-F1 | 0.9623 |
| MCC | 0.9500 |
| Script | `python scripts/train_severity_classifier.py` |
| Report | `reports/severity_eval.json` |

**Model comparison:**

| Model | Macro-F1 | MCC |
|---|---:|---:|
| Logistic Regression (TF-IDF) | 0.9623 | 0.9500 |
| Random Forest (TF-IDF) | 0.9608 | 0.9476 |
| Gradient Boosting (TF-IDF) | 0.9528 | 0.9372 |

**Per-class results, selected model:**

| Class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| death | 0.9561 | 0.9465 | 0.9513 | 299 |
| disability | 0.9409 | 0.9777 | 0.9589 | 179 |
| hospitalisation | 0.9508 | 0.9567 | 0.9537 | 323 |
| others | 0.9871 | 0.9839 | 0.9855 | 1,861 |

**Known limitation:** Evaluation uses synthetic ICSR rows. Real-world post-deployment monitoring must track class drift, source-document noise, and false negatives for serious cases.

### 7.2 Completeness Routing and Confidence Scoring

| Field | Value |
|---|---|
| Task | Route report to `ready_for_processing`, `needs_followup`, or `manual_review` |
| Method | Deterministic rule engine |
| Mandatory fields | Patient initials, patient age, adverse reaction, suspected medication, reporter contact |
| Confidence formula | `fieldCoverage * 0.45 + parserConfidence * 0.35 + sourceTrace * 0.20` |
| Routing rule | No missing mandatory fields + confidence >= 0.65 -> ready; missing fields -> follow-up; otherwise manual review |
| Code | `server/ai/scoringModel.js` |

**Interpretation:** This is not a clinical risk score. It measures extraction completeness and review readiness.

### 7.3 Duplicate and Follow-Up Detector

| Field | Value |
|---|---|
| Task | Classify case relation as new, duplicate, or follow-up |
| Method | Source hash plus blocking key comparison |
| Blocking key | Patient token + suspect drug + adverse reaction / MedDRA PT |
| Labelled pairs | 462 |
| Best strategy | Blocking key rule |
| Precision | 1.0000 |
| Recall | 1.0000 |
| F1 | 1.0000 |
| Script | `python scripts/evaluate_duplicates.py` |
| Report | `reports/duplicate_eval.json` |

**Known limitation:** The duplicate dataset is generated with the same linkage assumptions as the detector. Submission should present this as a strong prototype baseline, not final real-world duplicate performance.

### 7.4 Extractive Summariser

| Field | Value |
|---|---|
| Task | Summarise SAE narratives, checklist text, and meeting-style notes |
| Method | Extractive TF-IDF/TextRank-style sentence ranking with source-span output |
| Policy | Verbatim source spans only; no generated clinical facts |
| Evaluation documents | 100 synthetic narratives |
| Reference | Lead-3 proxy convention |
| ROUGE-1 F | 0.9401 |
| ROUGE-2 F | 0.8979 |
| ROUGE-L F | 0.9401 |
| Script | `python scripts/evaluate_rouge.py --no-bertscore` |
| Report | `reports/rouge_eval.json` |

**Known limitation:** High scores reflect clean synthetic narrative structure and lead-3 reference alignment. Live stored-report ROUGE may be lower on noisy OCR/PDF inputs.

### 7.5 Field Extraction Engine

| Field | Value |
|---|---|
| Task | Extract ADR fields from parsed source text and structured rows |
| Method | Rule/regex extraction with optional sidecar NER enrichment |
| Code | `server/ai/nlpExtractor.js`, `python/sidecar/models/ner.py` |
| Evaluation mode | Soft substring match against structured synthetic columns |
| Rows | 2,662 |
| Macro-F1 | 0.3908 |
| Micro-F1 | 0.5123 |
| Seriousness F1 | 0.9926 |
| Outcome F1 | 0.8325 |
| Adverse reaction F1 | 0.5196 |
| Patient age / sex / suspect drug | 0.0000 in current synthetic narrative evaluation |
| Script | `python scripts/evaluate_extraction_f1.py` |
| Report | `reports/extraction_f1.json` |

**Submission interpretation:** Seriousness and outcome extraction are strong. Overall macro extraction is not yet production-grade because several demographic/drug fields are not reliably recoverable from the current synthetic narrative form. This should be framed transparently as a targeted improvement area.

### 7.6 Privacy, PII, and PHI Detection

| Field | Value |
|---|---|
| Task | Detect PII/PHI, tokenise identifiers, and produce analytics-safe copies |
| Method | Rule/regex hybrid plus demographic generalisation |
| PII patterns | Aadhaar, PAN, Indian mobile, email, MRN/UHID, names/contact fragments, location hints |
| Privacy metrics | k-anonymity, l-diversity, t-closeness |
| Quasi-identifiers | Strategy A: ageBand + gender + region |
| Sensitive attributes | outcome, seriousness |
| Code | `server/ai/privacyModel.js`, `server/ai/privacyMetrics.js` |
| Evaluation script | `python scripts/evaluate_privacy_metrics.py` |

**Annexure privacy results:**

| Metric | Value | Threshold | Status |
|---|---:|---:|---|
| k-anonymity before suppression | 1 | - | Measured |
| k-anonymity after suppression | 5 | >= 5 | PASS |
| Suppression rate | 2.93% | - | Acceptable for prototype |
| l-diversity, outcome | 1 | >= 2 | FAIL |
| l-diversity, seriousness | 1 | >= 2 | FAIL |
| t-closeness, outcome | 0.4914 | <= 0.35 health-data threshold | FAIL |
| t-closeness, seriousness | 0.5666 | <= 0.35 health-data threshold | FAIL |

**Submission interpretation:** k-anonymity is implemented and passes after suppression. l-diversity and t-closeness are measured but currently fail strict release criteria, so ADRA should be positioned as privacy-metric aware with required stronger release controls before production analytics release.

### 7.7 OCR and Document Parsing

| Field | Value |
|---|---|
| Task | Parse PDF/CSV/XLSX/JSON/XML/TXT and support image OCR |
| Server OCR | Tesseract.js through `server/ai/tesseractService.js` |
| Sidecar OCR | Optional OCR route under `python/sidecar/routes/ocr.py` |
| Image endpoint | `POST /api/ocr` |
| CER metric | `computeCer()` implemented |
| CER status | Real scanned gold fixtures required for submission-grade CER |

**Known limitation:** OCR engine is active, but the current Annexure report does not include a real scanned-form CER benchmark because gold scanned fixtures/transcripts are not present.

### 7.8 RAG Evidence Search

| Field | Value |
|---|---|
| Task | Search stored report chunks for evidence matching reviewer query |
| Method | Keyword/token overlap over persisted `ragChunks` |
| Endpoint | `POST /api/rag/query` |
| Code | `server/index.js`, report chunks from `server/reportProcessor.js` |
| Output | Ranked chunks with report ID, medicine, reaction, severity class, matched terms |

**Known limitation:** Current RAG is deterministic keyword retrieval, not vector embeddings. This is safer for prototype traceability but less semantically powerful.

### 7.9 Reviewer Priority Queue

| Field | Value |
|---|---|
| Task | Rank reports for human review |
| Formula | `severityWeight * 0.60 + min(missingFields / 5, 1) * 0.25 + (1 - confidence) * 0.15` |
| Tiers | urgent, high, normal, low |
| Endpoint | `GET /api/reviewer/queue` |
| Explainability | Per-case reasons: serious outcome, missing fields, low confidence, duplicate/follow-up |

### 7.10 Credibility Monitor

| Field | Value |
|---|---|
| Task | Flag reports needing credibility or consistency review |
| Method | Optional sidecar credibility route plus JS fallback heuristic scoring |
| Dimensions | medical coherence, completeness, consistency, demographic plausibility, narrative quality |
| Endpoint | `POST /api/credibility/analyze` |
| Output | Score, grade A-D, flags, dimension breakdown, source mode |

**Known limitation:** This is a screening heuristic, not a fraud detector. It should only trigger human reverification.

### 7.11 Annexure I Evaluation Aggregator

| Field | Value |
|---|---|
| Task | Consolidate evaluation metrics for dashboard and submission |
| Endpoint | `GET /api/evaluate/annexure` |
| Frontend | Annexure I page in `client/src/App.jsx` |
| Source reports | `reports/severity_eval.json`, `reports/rouge_eval.json`, `reports/privacy_eval.json`, `reports/extraction_f1.json`, `reports/duplicate_eval.json` |
| Aggregate runner | `python scripts/evaluate_all.py --no-bertscore` |
| Robustness update | If sandboxed sklearn training fails, aggregate runner falls back to existing `reports/severity_eval.json` |

---

## 8. Annexure I Evaluation Summary

| Capability | Metric | Current value | Source |
|---|---|---:|---|
| Severity classification | Macro-F1 | 0.9623 | `reports/severity_eval.json` |
| Severity classification | MCC | 0.9500 | `reports/severity_eval.json` |
| Summarisation | ROUGE-1 F | 0.9401 | `reports/rouge_eval.json` |
| Summarisation | ROUGE-2 F | 0.8979 | `reports/rouge_eval.json` |
| Summarisation | ROUGE-L F | 0.9401 | `reports/rouge_eval.json` |
| Privacy | k after suppression | 5 PASS | `reports/privacy_eval.json` |
| Privacy | Suppression rate | 2.93% | `reports/privacy_eval.json` |
| Privacy | l-diversity | FAIL | `reports/privacy_eval.json` |
| Privacy | t-closeness | FAIL | `reports/privacy_eval.json` |
| Field extraction | Macro-F1 | 0.3908 | `reports/extraction_f1.json` |
| Field extraction | Micro-F1 | 0.5123 | `reports/extraction_f1.json` |
| Field extraction | Seriousness F1 | 0.9926 | `reports/extraction_f1.json` |
| Field extraction | Outcome F1 | 0.8325 | `reports/extraction_f1.json` |
| Duplicate/follow-up detection | F1 | 1.0000 | `reports/duplicate_eval.json` |
| OCR | CER | Not yet benchmarked on scanned gold fixtures | `server/ai/tesseractService.js` |
| Latency | p50/p95/p99 | Live route metrics | `GET /api/health/latency` |

---

## 9. Data

| Dataset | Location | Rows | Use |
|---|---|---:|---|
| Synthetic ICSR dataset | `data/ADRA_Synthetic_Evaluation_Dataset.xlsx` | 2,662 | Severity, ROUGE, extraction, privacy |
| Duplicate/follow-up pairs | Same workbook | 462 | Duplicate/follow-up evaluation |
| CDSCO AI dataset | `data/CDSCO_AI_Datasets.xlsx` | varies | Supporting regulatory dataset |
| Output evaluation workbook | `output/ADRA_Output_Evaluation.xlsx` | varies | Output-form evaluation |
| Runtime MongoDB records | MongoDB | deployment-specific | Live dashboard and role-scoped records |

**Data provenance:** Current reported benchmark metrics use synthetic data. No real patient PHI is required for the included evaluation reports.

---

## 10. Security and Governance

| Control | Current status |
|---|---|
| Password hashing | bcryptjs salted hashes |
| Authentication | JWT bearer token |
| Authorisation | `super_admin` and `pvpi_member` role scopes |
| File storage | In-memory processing; original upload buffers are not persisted |
| Source hash | SHA-256 stored for deduplication |
| Secure review token | Random token generated; hash stored rather than plaintext |
| Audit | MongoDB `AuditEvent` collection |
| Runtime config | Production must set strong `JWT_SECRET` and MongoDB URI |
| Data minimisation | Pseudonymised patient/reporter tokens and analytics-safe fields |

## 11. Production Gaps

| Gap | Risk | Recommended fix |
|---|---|---|
| JWT stored client-side | XSS could expose bearer token | Move to httpOnly, sameSite=strict secure cookies |
| No login rate limiting | Brute-force risk | Add rate limiter and account lockout policy |
| Synthetic-only benchmark | Real-world drift unknown | Validate on de-identified real CDSCO/PvPI samples |
| Extraction macro-F1 low | Missing fields may remain unresolved | Improve extraction with domain NER, structured form parsers, and sidecar model validation |
| l/t privacy metrics fail | Released analytics may leak sensitive attribute distributions | Add stronger generalisation, suppression, or differential privacy controls |
| OCR CER missing | Scanned-form accuracy unknown | Build scanned ADR fixture set with gold transcripts |
| RAG is keyword-based | Semantic recall limited | Add auditable vector retrieval with citation-only answer mode |
| Sidecar optional | Feature variability across deployments | Package sidecar as managed service/container for production |
| Token vault absent | Secret material not enterprise-managed | Use KMS/vault and formal key rotation |

---

## 12. Responsible AI Position

| Principle | ADRA implementation |
|---|---|
| Transparency | Metrics, scripts, model basis, source traces, and confidence components are exposed. |
| Human control | All outputs route to human reviewers; no automated regulatory decision. |
| Safety | Low-confidence and incomplete cases are routed to follow-up/manual review. |
| Privacy | PII/PHI detection, tokenisation, k/l/t metrics, and role-scoped access are implemented. |
| Accountability | Audit events and immutable records support post-hoc review. |
| Bias control | Severity ML excludes demographic fields; class imbalance handled through balanced training. |
| Non-fabrication | Summaries are extractive and source-bound; clinical facts are not generated. |

---

## 13. Submission Readiness Statement

ADRA is ready for tool submission as a working end-to-end prototype. The strongest evidence points are severity classification, summarisation, duplicate/follow-up linkage, authenticated intake, reviewer workflow, Annexure I dashboarding, and transparent evaluation scripts.

The submission should explicitly state that field extraction macro-F1, OCR CER benchmarking, and strict l-diversity/t-closeness privacy release controls are active improvement areas. This framing is technically honest and defensible for a prototype-stage hackathon submission.

---

## 14. Reproduction Commands

```bash
npm install
npm run build
npm run start
```

```bash
python scripts/evaluate_all.py --no-bertscore
python scripts/train_severity_classifier.py --output reports/severity_eval.json
python scripts/evaluate_rouge.py --no-bertscore
python scripts/evaluate_privacy_metrics.py
python scripts/evaluate_extraction_f1.py
python scripts/evaluate_duplicates.py
```

Optional sidecar:

```bash
npm run setup:sidecar
npm run dev:sidecar
```

---

*ADRA Full Solution Model Card - updated May 2026.*
