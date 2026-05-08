const API_BASE = import.meta.env.VITE_API_BASE || "";
const TOKEN_KEY = "adra.jwt";

async function request(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.rawBody || (options.body ? JSON.stringify(options.body) : undefined)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed: ${response.status}`);
  return data;
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function authenticate(path, body) {
  const session = await request(path, { method: "POST", body });
  setToken(session.token);
  return session;
}

export const api = {
  clearToken,
  getToken,
  login: (payload) => authenticate("/api/auth/login", payload),
  me: () => request("/api/auth/me"),
  register: (payload) => authenticate("/api/auth/register", payload),
  signup: (payload) => authenticate("/api/auth/signup", payload),
  ingestFixtures: (files = []) => request("/api/intake/fixtures", { method: "POST", body: { files } }),
  listReports: (cursor = "", limit = 25) => request(`/api/reports?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  mlAnalytics: () => request("/api/ml/analytics"),
  privacyMetrics: () => request("/api/privacy-metrics"),
  anonymisationSamples: () => request("/api/anonymisation/samples"),
  auditEvents: (limit = 50) => request(`/api/audit?limit=${limit}`),
  listGuidelines: () => request("/api/guidelines"),
  saveGuideline: (profile) => request("/api/guidelines", { method: "POST", body: profile }),
  summarise: (text, sourceType = "sae", maxSentences) => request("/api/summarise", { method: "POST", body: { text, sourceType, maxSentences } }),
  summariseFile: (file, sourceType = "sae") => {
    const formData = new FormData();
    formData.append("document", file);
    formData.append("sourceType", sourceType);
    return request("/api/summarise", { method: "POST", headers: {}, rawBody: formData });
  },
  compareDocuments: (textA, textB) => request("/api/compare", { method: "POST", body: { textA, textB } }),
  compareFiles: (fileA, fileB) => {
    const fd = new FormData();
    fd.append("docA", fileA);
    fd.append("docB", fileB);
    return request("/api/compare", { method: "POST", headers: {}, rawBody: fd });
  },
  assessCompleteness: (textOrFile) => {
    if (typeof textOrFile === "string") {
      return request("/api/completeness", { method: "POST", body: { text: textOrFile } });
    }
    const fd = new FormData();
    fd.append("document", textOrFile);
    return request("/api/completeness", { method: "POST", headers: {}, rawBody: fd });
  },
  uploadReports: (files) => {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append("reports", file));
    return request("/api/intake/reports", {
      method: "POST",
      headers: {},
      rawBody: formData
    });
  },
  reviewerQueue: () => request("/api/reviewer/queue"),
  rougeEval: () => request("/api/evaluate/rouge"),
  latencyStats: () => request("/api/health/latency"),
  ragQuery: (query, filters = {}, limit = 8) => request("/api/rag/query", { method: "POST", body: { query, filters, limit } }),
  health: () => request("/api/health")
};
