// ADRA document summariser — three source types required by the hackathon:
//   sae      - SAE case narration (ADR reports)
//   checklist - SUGAM application checklist items
//   meeting  - meeting transcript text
//
// Algorithm: TextRank (Mihalcea & Tarau 2004) with Maximal Marginal Relevance (MMR)
// diversity selection. Falls back to TF-IDF scoring for very short documents.
//
// Policy: all output sentences are verbatim source spans.
// No facts are generated, inferred, or paraphrased.

const CLINICAL_KEYWORDS = [
  "adverse", "reaction", "drug", "medication", "dose", "onset", "serious",
  "hospital", "death", "fatal", "report", "patient", "outcome", "recovery",
  "dechallenge", "rechallenge", "causality", "seriousness", "reporter"
];

const CHECKLIST_KEYWORDS = [
  "checklist", "mandatory", "required", "submit", "application", "approval",
  "clinical", "trial", "licence", "import", "biological", "schedule", "annex",
  "deficiency", "missing", "document", "attached", "form", "section"
];

const MEETING_KEYWORDS = [
  "decision", "action", "resolved", "agreed", "pending", "minutes", "agenda",
  "follow-up", "deadline", "responsible", "review", "approved", "noted",
  "assigned", "owner", "next", "step", "discussed", "concluded"
];

const SUMMARY_SCHEMAS = {
  sae: ["Reporter type and region", "Suspect drug and dose", "Adverse reaction and onset", "Seriousness and outcome", "Dechallenge/rechallenge", "Causality assessment"],
  checklist: ["Application type and identifier", "Mandatory fields present/missing", "Key supporting documents", "Deficiencies flagged", "Reviewer action required"],
  meeting: ["Key decisions", "Action items with owners", "Pending items", "Next steps and deadlines"]
};

export function summarise(text, sourceType = "sae", options = {}) {
  if (!text || text.trim().length < 50) return emptyResult(text, sourceType);

  const maxSentences = options.maxSentences || (sourceType === "meeting" ? 5 : 3);
  const sentences = splitSentences(text);

  if (sentences.length <= maxSentences) {
    return {
      summary: text.trim(), sentences: sentences.map((s, i) => ({ text: s, score: 1, sourceIndex: i })),
      sourceType, schema: SUMMARY_SCHEMAS[sourceType] || [],
      method: "full-text", compressionRatio: 100, originalLength: text.length,
      note: "Text short enough to use in full."
    };
  }

  // Use TextRank for documents with enough sentences; TF-IDF otherwise
  const useTextRank = sentences.length >= 6;
  const keywords = domainKeywords(sourceType);

  const scored = useTextRank
    ? textRankScore(sentences, keywords)
    : tfidfScore(sentences, keywords);

  // MMR diversity selection: alternate between relevance and novelty
  const selected = mmrSelect(scored, sentences, maxSentences);
  const topSentences = selected.sort((a, b) => a.index - b.index);
  const summary = topSentences.map((s) => s.sentence).join(". ").replace(/\.\s*\./g, ".").trimEnd();

  return {
    summary: summary.endsWith(".") ? summary : summary + ".",
    sentences: topSentences.map((s) => ({ text: s.sentence, score: round(s.score), sourceIndex: s.index })),
    sourceType,
    schema: SUMMARY_SCHEMAS[sourceType] || [],
    method: useTextRank ? "textrank-mmr" : "tfidf-mmr",
    compressionRatio: Math.round((summary.length / text.length) * 100),
    originalLength: text.length,
    note: "All sentences are verbatim source spans. No facts have been altered or generated."
  };
}

export function buildSaeSummaryFromFields(extractedFields, narrative) {
  const patient = extractedFields?.patient || {};
  const clinical = extractedFields?.clinical || {};
  const reporter = extractedFields?.reporter || {};

  const slots = {
    "Reporter type and region": `Reporter: ${reporter.name || "Unknown"}. Centre: ${extractedFields?.pvpi?.center || "Unknown"}.`,
    "Suspect drug and dose": `Suspect drug: ${clinical.suspectedMedication || "Not extracted"}. Dose: ${clinical.dose || "Not extracted"}. Route: ${clinical.route || "Not extracted"}.`,
    "Adverse reaction and onset": `Reaction: ${clinical.adverseReaction || "Not extracted"}. Onset: ${clinical.reactionOnsetDate || "Not extracted"}.`,
    "Seriousness and outcome": `Seriousness: ${clinical.seriousness || "Not extracted"}. Outcome: ${clinical.outcome || "Not extracted"}.`,
    "Dechallenge/rechallenge": `Dechallenge: ${clinical.dechallenge || "Not documented"}. Rechallenge: ${clinical.rechallenge || "Not documented"}.`,
    "Causality assessment": `WHO-UMC: ${clinical.whoUmcCausality || "Not documented"}. Narrative available: ${Boolean(narrative)}.`
  };

  const structuredSummary = SUMMARY_SCHEMAS.sae.map((slot) => ({ slot, text: slots[slot] || "Not available." }));
  const extractivePart = summarise(narrative, "sae");

  return {
    structuredSummary,
    extractiveSummary: extractivePart.summary,
    method: extractivePart.method,
    sourceType: "sae",
    completeness: Object.values(slots).filter((v) => !v.includes("Not extracted") && !v.includes("Not documented")).length,
    totalSlots: SUMMARY_SCHEMAS.sae.length
  };
}

// ── TextRank ──────────────────────────────────────────────────────────────────
// Build a sentence similarity graph; run power-iteration PageRank.
function textRankScore(sentences, keywords, damping = 0.85, iterations = 30) {
  const n = sentences.length;
  const tfidfVectors = sentences.map((s) => buildTfidfVector(s, sentences));

  // Similarity matrix using cosine similarity of TF-IDF vectors
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(tfidfVectors[i], tfidfVectors[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  // Normalise rows
  const rowSums = sim.map((row) => row.reduce((a, v) => a + v, 0));
  const M = sim.map((row, i) => row.map((v) => (rowSums[i] > 0 ? v / rowSums[i] : 0)));

  // PageRank power iteration
  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const newScores = scores.map((_, i) =>
      (1 - damping) / n + damping * scores.reduce((s, r, j) => s + r * M[j][i], 0)
    );
    scores = newScores;
  }

  // Boost by domain keyword presence
  return sentences.map((sentence, index) => {
    const kwBoost = keywords.filter((kw) => sentence.toLowerCase().includes(kw)).length * 0.15;
    return { sentence, index, score: scores[index] + kwBoost };
  });
}

// ── TF-IDF fallback ───────────────────────────────────────────────────────────
function tfidfScore(sentences, keywords) {
  const wordFreq = buildWordFrequency(sentences.join(" "));
  const idf = buildIdf(sentences);
  return sentences.map((sentence, index) => ({
    sentence, index,
    score: scoreSentenceTfidf(sentence, wordFreq, idf, keywords, index, sentences.length)
  }));
}

// ── MMR (Maximal Marginal Relevance) selection ────────────────────────────────
// Iteratively selects the next sentence that maximises relevance minus redundancy.
function mmrSelect(scored, sentences, k, lambda = 0.6) {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const selected = [sorted[0]];
  const remaining = sorted.slice(1);
  const vectors = sentences.map((s) => buildTfidfVector(s, sentences));

  while (selected.length < k && remaining.length > 0) {
    let bestScore = -Infinity;
    let bestIdx = 0;
    remaining.forEach((candidate, idx) => {
      const relevance = candidate.score;
      const maxRedundancy = Math.max(
        ...selected.map((s) => cosineSimilarity(vectors[candidate.index], vectors[s.index]))
      );
      const mmrScore = lambda * relevance - (1 - lambda) * maxRedundancy;
      if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = idx; }
    });
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

// ── Vector helpers ────────────────────────────────────────────────────────────
function buildTfidfVector(sentence, allSentences) {
  const words = tokenise(sentence);
  const docCount = allSentences.length;
  const vector = {};
  const wordSet = new Set(words);
  wordSet.forEach((w) => {
    const tf = words.filter((t) => t === w).length / Math.max(words.length, 1);
    const df = allSentences.filter((s) => s.toLowerCase().includes(w)).length;
    const idfVal = Math.log((docCount + 1) / (df + 1)) + 1;
    vector[w] = tf * idfVal;
  });
  return vector;
}

function cosineSimilarity(v1, v2) {
  const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  let dot = 0, mag1 = 0, mag2 = 0;
  keys.forEach((k) => {
    const a = v1[k] || 0, b = v2[k] || 0;
    dot += a * b; mag1 += a * a; mag2 += b * b;
  });
  const denom = Math.sqrt(mag1) * Math.sqrt(mag2);
  return denom ? dot / denom : 0;
}

// ── TF-IDF sentence scoring (fallback) ───────────────────────────────────────
function buildWordFrequency(text) {
  const words = tokenise(text);
  const freq = {};
  words.forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
  return freq;
}

function buildIdf(sentences) {
  const docCount = sentences.length;
  const df = {};
  sentences.forEach((s) => {
    new Set(tokenise(s)).forEach((w) => { df[w] = (df[w] || 0) + 1; });
  });
  const idf = {};
  Object.entries(df).forEach(([w, count]) => { idf[w] = Math.log((docCount + 1) / (count + 1)) + 1; });
  return idf;
}

function scoreSentenceTfidf(sentence, wordFreq, idf, keywords, index, total) {
  const words = tokenise(sentence);
  if (!words.length) return 0;
  const tfidfScore = words.reduce((sum, w) => sum + (wordFreq[w] || 0) * (idf[w] || 1), 0) / words.length;
  const keywordBoost = keywords.filter((kw) => sentence.toLowerCase().includes(kw)).length * 1.8;
  const positionScore = index === 0 ? 2.5 : index < total * 0.25 ? 1.5 : index > total * 0.75 ? 0.8 : 1.0;
  const lengthPenalty = words.length < 5 ? 0.5 : words.length > 50 ? 0.8 : 1.0;
  return (tfidfScore + keywordBoost) * positionScore * lengthPenalty;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])|(?<=\n)\s*(?=[A-Z])/)
    .map((s) => s.trim().replace(/\n+/g, " "))
    .filter((s) => s.length > 20);
}

function domainKeywords(sourceType) {
  if (sourceType === "checklist") return CHECKLIST_KEYWORDS;
  if (sourceType === "meeting") return MEETING_KEYWORDS;
  return CLINICAL_KEYWORDS;
}

function tokenise(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

function emptyResult(text, sourceType) {
  return {
    summary: text || "", sentences: [], sourceType, schema: SUMMARY_SCHEMAS[sourceType] || [],
    method: "passthrough", compressionRatio: 100, originalLength: (text || "").length,
    note: "Input too short for extractive summarisation."
  };
}

function round(v) { return Number(Number(v).toFixed(3)); }
