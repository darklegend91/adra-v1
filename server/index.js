import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs/promises";
import { existsSync } from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { findUserByEmail, findUserById, createUser, ensureMongoConnection } from "./authStore.js";
import { normaliseEmail, publicUser, signAuthToken, validatePasswordStrength, verifyAuthToken, verifyPassword } from "./authUtils.js";
import Report from "./models/Report.js";
import AuditEvent from "./models/AuditEvent.js";
import GuidelineProfile from "./models/GuidelineProfile.js";
import { applyCaseLinkage, classifyCaseRelation } from "./ai/caseLinkage.js";
import { buildMlAnalytics } from "./ai/mlAnalytics.js";
import { computePrivacyMetrics } from "./ai/privacyMetrics.js";
import { summarise, buildChecklistSummary, buildMeetingSummary } from "./ai/summariser.js";
import { compareDocuments } from "./ai/documentComparison.js";
import { processInspectionDocument, INSPECTION_TEMPLATE } from "./ai/inspectionProcessor.js";
import { runOcr, findPiiBoxes, computeCer } from "./ai/tesseractService.js";
import { evaluateBatch } from "./ai/rougeEvaluator.js";
import { buildAnonymisationSamples, presentReport, processUploadedReport } from "./reportProcessor.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5001);
const JWT_SECRET = process.env.JWT_SECRET || "adra-development-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";
// FIXTURE_DIR: set via env var in production; defaults to local dev path
const FIXTURE_DIR = process.env.FIXTURE_DIR || "/Users/adityapathania/Codes/curin/cdsco/data-csco-ocr";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 }
});

// CORS — allow specific origins. Add FRONTEND_URL env var on Render to allow Vercel frontend.
const ALLOWED_ORIGINS = [
  "http://127.0.0.1:5001",
  "http://127.0.0.1:5173",
  "http://localhost:5001",
  "http://localhost:5173",
  process.env.FRONTEND_URL,         // Vercel frontend URL (if separate)
  process.env.RENDER_EXTERNAL_URL,  // Auto-injected by Render: https://adra-v1.onrender.com
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o))) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));
validateRuntimeConfig();

// ── Latency tracking middleware ───────────────────────────────────────────────
const latencyStore = new Map();
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on("finish", () => {
    const ms = Date.now() - start;
    const route = req.path;
    const bucket = latencyStore.get(route) || [];
    bucket.push(ms);
    if (bucket.length > 100) bucket.shift();
    latencyStore.set(route, bucket);
  });
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ADRA prototype API", auth: "mongodb" });
});

// Latency stats per route — p50/p95/p99/avg over last 100 requests
app.get("/api/health/latency", (_req, res) => {
  const routes = {};
  latencyStore.forEach((times, route) => {
    if (!times.length) return;
    const s = [...times].sort((a, b) => a - b);
    const pct = (p) => s[Math.max(0, Math.floor(s.length * p) - 1)] || s[0];
    routes[route] = {
      count: times.length,
      avg: Math.round(times.reduce((a, v) => a + v, 0) / times.length),
      p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), unit: "ms"
    };
  });
  return res.json({ routes, trackedRoutes: Object.keys(routes).length });
});

// ROUGE evaluation on stored report summaries vs lead-3 reference
app.get("/api/evaluate/rouge", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const filter = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    const reports = await Report.find(filter).limit(100);

    const pairs = reports
      .filter((r) => r.extractedFields?.clinical?.narrative?.length > 80)
      .slice(0, 50)
      .map((r) => {
        const narrative = r.extractedFields.clinical.narrative;
        const hypothesis = r.unknownFields?.saeSummary?.extractiveSummary || "";
        const sents = narrative.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);
        const reference = sents.slice(0, 3).join(" ");
        return { hypothesis, reference, reportId: r.reportNumber };
      })
      .filter((p) => p.hypothesis.length > 10 && p.reference.length > 10);

    if (!pairs.length) {
      return res.json({ samples: 0, note: "No reports with narratives and summaries found. Process ADR reports first." });
    }

    const result = evaluateBatch(pairs);
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "ROUGE evaluation failed." });
  }
});

// RAG query — keyword search over ragChunks stored on MongoDB reports
app.post("/api/rag/query", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const { query = "", filters = {}, limit = 8 } = req.body || {};
    if (!query.trim()) return res.status(400).json({ message: "query is required." });

    const baseFilter = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    if (filters.medicine) baseFilter.medicineName = new RegExp(filters.medicine.slice(0, 60), "i");
    if (filters.reaction) baseFilter.adverseReaction = new RegExp(filters.reaction.slice(0, 60), "i");

    const reports = await Report.find(baseFilter).limit(300);

    const qTokens = new Set(
      query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2)
    );

    const results = [];
    reports.forEach((report) => {
      const chunks = report.ragChunks || [];
      chunks.forEach((chunk, idx) => {
        const text = typeof chunk === "string" ? chunk : chunk.text || "";
        if (!text) return;
        const chunkTokens = new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
        const matched = [...qTokens].filter((t) => chunkTokens.has(t));
        const score = matched.length / Math.max(qTokens.size, 1);
        if (score > 0.15) {
          results.push({
            reportId: report.reportNumber,
            medicine: report.medicineName || "Unknown",
            reaction: report.adverseReaction || "Unknown",
            severityClass: report.severityClass || "others",
            chunkIndex: idx,
            text: text.slice(0, 300),
            score: Number(score.toFixed(3)),
            matchedTerms: matched.slice(0, 6)
          });
        }
      });
    });

    const ranked = results.sort((a, b) => b.score - a.score).slice(0, limit);

    writeAuditEvent({ actorId: user.id, actorRole: user.role, action: "rag_query", entityType: "RAG", entityId: "", metadata: { query: query.slice(0, 100), hits: ranked.length } }).catch(() => {});

    return res.json({ results: ranked, query, sourcesSearched: reports.length, totalMatches: results.length });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "RAG query failed." });
  }
});

app.post("/api/auth/signup", handleSignup);
app.post("/api/auth/register", handleSignup);

async function handleSignup(req, res) {
  try {
    const payload = sanitiseAuthPayload(req.body);
    const existingUser = await findUserByEmail(payload.email);
    if (existingUser) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }

    const user = await createUser(payload);
    const cleanUser = publicUser(user);
    const token = signAuthToken(cleanUser, JWT_SECRET, JWT_EXPIRES_IN);
    return res.status(201).json({ token, user: cleanUser });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Signup failed." });
  }
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normaliseEmail(req.body?.email);
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const user = await findUserByEmail(email);
    const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !passwordOk) {
      return res.status(401).json({ message: "Invalid email or password." });
    }
    if (user.approvalStatus !== "approved") {
      return res.status(403).json({ message: "Account is not approved for ADRA access." });
    }

    const cleanUser = publicUser(user);
    const token = signAuthToken(cleanUser, JWT_SECRET, JWT_EXPIRES_IN);
    writeAuditEvent({ actorId: user._id, actorRole: cleanUser.role, action: "login", entityType: "User", entityId: String(user._id), metadata: { email: cleanUser.email } }).catch(() => {});
    return res.json({ token, user: cleanUser });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Login failed." });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ message: "User no longer exists." });
    return res.json({ user: publicUser(user) });
  } catch (_error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
});

app.post("/api/intake/reports", upload.array("reports", 20), async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: "At least one report file is required." });
    const processed = await processAndStoreFiles(files, user);
    writeAuditEvent({ actorId: user.id, actorRole: user.role, action: "intake_upload", entityType: "Report", entityId: "", metadata: { count: processed.length, files: files.map((f) => f.originalname) } }).catch(() => {});
    return res.status(201).json({ count: processed.length, reports: processed });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Report intake failed." });
  }
});

app.post("/api/intake/fixtures", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const requested = Array.isArray(req.body?.files) ? req.body.files : [];
    const fixtureFiles = await loadFixtureFiles(requested);
    const processed = await processAndStoreFiles(fixtureFiles, user);
    writeAuditEvent({ actorId: user.id, actorRole: user.role, action: "intake_fixtures", entityType: "Report", entityId: "", metadata: { count: processed.length, fixtures: requested } }).catch(() => {});
    return res.status(201).json({ count: processed.length, reports: processed });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Fixture intake failed." });
  }
});

app.get("/api/reports", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const limit = Math.min(Number(req.query.limit || 25), 500);
    const cursor = String(req.query.cursor || "");
    const filter = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    if (cursor.match(/^[0-9a-fA-F]{24}$/)) filter._id = { $lt: cursor };
    const reports = await Report.find(filter).select("+secureReviewToken").sort({ _id: -1 }).limit(limit + 1);
    const hasMore = reports.length > limit;
    const page = hasMore ? reports.slice(0, limit) : reports;
    return res.json({
      reports: page.map((report) => presentReport(report, user)),
      nextCursor: hasMore ? String(page[page.length - 1]._id) : ""
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to load reports." });
  }
});

// Reviewer priority queue — reports ordered by urgency with explainability
app.get("/api/reviewer/queue", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const filter = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(500);

    const SEVERITY_WEIGHT = { death: 1.0, disability: 0.85, hospitalisation: 0.7, others: 0.3 };

    const queue = reports.map((report) => {
      const presented = presentReport(report, user);
      const sevClass = (presented.severityClass || "others").toLowerCase();
      const sevWeight = SEVERITY_WEIGHT[sevClass] || 0.3;
      const missingCount = (presented.missingFields || []).length;
      const conf = Number(presented.confidence || 0);
      const isDuplicate = ["duplicate", "followup"].includes(presented.relation || "");

      // Priority score: severity (60%) + missing fields (25%) + low-confidence (15%)
      const priorityScore = Number((
        sevWeight * 0.60 +
        Math.min(missingCount / 5, 1) * 0.25 +
        (1 - conf) * 0.15
      ).toFixed(3));

      // Build explainability reasons
      const reasons = [];
      if (sevClass === "death") reasons.push("Fatal/life-threatening — immediate review");
      else if (sevClass === "disability") reasons.push("Disability/incapacity case");
      else if (sevClass === "hospitalisation") reasons.push("Hospitalisation required");
      if (missingCount > 0) reasons.push(`${missingCount} mandatory field(s) missing`);
      if (conf < 0.65) reasons.push(`Low extraction confidence (${Math.round(conf * 100)}%)`);
      if (isDuplicate) reasons.push("Possible duplicate or follow-up");
      if (presented.status === "needs_ocr") reasons.push("Needs OCR — manual entry required");
      if (reasons.length === 0) reasons.push("Routine review");

      return {
        ...presented,
        priorityScore,
        priorityTier: priorityScore >= 0.75 ? "urgent" : priorityScore >= 0.5 ? "high" : priorityScore >= 0.3 ? "normal" : "low",
        reasons
      };
    }).sort((a, b) => b.priorityScore - a.priorityScore);

    const stats = {
      urgent: queue.filter((r) => r.priorityTier === "urgent").length,
      high: queue.filter((r) => r.priorityTier === "high").length,
      normal: queue.filter((r) => r.priorityTier === "normal").length,
      low: queue.filter((r) => r.priorityTier === "low").length
    };

    return res.json({ queue, stats, total: queue.length });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to build reviewer queue." });
  }
});

app.get("/api/ml/analytics", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const filter = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(500);
    const analytics = buildMlAnalytics(reports);
    return res.json(analytics);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to build ML analytics." });
  }
});

// Privacy metrics: k-anonymity, l-diversity, t-closeness
app.get("/api/privacy-metrics", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const filter = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(500);
    const metrics = computePrivacyMetrics(reports);
    return res.json(metrics);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to compute privacy metrics." });
  }
});

// Anonymisation samples derived from real processed reports
app.get("/api/anonymisation/samples", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const filter = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(30);
    const samples = buildAnonymisationSamples(reports);
    return res.json({ samples });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to build anonymisation samples." });
  }
});

// SAE / checklist / meeting summarisation — accepts JSON body or file upload
app.post("/api/summarise", upload.single("document"), async (req, res) => {
  try {
    await getAuthenticatedUser(req);

    const sourceType = req.body?.sourceType || "sae";
    const maxSentences = req.body?.maxSentences ? Number(req.body.maxSentences) : undefined;
    let text = req.body?.text || "";

    // File upload path — extract text using the same OCR/parse pipeline as report intake
    if (req.file) {
      const { parseSourceDocument, buildSourceMetadata } = await import("./ai/ocrService.js");
      const meta = buildSourceMetadata(req.file);
      const parsed = await parseSourceDocument(req.file, meta);
      text = parsed.text || "";
      if (!text) return res.status(422).json({ message: "Could not extract text from uploaded file." });
    }

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ message: "text or document file is required." });
    }

    // Route to the correct structured builder per source type
    let result;
    if (sourceType === "checklist") {
      result = buildChecklistSummary(text);
    } else if (sourceType === "meeting") {
      result = buildMeetingSummary(text);
    } else {
      // SAE: standard extractive summary
      result = summarise(text, sourceType, { maxSentences });
    }

    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Summarisation failed." });
  }
});

// OCR endpoint — image upload → Tesseract text + PII bounding boxes
app.post("/api/ocr", upload.single("image"), async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    if (!req.file) return res.status(400).json({ message: "Image file required." });

    const ocr = await runOcr(req.file.buffer);
    const piiBoxes = findPiiBoxes(ocr.words);

    // Optional CER: if caller provides reference text, compute CER
    const reference = req.body?.reference || "";
    const cer = reference ? computeCer(ocr.text, reference) : null;

    return res.json({
      text: ocr.text,
      averageConfidence: ocr.averageConfidence,
      wordCount: ocr.wordCount,
      ocrEngine: ocr.ocrEngine,
      piiBoxes,
      cer,
      note: "Text extracted via Tesseract OCR. PII bounding boxes indicate redaction regions."
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "OCR failed." });
  }
});

// Inspection report generation
app.post("/api/inspection/process", upload.single("document"), async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    let text = "";

    if (req.file) {
      const { parseSourceDocument, buildSourceMetadata } = await import("./ai/ocrService.js");
      const meta = buildSourceMetadata(req.file);
      const parsed = await parseSourceDocument(req.file, meta);
      text = parsed.text || "";
    } else if (req.body?.text) {
      text = String(req.body.text).slice(0, 50000);
    }

    if (!text.trim()) return res.status(400).json({ message: "No text content found. Digital PDF or plain text required." });

    const result = processInspectionDocument(text);
    writeAuditEvent({ actorId: user.id, actorRole: user.role, action: "inspection_process", entityType: "Inspection", entityId: "", metadata: { observations: result.observationsExtracted } }).catch(() => {});
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Inspection processing failed." });
  }
});

app.get("/api/inspection/template", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    return res.json(INSPECTION_TEMPLATE);
  } catch (error) {
    return res.status(401).json({ message: "Authentication required." });
  }
});

// Completeness assessment — accepts file upload or raw text
app.post("/api/completeness", upload.single("document"), async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    let text = req.body?.text || "";

    if (req.file) {
      const { parseSourceDocument, buildSourceMetadata } = await import("./ai/ocrService.js");
      const meta = buildSourceMetadata(req.file);
      const parsed = await parseSourceDocument(req.file, meta);
      text = parsed.text || "";
    }

    if (!text.trim()) return res.status(400).json({ message: "No text content found." });

    const { extractAdrFields } = await import("./ai/nlpExtractor.js");
    const { buildConfidence, buildScoreSnapshot } = await import("./ai/scoringModel.js");
    const { detectPrivacyFindings } = await import("./ai/privacyModel.js");

    const parsed = { text, rows: [], needsOcr: false, parser: "api-text", parserConfidence: 0.85 };
    const fields = extractAdrFields(parsed);
    const privacy = detectPrivacyFindings(fields, text);
    const confidence = buildConfidence(parsed, fields);
    const score = buildScoreSnapshot(fields, confidence, "guideline-v1");

    // Build detailed field-level completeness report
    const fieldReport = [
      { field: "Patient initials", value: fields.patient.initials || "", mandatory: true, present: Boolean(fields.patient.initials), section: "Patient" },
      { field: "Patient age", value: fields.patient.age || "", mandatory: true, present: Boolean(fields.patient.age), section: "Patient" },
      { field: "Patient gender", value: fields.patient.gender || "", mandatory: false, present: Boolean(fields.patient.gender), section: "Patient" },
      { field: "Patient weight (kg)", value: fields.patient.weight || "", mandatory: false, present: Boolean(fields.patient.weight), section: "Patient" },
      { field: "Adverse reaction", value: fields.clinical.adverseReaction || "", mandatory: true, present: Boolean(fields.clinical.adverseReaction), section: "Clinical" },
      { field: "Suspected medication", value: fields.clinical.suspectedMedication || "", mandatory: true, present: Boolean(fields.clinical.suspectedMedication), section: "Clinical" },
      { field: "Reaction onset date", value: fields.clinical.reactionOnsetDate || "", mandatory: false, present: Boolean(fields.clinical.reactionOnsetDate), section: "Clinical" },
      { field: "Dose", value: fields.clinical.dose || "", mandatory: false, present: Boolean(fields.clinical.dose), section: "Clinical" },
      { field: "Route", value: fields.clinical.route || "", mandatory: false, present: Boolean(fields.clinical.route), section: "Clinical" },
      { field: "Seriousness", value: fields.clinical.seriousness || "", mandatory: false, present: Boolean(fields.clinical.seriousness), section: "Clinical" },
      { field: "Outcome", value: fields.clinical.outcome || "", mandatory: false, present: Boolean(fields.clinical.outcome), section: "Clinical" },
      { field: "Reporter name", value: fields.reporter.name || "", mandatory: true, present: Boolean(fields.reporter.name || fields.reporter.email || fields.reporter.phone), section: "Reporter" },
      { field: "Reporter email", value: fields.reporter.email || "", mandatory: false, present: Boolean(fields.reporter.email), section: "Reporter" },
      { field: "Reporter phone", value: fields.reporter.phone || "", mandatory: false, present: Boolean(fields.reporter.phone), section: "Reporter" }
    ];

    const mandatoryPresent = fieldReport.filter((f) => f.mandatory && f.present).length;
    const mandatoryTotal = fieldReport.filter((f) => f.mandatory).length;
    const optionalPresent = fieldReport.filter((f) => !f.mandatory && f.present).length;
    const optionalTotal = fieldReport.filter((f) => !f.mandatory).length;

    return res.json({
      score: score.score,
      route: score.route,
      missingFields: score.missingFields,
      confidence: confidence.overall,
      fieldReport,
      stats: { mandatoryPresent, mandatoryTotal, optionalPresent, optionalTotal },
      privacyFindings: privacy.length,
      guidelineVersion: "guideline-v1",
      note: "Completeness assessed against CDSCO ADR Form 1.4 mandatory fields."
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Completeness assessment failed." });
  }
});

// Document version comparison — JSON body or two file uploads
app.post("/api/compare", upload.fields([{ name: "docA", maxCount: 1 }, { name: "docB", maxCount: 1 }]), async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    let textA = req.body?.textA || "";
    let textB = req.body?.textB || "";

    const files = req.files || {};
    if (files.docA?.[0] || files.docB?.[0]) {
      const { parseSourceDocument, buildSourceMetadata } = await import("./ai/ocrService.js");
      if (files.docA?.[0]) {
        const p = await parseSourceDocument(files.docA[0], buildSourceMetadata(files.docA[0]));
        textA = p.text || "";
      }
      if (files.docB?.[0]) {
        const p = await parseSourceDocument(files.docB[0], buildSourceMetadata(files.docB[0]));
        textB = p.text || "";
      }
    }

    if (!textA || !textB) {
      return res.status(400).json({ message: "Two document texts or files are required." });
    }
    const result = compareDocuments(textA, textB);
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Document comparison failed." });
  }
});

// Audit event log
app.get("/api/audit", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    if (user.role !== "super_admin") {
      return res.status(403).json({ message: "Audit log requires super_admin role." });
    }
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const events = await AuditEvent.find({}).sort({ createdAt: -1 }).limit(limit);
    return res.json({ events });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to load audit events." });
  }
});

// Guideline profiles
app.get("/api/guidelines", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    const profiles = await GuidelineProfile.find({}).sort({ createdAt: -1 }).limit(20);
    return res.json({ profiles });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to load guideline profiles." });
  }
});

app.post("/api/guidelines", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    if (user.role !== "super_admin") {
      return res.status(403).json({ message: "Saving guideline profiles requires super_admin role." });
    }
    const { version, status, requiredFields, scoringWeights, severityRules, confidenceThresholds, text, rules } = req.body || {};
    if (!version) return res.status(400).json({ message: "version is required." });

    const profile = await GuidelineProfile.findOneAndUpdate(
      { version },
      { version, status: status || "draft", requiredFields, scoringWeights, severityRules, confidenceThresholds, text, rules, createdBy: user.id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await writeAuditEvent({ actorId: user.id, actorRole: user.role, action: "guideline_save", entityType: "GuidelineProfile", entityId: version, metadata: { version, status } });
    return res.status(201).json({ profile });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to save guideline profile." });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ message: "API route not found." });
});

// Serve built frontend only when the dist folder exists (local full-stack mode).
// On Render (API-only deployment), client/dist won't be present — skip silently.
const clientDist = path.join(rootDir, "client", "dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

await ensureMongoConnection();

// Bind to 0.0.0.0 so Render (and other cloud hosts) can route traffic to the process.
// "127.0.0.1" only accepts loopback connections and will be unreachable on Render.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ADRA API running on port ${PORT} (host 0.0.0.0)`);
});

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

async function getAuthenticatedUser(req) {
  const token = getBearerToken(req);
  if (!token) throw requestError("Missing bearer token.", 401);
  const payload = verifyAuthToken(token, JWT_SECRET);
  const user = await findUserById(payload.sub);
  if (!user) throw requestError("User no longer exists.", 401);
  return user;
}

function sanitiseAuthPayload(body) {
  const name = String(body?.name || "").trim();
  const email = normaliseEmail(body?.email);
  const password = String(body?.password || "");
  const role = ["super_admin", "pvpi_member"].includes(body?.role) ? body.role : "pvpi_member";
  const centerName = String(body?.centerName || body?.center || "").trim();
  const pvpiOfficerNumber = String(body?.pvpiOfficerNumber || "").trim();

  if (name.length < 2) throw requestError("Full name is required.", 400);
  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) throw requestError("A valid email is required.", 400);
  const passwordError = validatePasswordStrength(password);
  if (passwordError) throw requestError(passwordError, 400);
  if (!centerName) throw requestError("Centre name is required.", 400);

  return { name, email, password, role, centerName, pvpiOfficerNumber };
}

function validateRuntimeConfig() {
  const isProduction = process.env.NODE_ENV === "production";
  const usingDefaultSecret = JWT_SECRET === "adra-development-secret-change-me";
  if (isProduction && usingDefaultSecret) {
    throw new Error("JWT_SECRET must be set to a strong secret in production.");
  }
  if (!isProduction && usingDefaultSecret) {
    console.warn("Using development JWT_SECRET. Set JWT_SECRET before deploying.");
  }
  if (JWT_SECRET.length < 32) {
    console.warn("JWT_SECRET should be at least 32 characters for deployed environments.");
  }
}

function requestError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function processAndStoreFiles(files, user) {
  const processedReports = [];
  const batchCandidates = [];
  for (const file of files) {
    const processed = await processUploadedReport({ file, user });
    const candidates = await findLinkageCandidates(processed, user);
    const linkage = classifyCaseRelation(processed, [...candidates, ...batchCandidates]);
    const linkedReport = applyCaseLinkage(processed, linkage);
    const report = await Report.create(linkedReport);
    batchCandidates.push(report);
    processedReports.push(presentReport(report, user));
  }
  return processedReports;
}

async function findLinkageCandidates(processed, user) {
  const patientToken = processed.extractedFields?.patient?.patientToken || "";
  const caseRecordId = processed.caseRecordId || "";
  const sourceHash = processed.sourceHash || "";
  const orFilters = [
    sourceHash ? { sourceHash } : null,
    caseRecordId ? { caseRecordId } : null,
    patientToken ? { "extractedFields.patient.patientToken": patientToken } : null
  ].filter(Boolean);

  if (!orFilters.length) return [];
  const filter = { $or: orFilters };
  if (user.role !== "super_admin") {
    filter.createdByUserId = user.id;
  }
  return Report.find(filter).sort({ createdAt: -1 }).limit(50);
}

async function loadFixtureFiles(requested) {
  const names = requested.length ? requested : [
    "ADR_Form_35.pdf",
    "ADR_Form_34.pdf",
    "ADR_Form_44.pdf",
    "sheet-output.csv"
  ];
  const allowed = await fs.readdir(FIXTURE_DIR);
  const files = [];

  for (const name of names) {
    const baseName = path.basename(name);
    if (!allowed.includes(baseName)) {
      throw requestError(`Fixture not found: ${baseName}`, 404);
    }
    const fullPath = path.join(FIXTURE_DIR, baseName);
    const buffer = await fs.readFile(fullPath);
    files.push({
      originalname: baseName,
      mimetype: mimeForPath(baseName),
      size: buffer.length,
      buffer
    });
  }

  return files;
}

async function writeAuditEvent({ actorId, actorRole, action, entityType, entityId, metadata }) {
  try {
    await AuditEvent.create({ actorId: actorId || null, actorRole: actorRole || "", action, entityType: entityType || "", entityId: entityId || "", metadata: metadata || {} });
  } catch (_err) {
    // Audit failures must never break the primary flow
  }
}

function mimeForPath(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".csv") return "text/csv";
  if (extension === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === ".xls") return "application/vnd.ms-excel";
  if (extension === ".json") return "application/json";
  if (extension === ".xml") return "application/xml";
  if (extension === ".txt") return "text/plain";
  return "application/octet-stream";
}
