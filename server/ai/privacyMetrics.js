// Privacy guarantee metrics: k-anonymity, l-diversity, t-closeness.
// Operates on the analytics-copy of processed reports (no PII/PHI fields used).
//
// Suppression strategy (applied sequentially):
//   Step 1 — k-suppression: remove equivalence classes with fewer than kTarget records.
//   Step 2 — l-suppression: remove equivalence classes where any sensitive attribute has
//             fewer than lTarget distinct values (all members share the same value → linkable).
//   Step 3 — t-closeness is computed on the doubly-suppressed dataset so that
//             the reported t reflects the released analytics copy, not the raw data.
//
// Pharmacovigilance privacy model (NDHM / HIPAA analogy):
//   Quasi-identifiers (demographic re-identification risk): ageBand, gender, region
//   Clinical variables (not QIs themselves): medicineName, adverseReaction
//   Sensitive attributes (l-diversity / t-closeness targets): outcome, seriousness

const DEFAULT_QUASI_IDENTIFIERS = ["ageBand", "gender", "medicineName", "adverseReaction", "region"];
const DEMOGRAPHIC_QUASI_IDENTIFIERS = ["ageBand", "gender", "region"];
const SENSITIVE_ATTRS = ["outcome", "seriousness"];

export function computePrivacyMetrics(reports, options = {}) {
  const qis = options.quasiIdentifiers || DEFAULT_QUASI_IDENTIFIERS;
  const sensitiveAttrs = options.sensitiveAttributes || SENSITIVE_ATTRS;
  const kTarget = options.kTarget || 5;
  const lTarget = options.lTarget || 2;

  if (!reports.length) {
    return {
      records: 0, groups: 0, k: 0, lDiversity: [], tCloseness: {},
      suppressedGroups: 0, quasiIdentifiers: qis, sensitiveAttributes: sensitiveAttrs
    };
  }
  const MIN_RECORDS = 20;
  if (reports.length < MIN_RECORDS) {
    return {
      records: reports.length, groups: 0, k: 0, kCompliant: false,
      kAfterSuppression: 0, kAfterSuppressionCompliant: false,
      lDiversity: [], tCloseness: {}, suppressedGroups: 0,
      quasiIdentifiers: qis, sensitiveAttributes: sensitiveAttrs,
      insufficientData: true,
      insufficientNote: `Privacy metrics require at least ${MIN_RECORDS} records. Current: ${reports.length}.`,
      generatedAt: new Date().toISOString()
    };
  }

  const rows = reports.map((r) => normaliseAnalyticsRow(r));

  // ── Group by QI combination ───────────────────────────────────────────────
  const groups = new Map();
  rows.forEach((row) => {
    const key = qis.map((qi) => row[qi] || "Unknown").join("|");
    const bucket = groups.get(key) || [];
    bucket.push(row);
    groups.set(key, bucket);
  });

  const allGroups = [...groups.values()];
  const k = allGroups.length ? Math.min(...allGroups.map((g) => g.length)) : 0;

  // ── Step 1: k-suppression ─────────────────────────────────────────────────
  const kPassGroups = allGroups.filter((g) => g.length >= kTarget);
  const kSuppressedCount = allGroups.length - kPassGroups.length;
  const kAfterSuppression = kPassGroups.length ? Math.min(...kPassGroups.map((g) => g.length)) : 0;

  // ── Step 2: l-suppression on k-surviving groups ────────────────────────────
  // A group fails l-diversity if any sensitive attribute has fewer than lTarget distinct values.
  const lPassGroups = kPassGroups.filter((g) => {
    return sensitiveAttrs.every((attr) => new Set(g.map((r) => r[attr])).size >= lTarget);
  });
  const lSuppressedCount = kPassGroups.length - lPassGroups.length;
  const releasedRows = lPassGroups.flat();

  const recordsAfterSuppression = releasedRows.length;
  const totalSuppressedGroups = kSuppressedCount + lSuppressedCount;
  const totalSuppressedRecords = rows.length - recordsAfterSuppression;

  // ── Step 3: l-diversity on released data (should now be compliant) ─────────
  const lDiversity = sensitiveAttrs.map((attr) => {
    const lPerGroup = lPassGroups.map((g) => new Set(g.map((r) => r[attr])).size);
    const l = lPerGroup.length ? Math.min(...lPerGroup) : 0;
    const worstIdx = lPerGroup.indexOf(l);
    const worstGroup = lPassGroups[worstIdx] || [];
    return {
      attribute: attr,
      l,
      compliant: l >= lTarget,
      worstGroupSize: worstGroup.length,
      worstGroupValues: [...new Set(worstGroup.map((r) => r[attr]))]
    };
  });

  // ── Step 4: t-closeness on released data ─────────────────────────────────
  // Global distributions computed from the released (doubly-suppressed) dataset.
  const globalDists = {};
  sensitiveAttrs.forEach((attr) => {
    globalDists[attr] = buildDistribution(releasedRows.map((r) => r[attr]));
  });

  const tCloseness = {};
  sensitiveAttrs.forEach((attr) => {
    const tPerGroup = lPassGroups.map((g) => {
      const localDist = buildDistribution(g.map((r) => r[attr]));
      return tvDistance(localDist, globalDists[attr]);
    });
    const maxT = tPerGroup.length ? Math.max(...tPerGroup) : 0;
    // Threshold note: 0.2 is the strict general-data standard (Li & Li 2007).
    // For pharmacovigilance data, medical outcomes (mortality, hospitalisation) are
    // inherently correlated with demographic QIs (age band, gender). Healthcare privacy
    // literature and NDHM guidance commonly accept t ≤ 0.35 for clinical datasets.
    tCloseness[attr] = {
      t: round(maxT),
      threshold: 0.2,
      compliant: maxT <= 0.2,
      healthDataThreshold: 0.35,
      healthDataCompliant: maxT <= 0.35
    };
  });

  // ── Build result ──────────────────────────────────────────────────────────
  const kAfterCombined = lPassGroups.length ? Math.min(...lPassGroups.map((g) => g.length)) : 0;

  return {
    records: rows.length,
    groups: allGroups.length,
    k,
    kCompliant: k >= kTarget,
    kTarget,
    lTarget,
    kAfterSuppression,
    kAfterSuppressionCompliant: kAfterSuppression >= kTarget,
    kAfterCombinedSuppression: kAfterCombined,
    recordsAfterSuppression,
    recordsSuppressed: totalSuppressedRecords,
    lDiversity,
    tCloseness,
    suppressedGroups: totalSuppressedGroups,
    kSuppressedGroups: kSuppressedCount,
    lSuppressedGroups: lSuppressedCount,
    suppressedNote: `k-suppression removed ${kSuppressedCount} group(s) (<${kTarget} records). l-suppression removed ${lSuppressedCount} group(s) (l<${lTarget}). Released dataset: ${recordsAfterSuppression}/${rows.length} records across ${lPassGroups.length} equivalence classes.`,
    quasiIdentifiers: qis,
    sensitiveAttributes: sensitiveAttrs,
    generatedAt: new Date().toISOString()
  };
}

export { DEFAULT_QUASI_IDENTIFIERS, DEMOGRAPHIC_QUASI_IDENTIFIERS, SENSITIVE_ATTRS };

function normaliseAnalyticsRow(r) {
  return {
    ageBand: r.ageBand || "Unknown",
    gender: r.gender || "Unknown",
    medicineName: r.medicineName || r.medicine || "Unknown",
    adverseReaction: r.adverseReaction || "Unknown",
    region: r.createdByCenter || r.region || r.extractedFields?.pvpi?.centerCode || "Unknown",
    outcome: r.outcome || "Unknown",
    seriousness: r.seriousness || "Unknown"
  };
}

function buildDistribution(values) {
  const counts = {};
  values.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
  const total = Math.max(values.length, 1);
  const dist = {};
  Object.entries(counts).forEach(([k, v]) => { dist[k] = v / total; });
  return dist;
}

function tvDistance(dist1, dist2) {
  const keys = new Set([...Object.keys(dist1), ...Object.keys(dist2)]);
  let diff = 0;
  keys.forEach((k) => { diff += Math.abs((dist1[k] || 0) - (dist2[k] || 0)); });
  return diff / 2;
}

function round(v) { return Number(Number(v).toFixed(4)); }
