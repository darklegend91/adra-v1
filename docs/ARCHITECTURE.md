# ADRA Solution Architecture

**System:** ADRA — AI-Driven Regulatory Workflow Automation  
**Version:** 0.1.0  
**Date:** May 2026  

> **Diagram:** See [`architecture.svg`](./architecture.svg) for the full visual diagram.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser — React 19 + Vite                                          │
│  19 dashboard pages · JWT Bearer · localStorage session             │
│  Overview · Intake · Records · Medicine · Pivot · Cohorts           │
│  Confidence · AI/ML · Anonymisation · RAG · Guidelines · Queue      │
│  Compare · Relations · Inspection · Annexure I · Audit              │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HTTPS / Bearer JWT
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Security Layer                                                     │
│  ├── verifyAuthToken()  bcryptjs · HS-256 JWT · 8h expiry           │
│  ├── Role check         super_admin | pvpi_member                   │
│  ├── Input validation   25 MB file · 2 MB JSON · extension list     │
│  └── Latency tracker    p50/p95/p99 per route → /api/health/latency │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Intake Pipeline                                                    │
│  Multer (memory) → ocrService → nlpExtractor → privacyModel        │
│                 → scoringModel → severityClassifier → summariser    │
│                 → caseLinkage → Report.create() [MongoDB]           │
│  Formats: PDF · XLSX · CSV · JSON · XML · TXT · Image(needs_ocr)   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  MongoDB Atlas                                                      │
│  reports · users · auditevents · guidelineprofiles                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. AI / ML Pipeline (Detail)

```
POST /api/intake/reports
        │
        ▼
Multer memory upload  (no disk write, 25 MB limit, 20 files max)
        │
        ▼
ocrService.js — file type dispatcher
  ├── .pdf     → pdf-parse  (digital text, metadata)
  ├── .xlsx/.xls → xlsx     (row/column parsing)
  ├── .csv     → line parser
  ├── .json/.xml/.txt/.md → direct text
  └── image/*  → needs_ocr flag   [Tesseract/PaddleOCR wiring point]
        │
        ▼
nlpExtractor.js — rule/regex ADR field extraction
  Extracts (verbatim source spans — no normalisation):
    patient   → initials · age · gender · weight · token
    reporter  → name · email · phone · institution · token
    pvpi      → received date · source file · source page · traceId
    clinical  → drug · reaction · dose · route · onset · outcome · seriousness · narrative
    sourceTrace → per-field provenance for reviewer trust
        │
        ▼
biogptService.js — exact-span agreement only
  (stub: agreement = 0; BioGPT/ClinicalBERT integration point)
        │
        ▼
privacyModel.js — PII / PHI detection
  Detects: Aadhaar (12-digit) · PAN (XXXXX1234X) · MRN · Indian phone
           (10-digit, prefix 6–9) · email · location-hint text
  Regulation tags: DPDP Act 2023 · NDHM · ICMR · CDSCO Schedule Y
  Pseudonymisation: PATIENT-TOKEN-<sha256> · REPORTER-TOKEN-<sha256>
  Secure review token: PVPI-RELINK-<32-byte random> (hash stored, not plaintext)
        │
        ▼
scoringModel.js — completeness + confidence
  Completeness:  mandatory field audit → route (ready / needs_followup / manual_review)
  Confidence:    field_coverage × 0.45 + parser × 0.35 + source_trace × 0.20
        │
        ▼
severityClassifier.js — CDSCO four-class classification
  Classes:   death · disability · hospitalisation · others
  Primary:   TF-IDF + Gradient Boosting  Macro-F1 0.990  MCC 0.987
  Fallback:  rule/label-map classifier   Macro-F1 0.789  MCC 0.712
        │
        ▼
summariser.js — three-source extractive summarisation
  Types:    sae (ADR narration) · checklist (SUGAM) · meeting (transcript)
  Method:   TF-IDF sentence scoring + domain keyword boosting + position weighting
  Policy:   all output sentences are verbatim source spans
  ROUGE-1:  0.9401   ROUGE-2: 0.8979   ROUGE-L: 0.9401
        │
        ▼
caseLinkage.js — duplicate / follow-up detection
  Stage 1:  SHA-256 source hash exact match
  Stage 2:  patient token + suspect drug + MedDRA PT blocking key
  F1:       1.000 on 462 labelled pairs
        │
        ▼
MongoDB Report.create() — immutable record
  Stored:  extractedFields · privacyFindings · scoreSnapshots · confidence
           severityClass · saeSummary · ragChunks · sourceHash · auditMetadata
  NOT stored: original source file buffer (discarded after parse)
```

---

## 3. Privacy Architecture

```
Source document
        │
        ▼
Pseudonymised copy (reviewer-facing)
  patient initials    → PATIENT-TOKEN-<sha256(salt + initials)>
  reporter name       → REPORTER-TOKEN-<sha256(salt + name)>
  reporter email/phone → tokenised
  secure review token → PVPI-RELINK-<32-byte random hex>
                         hash stored, NOT the token itself
        │
        ▼
Analytics copy (dashboard-facing — no direct identifier)
  age        → band  (<18 · 18-29 · 30-44 · 45-59 · 60-74 · 75+)
  weight     → band
  region     → zone  (North · South · East · West · Other India)
  medicine   → ATC class  (Antibacterial · Anticoagulant · …)
  reaction   → MedDRA SOC
  outcome    → generalised  (Fatal · Recovered · Not-recovered · Unknown)
  seriousness → generalised (death · disability · hospitalisation · others)
        │
        ▼
privacyMetrics.js — k-anonymity / l-diversity / t-closeness
  QIs (Strategy A): ageBand + gender + region
  Step 1: k-suppression  — remove equivalence classes with k < 5
  Step 2: l-suppression  — remove classes with l < 2 on any sensitive attribute
  Step 3: t-closeness    — half-sum EMD approximation (categorical)

  Results on 2,662-row synthetic dataset:
    k = 5  (after suppression; 78 records / 2.9% suppressed)
    l = 1  (synthetic data regularity — l-generalisation recommended)
    t-closeness measured post-suppression (see reports/privacy_eval.json)
```

---

## 4. Security Architecture

### 4.1 Authentication Flow

```
POST /api/auth/login
  ├── normaliseEmail()
  ├── findUserByEmail() [MongoDB]
  ├── verifyPassword() [bcrypt.compare]
  ├── check approvalStatus === "approved"
  ├── signAuthToken() [HS-256 JWT, 8h]
  └── writeAuditEvent(login)

Every protected route:
  Authorization: Bearer <token>
  → getBearerToken()
  → verifyAuthToken() [throws 401 on expiry/tamper]
  → findUserById() [throws 401 if user deleted]
  → role/center scope applied to query filter
```

### 4.2 Token Reveal Policy

```
Secure review token (PVPI re-linking):
  pvpi_member  → full token visible for own submissions only
  super_admin  → token preview only (4-char prefix + ***)
  All reveals  → AuditEvent logged: actorId · action · entityId · timestamp

Token vault (production):
  Plaintext token never stored in MongoDB
  SHA-256(token) stored for lookup
  Full token in encrypted vault (HashiCorp Vault / KMS) — planned
```

### 4.3 Compliance Traceability

| Regulation | Clause | ADRA Enforcement |
|---|---|---|
| DPDP Act 2023 | §5 — Notice | Signup form + policy text |
| DPDP Act 2023 | §8 — Data quality | Immutable records + completeness score |
| DPDP Act 2023 | §8(7) — Erasure | Delete-request workflow (planned) |
| NDHM HDMP | §4.2 — Consent | Reviewer-only access; audit on every reveal |
| ICMR Ethical Guidelines | Section 4 | No patient contact; submitted reports only |
| CDSCO Schedule Y | SAE reporting | Mandatory field scoring; severity 4-class |
| CERT-In | Audit log retention | AuditEvent collection; WORM sink (planned) |

---

## 5. REST API Surface

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/signup | — | Register user |
| POST | /api/auth/login | — | Login → JWT |
| GET | /api/auth/me | JWT | Validate session |
| POST | /api/intake/reports | JWT | Upload 1–20 files |
| POST | /api/intake/fixtures | JWT | Process CDSCO fixture files |
| GET | /api/reports | JWT | Paginated report list |
| GET | /api/reviewer/queue | JWT | Priority-ordered queue |
| GET | /api/ml/analytics | JWT | Model metrics + signals |
| GET | /api/privacy-metrics | JWT | k/l/t on analytics copy |
| GET | /api/anonymisation/samples | JWT | Raw → pseudonymised → anonymised |
| POST | /api/summarise | JWT | SAE/checklist/meeting summary |
| POST | /api/ocr | JWT | Tesseract OCR + PII bounding boxes |
| POST | /api/inspection/process | JWT | Inspection report generation |
| GET | /api/inspection/template | JWT | CDSCO template schema |
| POST | /api/completeness | JWT | Field-level completeness report |
| POST | /api/compare | JWT | Document version diff |
| GET | /api/audit | JWT+admin | Audit event log |
| GET/POST | /api/guidelines | JWT | Guideline profile CRUD |
| POST | /api/rag/query | JWT | Keyword RAG over anonymised chunks |
| GET | /api/evaluate/rouge | JWT | ROUGE on stored reports |
| GET | /api/health | — | Health check |
| GET | /api/health/latency | — | p50/p95/p99 per route |

---

## 6. Data Flow — Analytics Dashboards

```
MongoDB reports collection
  │
  ├── /api/reports           cursor-paginated list (up to 500/page)
  ├── /api/ml/analytics      mlAnalytics.js → model metrics · signals · cohorts
  ├── /api/privacy-metrics   privacyMetrics.js → k/l/t on analytics copy
  ├── /api/anonymisation/samples  raw→pseudonymised→anonymised worked examples
  ├── /api/reviewer/queue    priority scoring → urgent/high/normal/low
  ├── /api/compare           documentComparison.js → section diff
  ├── /api/summarise         summariser.js → SAE/checklist/meeting
  ├── /api/completeness      nlpExtractor + scoringModel → field-level flags
  └── /api/guidelines        GuidelineProfile → versioned scoring rules
```

---

## 7. Evaluation Harness

```
JavaScript (Node.js):
  npm run evaluate
    → scripts/evaluate.js
    → reports/eval-YYYY-MM-DD.json
    Covers: severity (rule), completeness routing, duplicate detection,
            OCR CER (engine check), summarisation compression, privacy k/l/t

Python:
  python scripts/evaluate_all.py --no-bertscore
    → reports/annexure_i.json
    Calls:
      evaluate_rouge.py          → ROUGE-1/2/L + BERTScore
      train_severity_classifier.py → LR / RF / GBT Macro-F1 + MCC + confusion matrix
      evaluate_privacy_metrics.py  → k-anonymity / l-diversity / t-closeness
      evaluate_extraction_f1.py    → per-field precision / recall / F1
      evaluate_duplicates.py       → 4-strategy duplicate detection F1
```

---

## 8. Production Deployment Target

```
Internet
    │
API Gateway  (TLS, rate limiting, WAF)
    │
    ├── Express API pods  (stateless, horizontally scalable)
    │       │
    │       ├── OCR worker pool        (Tesseract 5 / PaddleOCR / TrOCR)
    │       ├── NLP/privacy workers    (Presidio + scispaCy / BioBERT)
    │       ├── Audio workers          (faster-whisper + pyannote)
    │       └── BullMQ + Redis         (async job queue)
    │
    ├── MongoDB Atlas
    │       ├── reports              (immutable, field-level encryption)
    │       ├── users                (bcrypt + approval workflow)
    │       ├── audit_events         (WORM append-only sink)
    │       ├── guidelineprofiles    (versioned)
    │       └── token_vault          (encrypted, separate collection → KMS)
    │
    └── Vector store  (Qdrant / pgvector)
            anonymised ragChunks with row-level access control

Compliance: DPDP Act 2023 · NDHM · ICMR · CDSCO Schedule Y · CERT-In
```

---

## 9. Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, plain CSS |
| API | Node.js, Express 5 |
| Database | MongoDB Atlas, Mongoose 8 |
| Auth | bcryptjs, jsonwebtoken (HS-256) |
| File parsing | pdf-parse, xlsx, Multer (memory) |
| OCR | tesseract.js (active); Tesseract 5 native (planned) |
| Privacy metrics | Custom k/l/t (server/ai/privacyMetrics.js) |
| Summarisation | TF-IDF extractive (server/ai/summariser.js) |
| Severity classifier (ML) | TF-IDF + Gradient Boosting (scikit-learn) |
| Severity classifier (rule) | Label-map + keyword regex (severityClassifier.js) |
| Document comparison | Section-aware Jaccard diff (documentComparison.js) |
| ROUGE evaluation | rouge-score Python library (scripts/evaluate_rouge.py) |
| JS evaluation harness | scripts/evaluate.js |
| Python evaluation harness | scripts/evaluate_all.py + sub-scripts |
