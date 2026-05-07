// Section-aware document comparison for regulatory documents.
// Returns a structured diff with materiality scoring.
// Policy: semantic comparison (Jaccard + overlap) over naive line diff.

// Common regulatory section heading patterns
const SECTION_RE = /^([\d]+[\.\d]*\s+[A-Z][^:\n]{3,60}|[A-Z][A-Z\s]{4,40}:|Section\s+\w+[^:\n]*)/m;

export function compareDocuments(textA, textB) {
  if (!textA || !textB) {
    return { error: "Both document texts are required." };
  }

  const sectionsA = extractSections(textA);
  const sectionsB = extractSections(textB);

  const allKeys = new Set([...Object.keys(sectionsA), ...Object.keys(sectionsB)]);
  const changes = [];

  allKeys.forEach((section) => {
    const a = (sectionsA[section] || "").trim();
    const b = (sectionsB[section] || "").trim();

    if (!a && b) {
      changes.push({ section, type: "added", before: "", after: b.slice(0, 300), materiality: "high", similarity: 0 });
    } else if (a && !b) {
      changes.push({ section, type: "removed", before: a.slice(0, 300), after: "", materiality: "high", similarity: 0 });
    } else if (a !== b) {
      const similarity = jaccardSimilarity(tokenise(a), tokenise(b));
      const materiality = similarity < 0.6 ? "high" : similarity < 0.85 ? "medium" : "cosmetic";
      const sentenceDiff = diffSentences(a, b);
      changes.push({
        section,
        type: "modified",
        before: a.slice(0, 300),
        after: b.slice(0, 300),
        similarity: round(similarity),
        materiality,
        addedSentences: sentenceDiff.added.slice(0, 3),
        removedSentences: sentenceDiff.removed.slice(0, 3)
      });
    }
  });

  const overallSimilarity = jaccardSimilarity(tokenise(textA), tokenise(textB));
  const materialChanges = changes.filter((c) => c.materiality === "high").length;
  const cosmeticChanges = changes.filter((c) => c.materiality === "cosmetic").length;

  return {
    summary: buildChangeSummary(changes),
    overallSimilarity: round(overallSimilarity),
    changes,
    stats: {
      total: changes.length,
      added: changes.filter((c) => c.type === "added").length,
      removed: changes.filter((c) => c.type === "removed").length,
      modified: changes.filter((c) => c.type === "modified").length,
      materialChanges,
      cosmeticChanges
    },
    materiality: materialChanges > 0 ? "substantive" : changes.length > 0 ? "cosmetic" : "identical",
    sections: { versionA: Object.keys(sectionsA).length, versionB: Object.keys(sectionsB).length }
  };
}

function extractSections(text) {
  // Split on heading-like lines; if no clear sections found, treat whole doc as one
  const lines = text.split(/\n/);
  const sections = {};
  let currentSection = "Introduction";
  let buffer = [];

  lines.forEach((line) => {
    if (SECTION_RE.test(line.trim()) && line.trim().length < 80) {
      if (buffer.length) sections[currentSection] = buffer.join("\n");
      currentSection = line.trim().replace(/\s+/g, " ").slice(0, 60);
      buffer = [];
    } else {
      buffer.push(line);
    }
  });

  if (buffer.length) sections[currentSection] = buffer.join("\n");

  // Fallback: whole doc as single section
  if (Object.keys(sections).length <= 1 && !sections["Introduction"]?.trim()) {
    return { "Document": text };
  }

  return sections;
}

function tokenise(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function jaccardSimilarity(setA, setB) {
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 1;
}

function diffSentences(a, b) {
  const sentA = splitSentences(a);
  const sentB = splitSentences(b);
  const setA = new Set(sentA.map((s) => s.toLowerCase().trim()));
  const setB = new Set(sentB.map((s) => s.toLowerCase().trim()));
  const added = sentB.filter((s) => !setA.has(s.toLowerCase().trim()));
  const removed = sentA.filter((s) => !setB.has(s.toLowerCase().trim()));
  return { added, removed };
}

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 10);
}

function buildChangeSummary(changes) {
  if (!changes.length) return "Documents are identical.";
  const parts = [];
  const added = changes.filter((c) => c.type === "added").length;
  const removed = changes.filter((c) => c.type === "removed").length;
  const modified = changes.filter((c) => c.type === "modified").length;
  const material = changes.filter((c) => c.materiality === "high").length;
  if (added) parts.push(`${added} section(s) added`);
  if (removed) parts.push(`${removed} section(s) removed`);
  if (modified) parts.push(`${modified} section(s) modified`);
  if (material) parts.push(`${material} substantive change(s)`);
  return parts.join(", ") + ".";
}

function round(v) { return Number(Number(v).toFixed(3)); }
