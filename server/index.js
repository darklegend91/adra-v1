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
import User from "./models/User.js";
import AuditEvent from "./models/AuditEvent.js";
import GuidelineProfile from "./models/GuidelineProfile.js";
import { checkSidecarHealth } from "./ai/sidecarClient.js";
import { applyCaseLinkage, classifyCaseRelation } from "./ai/caseLinkage.js";
import { buildMlAnalytics } from "./ai/mlAnalytics.js";
import { computePrivacyMetrics, DEMOGRAPHIC_QUASI_IDENTIFIERS } from "./ai/privacyMetrics.js";
import { summarise, buildChecklistSummary, buildMeetingSummary } from "./ai/summariser.js";
import { runOcr, findPiiBoxes, computeCer, isImageMime } from "./ai/tesseractService.js";
import { evaluateBatch } from "./ai/rougeEvaluator.js";
import { buildAnonymisationSamples, presentReport, processUploadedReport } from "./reportProcessor.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5001);
const JWT_SECRET = process.env.JWT_SECRET || "adra-development-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";
// Fixture directories — each keyed by a short tag used in the API request.
// Set env vars to override the defaults for your machine or CI.
const FIXTURE_DIRS = {
  ocr:   process.env.FIXTURE_DIR      || "/Users/adityapathania/Codes/curin/cdsco/data-csco-ocr",
  adra:  process.env.FIXTURE_DIR_ADRA || "/Users/adityapathania/Codes/ADRA/output/filled_forms/ADRA",
  cdsco: process.env.FIXTURE_DIR_CDSCO|| "/Users/adityapathania/Codes/ADRA/output/filled_forms/CDSCO",
};
// Legacy alias so existing code that references FIXTURE_DIR still works
const FIXTURE_DIR = FIXTURE_DIRS.ocr;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
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

// Sidecar health proxy — lets the frontend show sidecar status without CORS issues
// Always does a live probe — never uses the startup cache.
// This lets the frontend detect when the sidecar starts after the server.
app.get("/api/health/sidecar", async (_req, res) => {
  const { checkSidecarHealth } = await import("./ai/sidecarClient.js");
  const available = await checkSidecarHealth();
  if (!available) {
    return res.json({
      ok: false,
      available: false,
      message: "Python sidecar not running. Start with: npm run dev:sidecar"
    });
  }
  try {
    const sidecarUrl = process.env.SIDECAR_URL || "http://127.0.0.1:7070";
    const resp = await fetch(`${sidecarUrl}/health`);
    const data = await resp.json();
    return res.json({ ok: true, available: true, ...data });
  } catch {
    return res.json({ ok: false, available: false, message: "Sidecar unreachable" });
  }
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
    const filter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
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

// Annexure I offline evaluation snapshot from generated report files.
// This keeps the UI aligned with the latest scripts/* outputs instead of
// duplicating benchmark numbers in React.
app.get("/api/evaluate/annexure", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    const report = await buildAnnexureEvaluationSnapshot();
    return res.json(report);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to load Annexure I evaluation report." });
  }
});

// Credibility analysis — advisory fraud detection, does NOT modify stored data
app.post("/api/credibility/analyze", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const { reportIds = [], limit = 50 } = req.body || {};

    const baseFilter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
    if (reportIds.length) baseFilter._id = { $in: reportIds };

    const reports = await Report.find(baseFilter).limit(limit).lean();
    const sidecarUrl = process.env.SIDECAR_URL || "http://127.0.0.1:7070";
    const sidecarAvail = await import("./ai/sidecarClient.js").then((m) => m.isSidecarAvailable());

    const results = await Promise.all(reports.map(async (r) => {
      const f = r.extractedFields || {};
      const payload = {
        medicine:         r.medicineName || r.medicine || "",
        adverseReaction:  r.adverseReaction || "",
        narrative:        f.clinical?.narrative || "",
        seriousness:      r.seriousness || "",
        severity:         r.severityClass || "",
        age:              f.patient?.age || "",
        weight:           f.patient?.weight || "",
        gender:           r.gender || f.patient?.gender || "",
        onsetDate:        f.clinical?.reactionOnsetDate || "",
        outcome:          r.outcome || f.clinical?.outcome || "",
        dose:             f.clinical?.dose || "",
        route:            f.clinical?.route || "",
        reporter:         f.reporter?.name || f.reporter?.email || "",
      };

      if (sidecarAvail) {
        try {
          const resp = await fetch(`${sidecarUrl}/credibility`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8000),
          });
          if (resp.ok) {
            const cr = await resp.json();
            return { reportId: String(r._id), id: r.reportNumber || String(r._id), medicine: payload.medicine, adverseReaction: payload.adverseReaction, ...cr, source: "sidecar" };
          }
        } catch { /* fall through to JS scoring */ }
      }

      // JS fallback heuristic scoring
      const flags = [];
      const dim = { medical_coherence: 100, completeness: 100, consistency: 100, demographic: 100, narrative_quality: 100 };
      const miss = (v) => !v || ["not extracted","unknown","none","n/a",""].includes(String(v).toLowerCase().trim());

      if (miss(payload.medicine))        { dim.completeness -= 22; flags.push("suspect_drug_missing"); }
      if (miss(payload.adverseReaction)) { dim.completeness -= 22; flags.push("adverse_reaction_missing"); }
      if (miss(payload.reporter))        { dim.completeness -= 22; flags.push("reporter_missing"); }
      if (miss(payload.onsetDate))       { dim.completeness -= 7;  flags.push("onset_date_missing"); }
      if (miss(payload.age))             { dim.completeness -= 7;  flags.push("patient_age_missing"); }
      if (miss(payload.dose))            { dim.completeness -= 7;  flags.push("dose_missing"); }

      const sev = (payload.severity || "").toLowerCase();
      const outcome = (payload.outcome || "").toLowerCase();
      if (sev === "death" && ["recovered","recovering"].includes(outcome)) { dim.consistency -= 30; flags.push("death_class_but_recovered_outcome"); }
      if (sev === "death" && !["death","fatal"].includes((payload.seriousness || "").toLowerCase())) { dim.consistency -= 20; flags.push("death_severity_but_non_fatal_seriousness"); }

      const narr = (payload.narrative || "").trim();
      const words = narr.split(/\s+/).filter(Boolean).length;
      if (!narr)       { dim.narrative_quality -= 45; flags.push("narrative_absent"); }
      else if (words < 8)  { dim.narrative_quality -= 35; flags.push("narrative_too_short"); }
      else if (words < 20) { dim.narrative_quality -= 15; }

      const age = parseFloat(String(payload.age).replace(/[^\d.]/g, ""));
      if (!isNaN(age) && (age < 0 || age > 120)) { dim.demographic -= 45; flags.push("implausible_age_value"); }

      Object.keys(dim).forEach((k) => { dim[k] = Math.max(0, Math.min(100, dim[k])); });
      const weights = { medical_coherence: 0.30, completeness: 0.25, consistency: 0.25, demographic: 0.10, narrative_quality: 0.10 };
      const score = Math.round(Object.entries(weights).reduce((s, [k, w]) => s + dim[k] * w, 0));
      const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D";

      return {
        reportId: String(r._id), id: r.reportNumber || String(r._id),
        medicine: payload.medicine, adverseReaction: payload.adverseReaction,
        score, grade, flags, dimensions: dim, plausiblePair: true,
        summary: flags.length === 0 ? "No concerns detected." : `${flags.length} flag(s) — review recommended.`,
        source: "js-fallback"
      };
    }));

    const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / Math.max(results.length, 1));
    res.json({ results, avgScore, total: results.length, sidecarUsed: sidecarAvail });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || "Credibility analysis failed." });
  }
});

// RAG query — keyword search over ragChunks stored on MongoDB reports
app.post("/api/rag/query", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const { query = "", filters = {}, limit = 8 } = req.body || {};
    if (!query.trim()) return res.status(400).json({ message: "query is required." });

    const baseFilter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
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
app.post("/api/auth/demo-login", async (req, res) => {
  try {
    const kind = String(req.body?.kind || "").trim();
    const demo = kind === "admin"
      ? { name: "Sample Admin", email: "sample.admin@adra.local", password: "SampleAdmin#2026", role: "super_admin", centerName: "ADRA Demo Control", pvpiOfficerNumber: "DEMO-ADMIN" }
      : kind === "reviewer"
        ? { name: "Sample Reviewer", email: "sample.reviewer@adra.local", password: "SampleReviewer#2026", role: "pvpi_member", centerName: "ADRA Demo PvPI Centre", pvpiOfficerNumber: "DEMO-REVIEWER" }
        : null;
    if (!demo) return res.status(400).json({ message: "kind must be admin or reviewer." });

    let user = await findUserByEmail(demo.email);
    if (!user) {
      user = await createUser(demo);
    } else {
      const doc = await findUserDocument(user.id);
      if (doc && (doc.approvalStatus !== "approved" || doc.role !== demo.role)) {
        doc.approvalStatus = "approved";
        doc.role = demo.role;
        doc.centerName = demo.centerName;
        doc.pvpiOfficerNumber = demo.pvpiOfficerNumber;
        await doc.save();
        user = publicUser({ ...doc.toObject(), id: doc._id });
      }
    }

    const cleanUser = publicUser(user);
    const token = signAuthToken(cleanUser, JWT_SECRET, JWT_EXPIRES_IN);
    writeAuditEvent({ actorId: cleanUser.id, actorRole: cleanUser.role, action: "demo_login", entityType: "User", entityId: cleanUser.id, metadata: { email: cleanUser.email, kind } }).catch(() => {});
    return res.json({ token, user: cleanUser });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Demo login failed." });
  }
});

async function handleSignup(req, res) {
  try {
    const payload = sanitiseAuthPayload(req.body);
    const userCount = await User.countDocuments({});
    if (userCount > 0) {
      return res.status(403).json({ message: "Public signup is disabled. A super admin must create member credentials from Admin Dashboard." });
    }
    payload.role = "super_admin";
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

app.post("/api/intake/reports", upload.array("reports"), async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: "At least one report file is required." });
    const { newReports, duplicates } = await processAndStoreFiles(files, user);
    writeAuditEvent({ actorId: user.id, actorRole: user.role, action: "intake_upload", entityType: "Report", entityId: "", metadata: { count: newReports.length, duplicatesDetected: duplicates.length, files: files.map((f) => f.originalname) } }).catch(() => {});
    return res.status(201).json({ count: newReports.length, reports: newReports, duplicatesDetected: duplicates.length, duplicates });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Report intake failed." });
  }
});

app.post("/api/intake/fixtures", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const requested = Array.isArray(req.body?.files) ? req.body.files : [];
    const source = ["ocr", "adra", "cdsco"].includes(req.body?.source) ? req.body.source : "ocr";
    const fixtureFiles = await loadFixtureFiles(requested, source);
    const { newReports, duplicates } = await processAndStoreFiles(fixtureFiles, user);
    writeAuditEvent({ actorId: user.id, actorRole: user.role, action: "intake_fixtures", entityType: "Report", entityId: "", metadata: { count: newReports.length, duplicatesDetected: duplicates.length, fixtures: requested } }).catch(() => {});
    return res.status(201).json({ count: newReports.length, reports: newReports, duplicatesDetected: duplicates.length, duplicates });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Fixture intake failed." });
  }
});

app.get("/api/reports", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const limit = Math.min(Number(req.query.limit || 25), 500);
    const cursor = String(req.query.cursor || "");
    const baseFilter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
    // Exclude duplicates from the main records list — they are stored for audit
    // but shown only as an aggregate count, not as individual records.
    const filter = { ...baseFilter, caseRelation: { $ne: "duplicate" } };
    if (cursor.match(/^[0-9a-fA-F]{24}$/)) filter._id = { $lt: cursor };
    const [reports, duplicateCount] = await Promise.all([
      Report.find(filter).select("+secureReviewToken").sort({ _id: -1 }).limit(limit + 1),
      Report.countDocuments({ ...baseFilter, caseRelation: "duplicate" }),
    ]);
    const hasMore = reports.length > limit;
    const page = hasMore ? reports.slice(0, limit) : reports;
    return res.json({
      reports: page.map((report) => presentReport(report, user)),
      nextCursor: hasMore ? String(page[page.length - 1]._id) : "",
      duplicateCount,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to load reports." });
  }
});

app.get("/api/reports/export", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const format = String(req.query.format || "csv").toLowerCase();
    const includeDuplicates = String(req.query.includeDuplicates || "false") === "true";
    if (!["csv", "json"].includes(format)) {
      return res.status(400).json({ message: "format must be csv or json." });
    }

    const baseFilter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
    const filter = includeDuplicates ? baseFilter : { ...baseFilter, caseRelation: { $ne: "duplicate" } };
    const reports = await Report.find(filter).sort({ _id: -1 }).limit(5000);
    const rows = reports.map((report) => buildReportExportRow(report));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `adra-reports-${timestamp}.${format}`;

    writeAuditEvent({
      actorId: user.id,
      actorRole: user.role,
      action: "reports_export",
      entityType: "Report",
      entityId: "",
      metadata: { format, includeDuplicates, count: rows.length }
    }).catch(() => {});

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, reports: rows }, null, 2));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.send(toCsv(rows));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to export reports." });
  }
});

app.delete("/api/reports/:reportId", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    if (user.role !== "super_admin") {
      return res.status(403).json({ message: "Only super admins can remove reports." });
    }

    const reportId = String(req.params.reportId || "");
    const reason = String(req.body?.reason || "Removed by super admin").trim().slice(0, 500);
    const match = reportId.match(/^[0-9a-fA-F]{24}$/)
      ? { $or: [{ _id: reportId }, { reportNumber: reportId }] }
      : { reportNumber: reportId };
    const report = await Report.findOne({ ...match, ...activeReportFilter() });
    if (!report) return res.status(404).json({ message: "Report not found or already removed." });

    report.removedAt = new Date();
    report.removedByUserId = user.id;
    report.removedByRole = user.role;
    report.removalReason = reason;
    await report.save();

    await writeAuditEvent({
      actorId: user.id,
      actorRole: user.role,
      action: "report_removed",
      entityType: "Report",
      entityId: report.reportNumber,
      metadata: {
        caseRecordId: report.caseRecordId,
        medicine: report.medicineName,
        adverseReaction: report.adverseReaction,
        reason
      }
    });

    return res.json({ ok: true, reportId: report.reportNumber, removedAt: report.removedAt });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to remove report." });
  }
});

app.patch("/api/reports/:reportId/review", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const reportId = String(req.params.reportId || "");
    const status = String(req.body?.status || "").trim();
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const allowedStatuses = new Set(["unreviewed", "needs_followup", "accepted", "not_accepted"]);
    if (!allowedStatuses.has(status)) {
      return res.status(400).json({ message: "status must be unreviewed, needs_followup, accepted, or not_accepted." });
    }

    const match = reportId.match(/^[0-9a-fA-F]{24}$/)
      ? { $or: [{ _id: reportId }, { reportNumber: reportId }] }
      : { reportNumber: reportId };
    const access = user.role === "super_admin" ? {} : { createdByUserId: user.id };
    const report = await Report.findOne({ ...match, ...activeReportFilter(access) }).select("+secureReviewToken");
    if (!report) return res.status(404).json({ message: "Report not found or access denied." });

    const previousStatus = report.humanReviewStatus || "unreviewed";
    const updatedAt = new Date();
    report.humanReviewStatus = status;
    report.humanReviewNote = note;
    report.humanReviewUpdatedAt = updatedAt;
    report.humanReviewUpdatedByUserId = user.id;
    report.humanReviewUpdatedByRole = user.role;
    report.humanReviewHistory = [
      ...(report.humanReviewHistory || []),
      {
        status,
        previousStatus,
        note,
        updatedAt: updatedAt.toISOString(),
        updatedByUserId: user.id,
        updatedByRole: user.role
      }
    ].slice(-50);
    await report.save();

    await writeAuditEvent({
      actorId: user.id,
      actorRole: user.role,
      action: "report_human_review",
      entityType: "Report",
      entityId: report.reportNumber,
      metadata: { previousStatus, status, notePresent: Boolean(note) }
    });

    return res.json({ report: presentReport(report, user) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to update human review status." });
  }
});

// Reviewer priority queue — reports ordered by urgency with explainability
app.get("/api/reviewer/queue", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const filter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
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
    const filter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
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
    const filter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(500);
    const metrics = computePrivacyMetrics(reports, { quasiIdentifiers: DEMOGRAPHIC_QUASI_IDENTIFIERS });
    return res.json(metrics);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to compute privacy metrics." });
  }
});

// Anonymisation samples derived from real processed reports
app.get("/api/anonymisation/samples", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    const filter = activeReportFilter(user.role === "super_admin" ? {} : { createdByUserId: user.id });
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
    if (!isImageMime(req.file.mimetype)) {
      return res.status(415).json({ message: "OCR endpoint accepts raster images only. Upload PNG, JPEG, TIFF, BMP, WebP, or GIF." });
    }

    const ocr = await runOcr(req.file.buffer);
    if (ocr.error) {
      return res.status(415).json({ message: ocr.error });
    }
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

app.get("/api/admin/users", async (req, res) => {
  try {
    const user = publicUser(await getAuthenticatedUser(req));
    if (user.role !== "super_admin") {
      return res.status(403).json({ message: "User management requires super_admin role." });
    }

    const users = await User.find({}).sort({ createdAt: -1 }).limit(500);
    const reportCounts = await Report.aggregate([
      { $match: activeReportFilter() },
      { $group: { _id: "$createdByUserId", reports: { $sum: 1 } } }
    ]);
    const counts = new Map(reportCounts.map((row) => [String(row._id), row.reports]));

    return res.json({
      users: users.map((u) => ({
        id: u.appUserId || String(u._id),
        name: u.name,
        email: u.email,
        role: u.role,
        centerName: u.centerName || "",
        pvpiOfficerNumber: u.pvpiOfficerNumber || "",
        approvalStatus: u.approvalStatus || "approved",
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        reportCount: counts.get(String(u.appUserId || u._id)) || counts.get(String(u._id)) || 0
      }))
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to load users." });
  }
});

app.post("/api/admin/users", async (req, res) => {
  try {
    const actor = publicUser(await getAuthenticatedUser(req));
    if (actor.role !== "super_admin") {
      return res.status(403).json({ message: "Only super admins can create member credentials." });
    }
    const payload = sanitiseAuthPayload({ ...req.body, role: "pvpi_member" });
    const existingUser = await findUserByEmail(payload.email);
    if (existingUser) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }
    const created = await createUser(payload);
    const clean = publicUser(created);
    await writeAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "user_created",
      entityType: "User",
      entityId: clean.id,
      metadata: { email: clean.email, role: clean.role, centerName: payload.centerName }
    });
    return res.status(201).json({ user: clean });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to create user." });
  }
});

app.patch("/api/admin/users/:userId", async (req, res) => {
  try {
    const actor = publicUser(await getAuthenticatedUser(req));
    if (actor.role !== "super_admin") {
      return res.status(403).json({ message: "Only super admins can manage users." });
    }

    const targetId = String(req.params.userId || "");
    const target = await findUserDocument(targetId);
    if (!target) return res.status(404).json({ message: "User not found." });
    if (String(target._id) === String(actor.id) && req.body?.approvalStatus && req.body.approvalStatus !== "approved") {
      return res.status(400).json({ message: "Super admins cannot disable their own account." });
    }

    const allowedStatus = ["pending", "approved", "rejected"];
    if (req.body?.approvalStatus && allowedStatus.includes(req.body.approvalStatus)) target.approvalStatus = req.body.approvalStatus;
    if (req.body?.centerName !== undefined) target.centerName = String(req.body.centerName || "").trim();
    if (req.body?.pvpiOfficerNumber !== undefined) target.pvpiOfficerNumber = String(req.body.pvpiOfficerNumber || "").trim();
    if (req.body?.name !== undefined) target.name = String(req.body.name || "").trim() || target.name;
    await target.save();

    await writeAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "user_updated",
      entityType: "User",
      entityId: String(target._id),
      metadata: {
        email: target.email,
        approvalStatus: target.approvalStatus,
        centerName: target.centerName,
        pvpiOfficerNumber: target.pvpiOfficerNumber
      }
    });

    return res.json({ user: publicUser(target) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to update user." });
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

// Serve built frontend only when the dist folder exists (local full-stack mode).
// On Render (API-only deployment), client/dist won't be present — skip silently.
const clientDist = path.join(rootDir, "client", "dist");

app.use("/api", (_req, res) => {
  res.status(404).json({ message: "API route not found." });
});

if (existsSync(clientDist)) {
  app.use("/assets", express.static(path.join(clientDist, "assets"), {
    immutable: true,
    maxAge: "1y"
  }));
  app.use(express.static(clientDist, {
    index: false,
    maxAge: 0
  }));
  app.get(/.*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Multer error handler — converts file-upload errors to clean JSON responses
// so "Too many files" and "File too large" don't print raw stack traces.
app.use((err, _req, res, next) => {
  if (err?.name === "MulterError") {
    const messages = {
      LIMIT_FILE_COUNT: "Too many files for this server request. Split the batch and try again.",
      LIMIT_FILE_SIZE:  "File too large — maximum 25 MB per file.",
      LIMIT_UNEXPECTED_FILE: "Unexpected file field name.",
    };
    return res.status(400).json({ message: messages[err.code] || `Upload error: ${err.message}` });
  }
  next(err);
});

// Global error handler — catches any unhandled sync/async errors in routes/static assets.
app.use((err, _req, res, _next) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({ message: err.message || "Internal server error." });
});

await ensureMongoConnection();
await checkSidecarHealth();   // non-blocking — logs result, sets availability flag

// Bind to 0.0.0.0 so Render (and other cloud hosts) can route traffic to the process.
// "127.0.0.1" only accepts loopback connections and will be unreachable on Render.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ADRA API running on port ${PORT} (host 0.0.0.0)`);
});

async function buildAnnexureEvaluationSnapshot() {
  const [aggregate, severity, rouge, privacy, extraction, duplicates] = await Promise.all([
    readReportJson("annexure_i.json"),
    readReportJson("severity_eval.json"),
    readReportJson("rouge_eval.json"),
    readReportJson("privacy_eval.json"),
    readReportJson("extraction_f1.json"),
    readReportJson("duplicate_eval.json"),
  ]);

  const privacyA = privacy?.strategies?.strategyA;
  const summarisation = rouge?.aggregate ? {
    documentsEvaluated: rouge.aggregate.documents_evaluated,
    rouge1_f: rouge.aggregate.rouge1_f,
    rouge2_f: rouge.aggregate.rouge2_f,
    rougeL_f: rouge.aggregate.rougeL_f,
    bertscore_f1: rouge.aggregate.bertscore_f1,
    method: rouge.aggregate.method,
    note: rouge.aggregate.note,
  } : aggregate?.summarisation || null;

  const privacyMetrics = privacyA ? {
    strategy: privacyA.label,
    totalRows: privacy.totalRows,
    kAnonymity: privacyA.kAnonymity,
    lDiversity: privacyA.lDiversity,
    tCloseness: privacyA.tCloseness,
    recommendation: privacy.recommendation,
  } : aggregate?.privacyMetrics || null;

  return {
    generatedAt: new Date().toISOString(),
    title: "ADRA Annexure I - Technical Evaluation Report",
    dataset: {
      name: severity?.dataset || privacy?.dataset || duplicates?.dataset || "ADRA_Synthetic_Evaluation_Dataset.xlsx",
      rows: severity?.totalRows || privacy?.totalRows || extraction?.totalRows || null,
      duplicatePairs: duplicates?.labelledPairs || null,
    },
    sources: {
      aggregateGeneratedAt: aggregate?.generatedAt || null,
      severityGeneratedAt: severity?.generatedAt || null,
      rougeGeneratedAt: rouge?.generatedAt || null,
      privacyGeneratedAt: privacy?.generatedAt || null,
      extractionGeneratedAt: extraction?.generatedAt || null,
      duplicateGeneratedAt: duplicates?.generatedAt || null,
    },
    summarisation,
    severityClassifier: severity || aggregate?.severityClassifier || null,
    privacyMetrics,
    extractionF1: extraction || aggregate?.extractionF1 || null,
    duplicateDetection: duplicates || aggregate?.duplicateDetection || null,
    aggregateStatus: severity
      ? "Per-metric reports loaded from reports/. Severity uses reports/severity_eval.json."
      : "Aggregate report loaded, but reports/severity_eval.json was not found.",
  };
}

async function readReportJson(filename) {
  try {
    const raw = await fs.readFile(path.join(rootDir, "reports", filename), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildReportExportRow(report) {
  const latestScore = report.scoreSnapshots?.[report.scoreSnapshots.length - 1] || {};
  const route = isMissingRequiredReportValue(report.medicineName) || isMissingRequiredReportValue(report.adverseReaction)
    ? "needs_followup"
    : latestScore.route || "";
  const medicine = isMissingRequiredReportValue(report.medicineName) ? "" : report.medicineName || "";
  const adverseReaction = isMissingRequiredReportValue(report.adverseReaction) ? "" : report.adverseReaction || "";
  return {
    reportId: report.reportNumber,
    caseRecordId: report.caseRecordId,
    relation: report.caseRelation,
    processingStatus: report.processingStatus,
    route,
    humanReviewStatus: report.humanReviewStatus || "unreviewed",
    humanReviewNote: report.humanReviewNote || "",
    humanReviewUpdatedAt: report.humanReviewUpdatedAt?.toISOString?.() || "",
    humanReviewUpdatedByRole: report.humanReviewUpdatedByRole || "",
    score: latestScore.score || 0,
    confidence: report.confidence?.overall || 0,
    severityClass: report.severityClass || report.unknownFields?.severityClassification?.class || "others",
    severityBasis: report.unknownFields?.severityClassification?.basis || "",
    medicine,
    adverseReaction,
    seriousness: report.seriousness || "",
    outcome: report.outcome || "",
    gender: report.gender || "",
    ageBand: report.ageBand || "",
    weightBand: report.weightBand || "",
    missingFields: (latestScore.missingFields || []).join("; "),
    piiFindings: report.privacyFindings?.length || 0,
    sourceName: report.sourceMetadata?.originalName || report.sourceMetadata?.filename || "",
    parser: report.sourceMetadata?.parser || "",
    center: report.createdByCenter || "",
    createdByRole: report.createdByRole || "",
    reportDate: report.extractedFields?.pvpi?.receivedAt || "",
    createdAt: report.createdAt?.toISOString?.() || "",
    immutable: report.immutable ? "yes" : "no"
  };
}

function toCsv(rows) {
  const headers = [
    "reportId", "caseRecordId", "relation", "processingStatus", "route", "humanReviewStatus", "humanReviewNote", "humanReviewUpdatedAt", "humanReviewUpdatedByRole", "score", "confidence",
    "severityClass", "severityBasis", "medicine", "adverseReaction", "seriousness", "outcome",
    "gender", "ageBand", "weightBand", "missingFields", "piiFindings", "sourceName", "parser",
    "center", "createdByRole", "reportDate", "createdAt", "immutable"
  ];
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  });
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

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

function activeReportFilter(base = {}) {
  return { ...base, removedAt: null };
}

function isMissingRequiredReportValue(value) {
  const cleaned = String(value || "").trim().toLowerCase();
  return !cleaned || ["not extracted", "unknown", "n/a", "na", "none", "null", "-"].includes(cleaned) || /^\(?[a-z]\)?\s*[*x×.\-]*$/.test(cleaned);
}

async function findUserDocument(id) {
  const conditions = [{ appUserId: id }];
  if (String(id).match(/^[0-9a-fA-F]{24}$/)) conditions.push({ _id: id });
  return User.findOne({ $or: conditions });
}

async function processAndStoreFiles(files, user) {
  const newReports = [];
  const duplicates = [];
  const batchCandidates = [];

  for (const file of files) {
    const processed = await processUploadedReport({ file, user });
    const candidates = await findLinkageCandidates(processed, user);
    const linkage = classifyCaseRelation(processed, [...candidates, ...batchCandidates]);
    const linkedReport = applyCaseLinkage(processed, linkage);

    // Always store in MongoDB (audit trail), but separate from display list
    const report = await Report.create(linkedReport);
    batchCandidates.push(report);

    if (linkage.relation === "duplicate") {
      // Record lightweight duplicate metadata — not exposed as a full report
      duplicates.push({
        fileName: file.originalname,
        matchedReport: linkage.matches[0]?.reportNumber ?? "",
        caseRecordId: linkedReport.caseRecordId ?? "",
        basis: linkage.basis,
        format: file.mimetype || "unknown",
      });
    } else {
      newReports.push(presentReport(report, user));
    }
  }

  return { newReports, duplicates };
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
  Object.assign(filter, activeReportFilter());
  return Report.find(filter).sort({ createdAt: -1 }).limit(50);
}

async function loadFixtureFiles(requested, source = "ocr") {
  const dir = FIXTURE_DIRS[source] || FIXTURE_DIRS.ocr;

  // Default files per source when no specific names requested
  const DEFAULT_FILES = {
    ocr:   ["ADR_Form_35.pdf", "ADR_Form_34.pdf", "ADR_Form_44.pdf", "sheet-output.csv"],
    adra:  ["ICSR-SYN-00001.pdf", "ICSR-SYN-00002.pdf", "ICSR-SYN-00003.pdf", "ICSR-SYN-00004.pdf", "ICSR-SYN-00005.pdf"],
    cdsco: ["IND-CDSCO-2021-00001.pdf", "IND-CDSCO-2021-00002.pdf", "IND-CDSCO-2021-00003.pdf", "IND-CDSCO-2021-00004.pdf", "IND-CDSCO-2021-00005.pdf"],
  };
  const names = requested.length ? requested : (DEFAULT_FILES[source] || DEFAULT_FILES.ocr);

  const allowed = await fs.readdir(dir);
  const files = [];

  for (const name of names) {
    const baseName = path.basename(name);
    if (!allowed.includes(baseName)) {
      throw requestError(`Fixture not found in '${source}': ${baseName}`, 404);
    }
    const fullPath = path.join(dir, baseName);
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
