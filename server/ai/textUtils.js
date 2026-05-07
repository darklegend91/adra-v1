import crypto from "crypto";

export function cleanText(value) {
  return String(value || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function cleanValue(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/[:|]+$/g, "").trim();
}

export function firstMatch(text, patterns, group = 1) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const pattern of list) {
    const match = text.match(pattern);
    if (match?.[group]) return cleanValue(match[group]);
  }
  return "";
}

export function exactString(value) {
  const cleaned = cleanValue(value);
  const lower = cleaned.toLowerCase();
  const invalid = [
    "date",
    "reaction",
    "mg",
    "reporting form",
    "suspected adverse drug reaction",
    "suspected medication(s)",
    "suspected adverse reaction perit"
  ];
  if (!cleaned || invalid.includes(lower)) return "";
  if (lower.length > 90 && /adr_form|reporting form|sourcefile|traceid/.test(lower)) return "";
  return cleaned;
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function sha256String(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function tokenFor(prefix, value) {
  if (!value) return "";
  return `${prefix.toUpperCase()}_TKN_${sha256String(`${prefix}:${value}`).slice(0, 10).toUpperCase()}`;
}

export function bandAge(age) {
  const value = Number(String(age || "").match(/\d+/)?.[0]);
  if (!value) return "Unknown";
  if (value < 18) return "Under-18";
  if (value <= 35) return "18-35";
  if (value <= 55) return "36-55";
  if (value <= 70) return "56-70";
  return "70+";
}

export function bandWeight(weight) {
  const value = Number(String(weight || "").match(/\d+/)?.[0]);
  if (!value) return "Unknown";
  if (value < 45) return "<45kg";
  if (value <= 65) return "45-65kg";
  if (value <= 85) return "66-85kg";
  return "86kg+";
}
