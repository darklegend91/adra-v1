/**
 * PDF AcroForm field extractor.
 *
 * Strategy A — pdf-lib field tree (standard fillable PDFs).
 * Strategy B — page /Annots walk (pypdf 4-6 generated PDFs that store
 *              field values in widget annotations rather than the AcroForm
 *              field tree).
 *
 * Both strategies map PDF field names to MACHINE_LABEL tokens so that
 * nlpExtractor.machineField() can read them without changes.
 */

import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFRef, PDFTextField } from "pdf-lib";
import { cleanValue } from "./textUtils.js";

// ── Field name → MACHINE_LABEL ────────────────────────────────────────────────
// Strategy A: generic PDF field names used by the standard CDSCO template
const TEXT_FIELDS = {
  "Text Field0":   "Patient_Initials",
  "Text Field3":   "Report_Date",
  "Text Field4":   "Region",
  "Text Field5":   "Patient_Weight_kg",
  // Section 7 — adverse reaction description / SOC+PT block
  "Text Field7":   "MedDRA_PT",
  // Section 8 — narrative / additional information
  "Text Field8":   "Narrative",
  // Section 9 — other medical info / relevant history (allergies, Section 13)
  "Text Field9":   "Other_Medical_Info",
  // Section C — suspect drug (row i)
  "Text Field10":  "Suspect_Drug",
  "Text Field14":  "Drug_Dose_mg",
  "Text Field16":  "Drug_Route",
  "Text Field17":  "Dose_Frequency",
  "Text Field20":  "Indication",
  // Section C — concomitant / suspect drug rows ii and iii
  "Text Field49":  "Concomitant_Drug_1",
  "Text Field50":  "Concomitant_Drug_2",
  // Section 11 — concomitant drug table rows
  "Text Field112": "Concomitant_Drug_3",
  "Text Field113": "Concomitant_Drug_4",
  "Text Field36":  "Outcome",
  "Text Field37":  "Causality_Assessment",
  "Text Field47":  "Reporter_Type",
  "Text Field48":  "Onset_Date",
  "Text Field126": "Patient_Age",
};

// Strategy B: semantic field names used by fill_adr_forms.py
const SEMANTIC_FIELDS = {
  "patient_initials":       "Patient_Initials",
  "patient_age":            "Patient_Age",
  "patient_weight":         "Patient_Weight_kg",
  "region":                 "Region",
  "report_date":            "Report_Date",
  "onset_date":             "Onset_Date",
  "adverse_reaction":       "MedDRA_PT",
  "narrative":              "Narrative",
  "other_info":             "Other_Medical_Info",   // Section 13 — allergies, history
  "drug1_name":             "Suspect_Drug",
  "drug1_dose":             "Drug_Dose_mg",
  "drug1_route":            "Drug_Route",
  "drug1_freq":             "Dose_Frequency",
  "drug1_indication":       "Indication",
  // Concomitant / secondary suspect drugs
  "drug2_name":             "Concomitant_Drug_1",
  "drug3_name":             "Concomitant_Drug_2",
  "con1_name":              "Concomitant_Drug_3",
  "con2_name":              "Concomitant_Drug_4",
  "reaction_outcome":       "Outcome",
  "causality":              "Causality_Assessment",
  "reporter_qualification": "Reporter_Type",
  "reporter_name_address":  "Reporter_Name",
};

const CHECKBOX_FIELDS = {
  "Check Box0":  ["Patient_Sex", "Male"],
  "Check Box17": ["Patient_Sex", "Female"],
  "Check Box18": ["Patient_Sex", "Other"],
  "Check Box2":  ["SAE_Seriousness_Criteria", "Death"],
  "Check Box3":  ["SAE_Seriousness_Criteria", "Life-threatening"],
  "Check Box4":  ["SAE_Seriousness_Criteria", "Hospitalisation"],
  "Check Box5":  ["SAE_Seriousness_Criteria", "Disability/incapacity"],
  "Check Box6":  ["SAE_Seriousness_Criteria", "Congenital anomaly"],
  "Check Box7":  ["SAE_Seriousness_Criteria", "Other medically important"],
  "Check Box8":  ["Outcome", "Recovered"],
  "Check Box9":  ["Outcome", "Recovering"],
  "Check Box10": ["Outcome", "Not recovered"],
  "Check Box11": ["Outcome", "Unknown"],
};

// ── Public API ────────────────────────────────────────────────────────────────

export async function extractPdfFormText(buffer) {
  try {
    const pdf  = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const form = pdf.getForm();

    // Strategy A — standard AcroForm field tree
    const fields = form.getFields();
    if (fields.length > 0) {
      return _extractFromFieldTree(fields, form);
    }

    // Strategy B — page annotation walk (pypdf-generated PDFs)
    return _extractFromAnnotations(pdf);
  } catch (_error) {
    return { text: "", fieldCount: 0, filledFieldCount: 0 };
  }
}

// ── Strategy A: AcroForm field tree (pdf-lib native) ─────────────────────────

function _extractFromFieldTree(fields) {
  const values = {};
  let fieldCount = 0;
  let filledFieldCount = 0;

  for (const field of fields) {
    fieldCount += 1;
    const name = field.getName();

    if (field instanceof PDFTextField && TEXT_FIELDS[name]) {
      const label = TEXT_FIELDS[name];
      const value = _cleanFormValue(label, field.getText());
      if (value) {
        values[label] = value;
        filledFieldCount += 1;
      }
    }

    if (field instanceof PDFCheckBox && CHECKBOX_FIELDS[name] && field.isChecked()) {
      const [label, value] = CHECKBOX_FIELDS[name];
      values[label] = value;
      filledFieldCount += 1;
    }
  }

  return _buildResult(values, fieldCount, filledFieldCount);
}

// ── Strategy B: page annotation walk ─────────────────────────────────────────
// Handles PDFs written by pypdf 4-6 where field values are stored in
// widget annotations (/Annots on each page) rather than the AcroForm field tree.

function _extractFromAnnotations(pdf) {
  const values = {};
  let fieldCount = 0;
  let filledFieldCount = 0;

  for (let pageIdx = 0; pageIdx < pdf.getPageCount(); pageIdx++) {
    const page = pdf.getPage(pageIdx);

    // Get the raw /Annots value (may be a PDFArray or a PDFRef pointing to one)
    const annotRaw = page.node.get(PDFName.of("Annots"));
    if (!annotRaw) continue;

    // Resolve to a PDFArray (it may be an indirect reference)
    const annotArray = annotRaw instanceof PDFArray
      ? annotRaw
      : pdf.context.lookup(annotRaw);
    if (!(annotArray instanceof PDFArray)) continue;

    for (let i = 0; i < annotArray.size(); i++) {
      try {
        const elemRef = annotArray.get(i);
        // Resolve indirect reference
        const annot = elemRef instanceof PDFRef
          ? pdf.context.lookup(elemRef)
          : elemRef;
        if (!(annot instanceof PDFDict)) continue;

        const rawName  = annot.get(PDFName.of("T"));
        const rawValue = annot.get(PDFName.of("V"));
        if (!rawName) continue;

        const fieldName = _decodePdfValue(rawName);
        fieldCount += 1;

        // Text field
        const textLabel = TEXT_FIELDS[fieldName] ?? SEMANTIC_FIELDS[fieldName.toLowerCase()];
        if (textLabel && rawValue) {
          const strVal  = _decodePdfValue(rawValue);
          const cleaned = _cleanFormValue(textLabel, strVal);
          if (cleaned) {
            values[textLabel] = cleaned;
            filledFieldCount += 1;
          }
        }

        // Checkbox
        const cbDef = CHECKBOX_FIELDS[fieldName];
        if (cbDef && rawValue) {
          const strVal = _decodePdfValue(rawValue);
          // Any value other than /Off means the checkbox is ticked
          if (strVal && strVal !== "Off") {
            const [label, value] = cbDef;
            if (!values[label]) {          // first checkbox match wins
              values[label] = value;
              filledFieldCount += 1;
            }
          }
        }
      } catch {
        // malformed annotation — skip silently
      }
    }
  }

  return _buildResult(values, fieldCount, filledFieldCount);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function _buildResult(values, fieldCount, filledFieldCount) {
  if (!filledFieldCount) {
    return { text: "", fieldCount, filledFieldCount };
  }

  if (!values.Patient_Sex)               values.Patient_Sex = "Unknown";
  if (!values.SAE_Seriousness_Criteria)  values.SAE_Seriousness_Criteria = "Non-serious";

  const text = [
    "ADRA_MACHINE_READABLE_ADR",
    ...Object.entries(values).map(([label, value]) => `${label}: ${value}`),
  ].join("\n");

  return { text, fieldCount, filledFieldCount };
}

function _cleanFormValue(label, value) {
  const cleaned = cleanValue(value);
  if (label === "MedDRA_PT") return cleanValue(cleaned.split(/MedDRA\s+SOC\s*:/i)[0]);
  return cleaned;
}

// Decode a pdf-lib PDF object to a plain string.
// Handles PDFString (text fields) and PDFName (checkbox values like /Yes /Off).
function _decodePdfValue(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  // PDFString — text field values, field names
  if (typeof obj.decodeText === "function") return obj.decodeText();
  if (typeof obj.asString   === "function") return obj.asString();
  // PDFName — checkbox values (/Yes, /Off) and boolean-style flags
  if (typeof obj.encodedName === "string")  return obj.encodedName.replace(/^\//, "");
  return String(obj).replace(/^\//, "");
}
