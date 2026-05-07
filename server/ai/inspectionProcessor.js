// CDSCO Inspection Report Processor
// Converts uploaded inspection documents (typed PDFs, text files, structured notes)
// into formal CDSCO inspection report drafts.
//
// Pipeline:
//   parsed text → section detection → observation extraction →
//   deficiency classification (Critical/Major/Minor) → template population

// ── CDSCO Inspection Template Schema ─────────────────────────────────────────
export const INSPECTION_TEMPLATE = {
  sections: [
    { id: "site_info", title: "1. Site and Organisation Information", fields: ["site_name", "licence_number", "product_category", "inspection_date", "inspector_names"] },
    { id: "manufacturing", title: "2. Manufacturing Process", fields: ["process_description", "batch_records", "validation_status", "deviations"] },
    { id: "quality_control", title: "3. Quality Control and Testing", fields: ["qc_procedures", "oos_results", "stability_testing", "laboratory_conditions"] },
    { id: "premises", title: "4. Premises and Environmental Controls", fields: ["cleanliness", "hvac_status", "contamination_controls", "pest_control"] },
    { id: "equipment", title: "5. Equipment Qualification and Calibration", fields: ["equipment_list", "calibration_status", "maintenance_records", "qualification_documents"] },
    { id: "personnel", title: "6. Personnel Competence and Training", fields: ["qualification_records", "training_status", "authorised_personnel", "hygiene_practices"] },
    { id: "documentation", title: "7. Documentation and SOPs", fields: ["sop_availability", "sop_adherence", "record_keeping", "version_control"] },
    { id: "deficiencies", title: "8. Observations and Deficiencies", fields: ["critical", "major", "minor"] }
  ]
};

// ── Deficiency Classification Rules ──────────────────────────────────────────
const CRITICAL_PATTERNS = [
  /contaminat\w+/i,
  /sterility\s+(failure|breach|compromise)/i,
  /pathogen\w*/i,
  /adulterat\w+/i,
  /immediate\s+(risk|harm|danger|threat)/i,
  /microbiolog\w+\s+(failure|contaminat\w+)/i,
  /data\s+(falsif\w+|integrity\s+failure|manipulat\w+)/i,
  /unauthorised\s+(product|batch|release)/i,
  /cross.contaminat\w+/i,
  /recall\s+required/i
];

const MAJOR_PATTERNS = [
  /\bdeviat\w+/i,
  /sop\s+(not\s+followed|non.complian\w+|absent|missing|outdated)/i,
  /calibrat\w+\s+(overdue|expired|not\s+done|failed)/i,
  /out.of.specification/i,
  /\boos\b/i,
  /batch\s+record\s+(incomplete|missing|error)/i,
  /validation\s+(not\s+performed|expired|incomplete|missing)/i,
  /training\s+(not\s+completed|overdue|missing|inadequate)/i,
  /temperature\s+(excursion|deviation|non.complian\w+)/i,
  /equipment\s+(not\s+qualified|unqualified|out.of.service)/i,
  /unauthorised\s+(access|personnel)/i,
  /pest\s+(infestation|activity)/i
];

const MINOR_PATTERNS = [
  /documentation\s+(gap|error|incomplete|minor)/i,
  /label(l?ing)?\s+(error|discrepancy|minor)/i,
  /housekeeping/i,
  /minor\s+(observation|finding|discrepancy)/i,
  /record\s+(not\s+signed|unsigned|incomplete\s+date)/i,
  /cosmetic\s+(damage|issue)/i,
  /signage\s+(missing|incorrect)/i,
  /sop\s+(minor\s+update|version\s+not\s+current)/i
];

// Section keywords for mapping observations to template sections
const SECTION_KEYWORDS = {
  manufacturing: ["batch", "manufacturing", "production", "process", "synthesis", "formulation", "filling"],
  quality_control: ["qc", "quality control", "testing", "laboratory", "lab", "oos", "specification", "stability"],
  premises: ["premises", "facility", "room", "area", "environment", "hvac", "air", "water", "pest", "cleanliness"],
  equipment: ["equipment", "instrument", "calibration", "qualification", "maintenance", "iq", "oq", "pq"],
  personnel: ["personnel", "staff", "training", "competence", "qualification", "hygiene", "gown"],
  documentation: ["sop", "document", "record", "procedure", "version", "signature", "log", "data"]
};

export function processInspectionDocument(text, options = {}) {
  if (!text || text.trim().length < 30) {
    return { error: "Insufficient text for inspection report generation.", template: buildEmptyTemplate() };
  }

  const observations = extractObservations(text);
  const classified = classifyObservations(observations);
  const populated = populateTemplate(text, classified);
  const summary = buildDeficiencySummary(classified);

  return {
    status: "processed",
    sourceLength: text.length,
    observationsExtracted: observations.length,
    template: populated,
    deficiencySummary: summary,
    recommendation: deriveRecommendation(classified),
    processingNote: "Template populated from document text. Handwritten OCR requires Tesseract/TrOCR integration for image inputs."
  };
}

// ── Observation extraction ────────────────────────────────────────────────────
function extractObservations(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 15);
  const observations = [];

  lines.forEach((line, idx) => {
    // Numbered observations: "1.", "Obs 1:", "Finding:", "Observation:"
    const isNumbered = /^(\d+[\.\):]|\-|\*|obs(ervation)?\s*\d*\s*[:.]|finding\s*\d*\s*[:.:])/i.test(line);
    const hasSentinel = /\b(noted|observed|found|identified|detected|missing|absent|deficient|non.complian|inadequate|failure|failed|not\s+done|not\s+available|overdue)\b/i.test(line);

    if (isNumbered || hasSentinel) {
      observations.push({ text: line, lineIndex: idx });
    }
  });

  // If no structured observations found, treat all substantial lines as observations
  if (observations.length === 0) {
    lines.filter((l) => l.length > 30).forEach((line, idx) => {
      observations.push({ text: line, lineIndex: idx });
    });
  }

  return observations.slice(0, 50); // cap at 50 observations
}

// ── Deficiency classification ─────────────────────────────────────────────────
function classifyObservations(observations) {
  return observations.map((obs) => {
    const text = obs.text;
    let severity = "minor";
    let matchedPattern = null;

    if (CRITICAL_PATTERNS.some((p) => { const m = p.test(text); if (m) matchedPattern = p.source; return m; })) {
      severity = "critical";
    } else if (MAJOR_PATTERNS.some((p) => { const m = p.test(text); if (m) matchedPattern = p.source; return m; })) {
      severity = "major";
    } else {
      MINOR_PATTERNS.some((p) => { const m = p.test(text); if (m) matchedPattern = p.source; return m; });
    }

    const section = detectSection(text);
    return { ...obs, severity, section, matchedPattern };
  });
}

function detectSection(text) {
  const lower = text.toLowerCase();
  for (const [section, keywords] of Object.entries(SECTION_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return section;
  }
  return "documentation";
}

// ── Template population ───────────────────────────────────────────────────────
function populateTemplate(text, classified) {
  const sections = {};

  INSPECTION_TEMPLATE.sections.forEach(({ id, title, fields }) => {
    if (id === "deficiencies") {
      sections[id] = {
        title,
        critical: classified.filter((o) => o.severity === "critical").map((o) => o.text),
        major: classified.filter((o) => o.severity === "major").map((o) => o.text),
        minor: classified.filter((o) => o.severity === "minor").map((o) => o.text)
      };
    } else {
      const relevantObs = classified
        .filter((o) => o.section === id)
        .map((o) => o.text);

      sections[id] = {
        title,
        observations: relevantObs,
        extractedText: extractSectionText(text, id),
        status: relevantObs.length > 0 ? "observations-found" : "no-observations"
      };
    }
  });

  return sections;
}

function extractSectionText(text, sectionId) {
  const keywords = SECTION_KEYWORDS[sectionId] || [];
  if (!keywords.length) return "";

  const lines = text.split(/\n+/);
  const relevant = lines.filter((line) =>
    keywords.some((kw) => line.toLowerCase().includes(kw))
  );
  return relevant.slice(0, 3).join(" ").trim().slice(0, 300) || "";
}

function buildDeficiencySummary(classified) {
  const critical = classified.filter((o) => o.severity === "critical");
  const major = classified.filter((o) => o.severity === "major");
  const minor = classified.filter((o) => o.severity === "minor");

  return {
    totalObservations: classified.length,
    critical: critical.length,
    major: major.length,
    minor: minor.length,
    criticalItems: critical.map((o) => o.text),
    majorItems: major.map((o) => o.text),
    minorItems: minor.map((o) => o.text)
  };
}

function deriveRecommendation(classified) {
  const critical = classified.filter((o) => o.severity === "critical").length;
  const major = classified.filter((o) => o.severity === "major").length;

  if (critical > 0) return { label: "Reject / Immediate Action Required", tone: "red", reason: `${critical} critical observation(s) identified — immediate corrective action required before any regulatory approval.` };
  if (major >= 3) return { label: "Major Non-Compliance — CAPA Required", tone: "amber", reason: `${major} major observation(s) — comprehensive CAPA with timeline required.` };
  if (major > 0) return { label: "Conditional Approval — CAPA Required", tone: "amber", reason: `${major} major observation(s) — CAPA with defined timeline required.` };
  return { label: "Acceptable with Minor Observations", tone: "green", reason: `No critical or major findings. ${classified.filter((o) => o.severity === "minor").length} minor observation(s) to be addressed in next cycle.` };
}

function buildEmptyTemplate() {
  const sections = {};
  INSPECTION_TEMPLATE.sections.forEach(({ id, title }) => {
    sections[id] = { title, observations: [], status: "pending" };
  });
  return sections;
}
