import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs/promises";
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
import { summarise } from "./ai/summariser.js";
import { compareDocuments } from "./ai/documentComparison.js";
import { processInspectionDocument, INSPECTION_TEMPLATE } from "./ai/inspectionProcessor.js";
import { buildAnonymisationSamples, presentReport, processUploadedReport } from "./reportProcessor.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5001);
const JWT_SECRET = process.env.JWT_SECRET || "adra-development-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";
const FIXTURE_DIR = "/Users/adityapathania/Codes/curin/cdsco/data-csco-ocr";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
validateRuntimeConfig();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ADRA prototype API",
    auth: "mongodb"
  });
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

// SAE / checklist / meeting summarisation
app.post("/api/summarise", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    const { text, sourceType = "sae", maxSentences } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ message: "text field is required." });
    }
    const result = summarise(text, sourceType, { maxSentences });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Summarisation failed." });
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

// Document version comparison
app.post("/api/compare", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    const { textA, textB } = req.body || {};
    if (!textA || !textB) {
      return res.status(400).json({ message: "textA and textB are required." });
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

const clientDist = path.join(rootDir, "client", "dist");
app.use(express.static(clientDist));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

await ensureMongoConnection();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`ADRA prototype API running at http://127.0.0.1:${PORT}`);
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
