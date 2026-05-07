import { PDFCheckBox, PDFDocument, PDFTextField } from "pdf-lib";
import { cleanValue } from "./textUtils.js";

const TEXT_FIELDS = {
  "Text Field0": "Patient_Initials",
  "Text Field3": "Report_Date",
  "Text Field4": "Region",
  "Text Field5": "Patient_Weight_kg",
  "Text Field7": "MedDRA_PT",
  "Text Field8": "Narrative",
  "Text Field10": "Suspect_Drug",
  "Text Field14": "Drug_Dose_mg",
  "Text Field16": "Drug_Route",
  "Text Field17": "Dose_Frequency",
  "Text Field20": "Indication",
  "Text Field36": "Outcome",
  "Text Field37": "Causality_Assessment",
  "Text Field47": "Reporter_Type",
  "Text Field48": "Onset_Date",
  "Text Field126": "Patient_Age"
};

const CHECKBOX_FIELDS = {
  "Check Box0": ["Patient_Sex", "Male"],
  "Check Box17": ["Patient_Sex", "Female"],
  "Check Box18": ["Patient_Sex", "Other"],
  "Check Box2": ["SAE_Seriousness_Criteria", "Death"],
  "Check Box3": ["SAE_Seriousness_Criteria", "Life-threatening"],
  "Check Box4": ["SAE_Seriousness_Criteria", "Hospitalisation"],
  "Check Box5": ["SAE_Seriousness_Criteria", "Disability/incapacity"],
  "Check Box6": ["SAE_Seriousness_Criteria", "Congenital anomaly"],
  "Check Box7": ["SAE_Seriousness_Criteria", "Other medically important"],
  "Check Box8": ["Outcome", "Recovered"],
  "Check Box9": ["Outcome", "Recovering"],
  "Check Box10": ["Outcome", "Not recovered"],
  "Check Box11": ["Outcome", "Unknown"]
};

export async function extractPdfFormText(buffer) {
  try {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const form = pdf.getForm();
    const values = {};
    let fieldCount = 0;
    let filledFieldCount = 0;

    for (const field of form.getFields()) {
      fieldCount += 1;
      const name = field.getName();
      if (field instanceof PDFTextField && TEXT_FIELDS[name]) {
        const label = TEXT_FIELDS[name];
        const value = cleanFormValue(label, field.getText());
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

    if (!filledFieldCount) {
      return { text: "", fieldCount, filledFieldCount };
    }

    if (!values.Patient_Sex) values.Patient_Sex = "Unknown";
    if (!values.SAE_Seriousness_Criteria) values.SAE_Seriousness_Criteria = "Non-serious";
    const text = [
      "ADRA_MACHINE_READABLE_ADR",
      ...Object.entries(values).map(([label, value]) => `${label}: ${value}`)
    ].join("\n");

    return { text, fieldCount, filledFieldCount };
  } catch (_error) {
    return { text: "", fieldCount: 0, filledFieldCount: 0 };
  }
}

function cleanFormValue(label, value) {
  const cleaned = cleanValue(value);
  if (label === "MedDRA_PT") return cleanValue(cleaned.split(/MedDRA\s+SOC\s*:/i)[0]);
  return cleaned;
}
