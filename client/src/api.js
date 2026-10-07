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

async function requestBlob(path, options = {}) {
  const token = getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Request failed: ${response.status}`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "adra-reports-export";
  return { blob, filename };
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
  demoLogin: (kind) => authenticate("/api/auth/demo-login", { kind }),
  me: () => request("/api/auth/me"),
  register: (payload) => authenticate("/api/auth/register", payload),
  signup: (payload) => authenticate("/api/auth/signup", payload),
  ingestFixtures: (files = [], source = "ocr") => request("/api/intake/fixtures", { method: "POST", body: { files, source } }),
  sidecarHealth: () => request("/api/health/sidecar"),
  listReports: (cursor = "", limit = 25) => request(`/api/reports?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  exportReports: (format = "csv", includeDuplicates = false) => requestBlob(`/api/reports/export?format=${encodeURIComponent(format)}${includeDuplicates ? "&includeDuplicates=true" : ""}`),
  removeReport: (reportId, reason = "") => request(`/api/reports/${encodeURIComponent(reportId)}`, { method: "DELETE", body: { reason } }),
  updateReportReview: (reportId, payload) => request(`/api/reports/${encodeURIComponent(reportId)}/review`, { method: "PATCH", body: payload }),
  adminUsers: () => request("/api/admin/users"),
  adminCreateUser: (payload) => request("/api/admin/users", { method: "POST", body: payload }),
  adminUpdateUser: (userId, payload) => request(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: payload }),
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
  annexureReport: () => request("/api/evaluate/annexure"),
  rougeEval: () => request("/api/evaluate/rouge"),
  latencyStats: () => request("/api/health/latency"),
  ragQuery: (query, filters = {}, limit = 8) => request("/api/rag/query", { method: "POST", body: { query, filters, limit } }),
  credibilityAnalyze: (reportIds = [], limit = 50) => request("/api/credibility/analyze", { method: "POST", body: { reportIds, limit } }),
  health: () => request("/api/health")
};
