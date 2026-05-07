# ADRA MERN Prototype

ADRA is an AI-assisted regulatory workflow prototype for ADR intake, anonymisation, completeness scoring, reviewer prioritisation, medicine dashboards, and ML analytics.

## Current Backend AI Layout

The AI, ML, OCR, and BioGPT code is split into focused modules under `server/ai`:

| File | Responsibility |
|---|---|
| `server/ai/ocrService.js` | In-memory document parsing for PDF, CSV, XLSX/XLS, JSON, XML, TXT/MD, and image OCR-pending states. Original files are not stored. |
| `server/ai/nlpExtractor.js` | Rule/NLP-style ADR field extraction for patient, reporter, PvPI, clinical, and source trace fields. Extracted report text is preserved exactly. |
| `server/ai/biogptService.js` | BioGPT integration contract for exact source-span agreement only. It does not predict, normalise, or overwrite report data. |
| `server/ai/privacyModel.js` | PII/PHI detection metadata and tokenisation findings for patient/reporter identifiers and location hints. |
| `server/ai/scoringModel.js` | Completeness score, missing mandatory fields, processing route, and confidence component calculation. |
| `server/ai/caseLinkage.js` | New/duplicate/follow-up classification using source hash, patient token, medicine, ADR, and changed clinical fields. |
| `server/ai/mlAnalytics.js` | ML analytics entrypoint used by the API. |
| `server/ai/textUtils.js` | Shared text cleanup, hashing, token, age-band, and weight-band helpers. |

`server/reportProcessor.js` is now only the pipeline orchestrator. It calls OCR/parsing, NLP extraction, BioGPT agreement, privacy detection, scoring, and RAG chunk creation, then returns a MongoDB-ready processed report.

## Duplicate And Follow-Up Logic

During intake, each processed report is compared with existing MongoDB records and earlier files in the same batch:

- `duplicate`: same source document hash, or same patient token + medicine + ADR with no meaningful new clinical details.
- `followup`: same patient token + medicine + ADR, but outcome, seriousness, onset date, dose, route, frequency, or narrative changed/was newly added.
- `new`: no previous patient/case anchor matched.

The original report facts remain immutable. Only relation metadata, duplicate history, follow-up history, and linkage basis are stored.

## Non-Negotiable Data Rule

ADRA stores report facts exactly as extracted from the source document. If a report says `Severe rash`, ADRA stores `Severe rash`. BioGPT and future AI/ML models may only add evidence, agreement, confidence, or reviewer hints. They must not replace source terms, infer missing facts, or rewrite medicine/reaction/outcome fields.

## Running Locally

```bash
npm install
npm run build
npm run start
```

Open `http://127.0.0.1:5001`.

The backend reads `MONGODB_URI` from `.env`. For this project that value must be the MongoDB Atlas `mongodb+srv://...@cluster0.duxieaa.mongodb.net/` connection string, not a local Compass URI. `MONGODB_DB=adra` pins writes to the ADRA database inside Atlas.

No demo users or dummy records are seeded. Create users through the signup page/API, then upload or process fixture reports to populate MongoDB.

## Key APIs

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/signup` | Register user with bcrypt password hashing |
| `POST` | `/api/auth/login` | Login and receive JWT |
| `GET` | `/api/auth/me` | Validate JWT |
| `POST` | `/api/intake/reports` | Process uploaded ADR files in memory |
| `POST` | `/api/intake/fixtures` | Process local CDSCO fixture files |
| `GET` | `/api/reports` | List role-scoped processed reports |
| `GET` | `/api/ml/analytics` | Return ML dashboard metrics, model scores, predictions, and signals |
