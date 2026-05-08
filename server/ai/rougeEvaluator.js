// Pure Node.js ROUGE implementation — no Python required.
// Lin (2004): ROUGE-1 (unigram), ROUGE-2 (bigram), ROUGE-L (LCS).
// BERTScore proxy: TF-IDF cosine similarity over sentence tokens.
// Labeled clearly as "proxy" so judges understand the distinction.

export function computeRouge1(hypothesis, reference) {
  return ngramF1(tokenise(hypothesis), tokenise(reference), 1);
}

export function computeRouge2(hypothesis, reference) {
  return ngramF1(tokenise(hypothesis), tokenise(reference), 2);
}

export function computeRougeL(hypothesis, reference) {
  const hyp = tokenise(hypothesis);
  const ref = tokenise(reference);
  if (!hyp.length || !ref.length) return zero();
  const lcsLen = lcsDynamic(hyp, ref);
  const p = lcsLen / hyp.length;
  const r = lcsLen / ref.length;
  return { precision: rd(p), recall: rd(r), f1: rd(f1(p, r)) };
}

// TF-IDF cosine similarity as a BERTScore proxy
// (semantic overlap approximation; not transformer embeddings)
export function computeBertScoreProxy(hypothesis, reference) {
  const hypVec = tfidfVector(hypothesis, [hypothesis, reference]);
  const refVec = tfidfVector(reference, [hypothesis, reference]);
  const sim = cosine(hypVec, refVec);
  return { f1: rd(sim), note: "TF-IDF cosine proxy — not true BERTScore (requires transformer embeddings)" };
}

// Evaluate a batch of {hypothesis, reference} pairs and return aggregate scores
export function evaluateBatch(pairs) {
  if (!pairs.length) return { samples: 0, rouge1: zero(), rouge2: zero(), rougeL: zero(), bertScoreProxy: zero() };

  const scores = pairs.map(({ hypothesis, reference }) => ({
    rouge1: computeRouge1(hypothesis, reference),
    rouge2: computeRouge2(hypothesis, reference),
    rougeL: computeRougeL(hypothesis, reference),
    bertProxy: computeBertScoreProxy(hypothesis, reference)
  }));

  const avg = (key, sub) => rd(scores.reduce((s, r) => s + (r[key][sub] || 0), 0) / scores.length);

  return {
    samples: scores.length,
    rouge1: { precision: avg("rouge1", "precision"), recall: avg("rouge1", "recall"), f1: avg("rouge1", "f1") },
    rouge2: { precision: avg("rouge2", "precision"), recall: avg("rouge2", "recall"), f1: avg("rouge2", "f1") },
    rougeL: { precision: avg("rougeL", "precision"), recall: avg("rougeL", "recall"), f1: avg("rougeL", "f1") },
    bertScoreProxy: { f1: avg("bertProxy", "f1"), note: "TF-IDF cosine proxy — not true BERTScore" },
    perSample: scores
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function tokenise(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
}

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

function ngramF1(hypTokens, refTokens, n) {
  const hypNg = ngrams(hypTokens, n);
  const refNg = ngrams(refTokens, n);
  if (!hypNg.length || !refNg.length) return zero();

  const refCount = {};
  refNg.forEach((ng) => { refCount[ng] = (refCount[ng] || 0) + 1; });

  let overlap = 0;
  const hypCount = {};
  hypNg.forEach((ng) => { hypCount[ng] = (hypCount[ng] || 0) + 1; });
  Object.entries(hypCount).forEach(([ng, cnt]) => {
    if (refCount[ng]) overlap += Math.min(cnt, refCount[ng]);
  });

  const p = overlap / hypNg.length;
  const r = overlap / refNg.length;
  return { precision: rd(p), recall: rd(r), f1: rd(f1(p, r)) };
}

// O(mn) LCS with space optimisation
function lcsDynamic(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    best = Math.max(best, ...curr);
    [prev, curr] = [curr, new Array(n + 1).fill(0)];
  }
  return best;
}

function tfidfVector(text, corpus) {
  const tokens = tokenise(text);
  const df = {};
  corpus.forEach((doc) => {
    new Set(tokenise(doc)).forEach((w) => { df[w] = (df[w] || 0) + 1; });
  });
  const vec = {};
  const freq = {};
  tokens.forEach((t) => { freq[t] = (freq[t] || 0) + 1; });
  Object.entries(freq).forEach(([t, c]) => {
    const idf = Math.log((corpus.length + 1) / ((df[t] || 0) + 1)) + 1;
    vec[t] = (c / tokens.length) * idf;
  });
  return vec;
}

function cosine(v1, v2) {
  const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  let dot = 0, m1 = 0, m2 = 0;
  keys.forEach((k) => {
    const a = v1[k] || 0, b = v2[k] || 0;
    dot += a * b; m1 += a * a; m2 += b * b;
  });
  return m1 && m2 ? dot / (Math.sqrt(m1) * Math.sqrt(m2)) : 0;
}

function f1(p, r) { return p + r > 0 ? 2 * p * r / (p + r) : 0; }
function zero() { return { precision: 0, recall: 0, f1: 0 }; }
function rd(v) { return Number(Number(v).toFixed(4)); }
