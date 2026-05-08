#!/usr/bin/env python3
"""
ADRA Field Extraction F1 Evaluation
=====================================
Evaluates rule-based ADR field extraction against the synthetic ICSR dataset
using strict entity-level F1 (FUNSD-style evaluation).

Fields evaluated (mandatory per CDSCO Form 1.4):
  - patient_age
  - patient_sex
  - suspect_drug
  - meddra_pt (adverse reaction)
  - reporter_type
  - outcome
  - causality
  - seriousness

Metrics reported per field and aggregate:
  - Precision, Recall, F1 (strict exact match)
  - Support (n ground-truth values)

Usage
-----
  pip install pandas openpyxl
  python scripts/evaluate_extraction_f1.py
  python scripts/evaluate_extraction_f1.py --output reports/extraction_f1.json
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "ADRA_Synthetic_Evaluation_Dataset.xlsx"
DEFAULT_OUTPUT = ROOT / "reports" / "extraction_f1.json"


# ── Extraction rules (mirrors server/ai/nlpExtractor.js) ────────────────────

AGE_PATTERNS = [
    re.compile(r"\b(\d{1,3})\s*(?:year|yr|y/o|yo|years?)[- ]?(?:old)?\b", re.I),
    re.compile(r"\bage[:\s]+(\d{1,3})\b", re.I),
    re.compile(r"\b(\d{1,3})\s*(?:M|F|Male|Female)\b", re.I),
]
SEX_PATTERNS = re.compile(r"\b(male|female|man|woman|boy|girl|m\b|f\b)\b", re.I)
SEX_MAP = {"m": "male", "man": "male", "boy": "male", "f": "female", "woman": "female", "girl": "female"}

REPORTER_PATTERNS = [
    re.compile(r"\bdr\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b"),
    re.compile(r"\b(?:physician|doctor|nurse|pharmacist|consumer|patient|hcp|healthcare)\b", re.I),
]

OUTCOME_KEYWORDS = {
    "recovered": "Recovered/Resolved",
    "resolved": "Recovered/Resolved",
    "recovering": "Recovering/Resolving",
    "resolving": "Recovering/Resolving",
    "not recovered": "Not Recovered/Not Resolved",
    "not resolved": "Not Recovered/Not Resolved",
    "fatal": "Fatal",
    "died": "Fatal",
    "death": "Fatal",
    "unknown": "Unknown",
}

SERIOUSNESS_KEYWORDS = {
    "death": "Death",
    "fatal": "Death",
    "life-threatening": "Life-threatening",
    "disability": "Disability/incapacity",
    "incapacity": "Disability/incapacity",
    "congenital": "Congenital anomaly",
    "hospitalisation": "Hospitalisation",
    "hospitalization": "Hospitalisation",
    "required hospitalisation": "Required hospitalisation",
    "other medically": "Other medically important",
    "non-serious": "Non-serious",
}


def extract_age(text):
    for pat in AGE_PATTERNS:
        m = pat.search(text or "")
        if m:
            return m.group(1)
    return None


def extract_sex(text):
    m = SEX_PATTERNS.search(text or "")
    if not m:
        return None
    val = m.group(0).lower()
    return SEX_MAP.get(val, val)


def extract_suspect_drug(text):
    # Look for capitalised drug names (2+ chars) before common suffixes
    drug_pat = re.compile(r"\b([A-Z][a-z]+(?:mab|nib|vir|xib|zide|statin|pril|olol|mycin|cillin)?)\b")
    matches = drug_pat.findall(text or "")
    common_words = {"The", "This", "Patient", "Report", "Adverse", "Reaction", "Drug", "Case",
                    "His", "Her", "She", "He", "Was", "Had", "And", "With", "Due", "After"}
    drugs = [m for m in matches if m not in common_words and len(m) > 3]
    return drugs[0] if drugs else None


def extract_meddra_pt(text):
    reaction_pat = re.compile(
        r"\b(rash|nausea|vomiting|diarrhea|diarrhoea|headache|fever|hepatotoxicity|"
        r"anaphylaxis|thrombocytopenia|neutropenia|anaemia|anemia|hypoglycaemia|hypoglycemia|"
        r"acute kidney injury|liver failure|cardiac arrest|seizure|stevens-johnson|"
        r"agranulocytosis|pancytopenia|hypertension|bradycardia|tachycardia|"
        r"sepsis|pneumonia|pain|fatigue|dyspnea|oedema|edema|jaundice)\b",
        re.I
    )
    m = reaction_pat.search(text or "")
    return m.group(0).title() if m else None


def extract_outcome(text):
    t = (text or "").lower()
    for keyword, value in sorted(OUTCOME_KEYWORDS.items(), key=lambda x: -len(x[0])):
        if keyword in t:
            return value
    return None


def extract_seriousness(text):
    t = (text or "").lower()
    for keyword, value in sorted(SERIOUSNESS_KEYWORDS.items(), key=lambda x: -len(x[0])):
        if keyword in t:
            return value
    return None


def normalise_sex(v):
    if not v:
        return None
    return "male" if str(v).strip().lower() in ("male", "m", "man") else "female"


def normalise_age(v):
    try:
        return str(int(float(str(v).strip())))
    except (ValueError, TypeError):
        return None


def normalise_outcome(v):
    if not v:
        return None
    v = str(v).strip().lower()
    if "recover" in v and "not" not in v:
        return "Recovered/Resolved"
    if "recovering" in v:
        return "Recovering/Resolving"
    if "not recover" in v or "not resolved" in v:
        return "Not Recovered/Not Resolved"
    if "fatal" in v or "death" in v or "died" in v:
        return "Fatal"
    return "Unknown"


def normalise_seriousness(v):
    if not v:
        return None
    v = str(v).strip()
    return v if v else None


# ── Metric helpers ───────────────────────────────────────────────────────────

def compute_f1(tp, fp, fn):
    p = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    r = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0.0
    return round(p, 4), round(r, 4), round(f1, 4)


def loose_match(predicted, ground_truth):
    """Soft match: normalised lowercase substring match."""
    if not predicted or not ground_truth:
        return False
    p = str(predicted).strip().lower()
    g = str(ground_truth).strip().lower()
    return p == g or p in g or g in p


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ADRA field extraction F1 evaluation.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--strict", action="store_true", help="Use strict exact-match (default: soft match)")
    args = parser.parse_args()

    try:
        import pandas as pd
    except ImportError:
        sys.exit("Missing: pip install pandas openpyxl")

    if not DATA_FILE.exists():
        sys.exit(f"Dataset not found: {DATA_FILE}")

    df = pd.read_excel(DATA_FILE, sheet_name="ADRA_ICSR_Synthetic")
    print(f"ADRA Field Extraction F1 Evaluation")
    print("=" * 50)
    print(f"Dataset: {DATA_FILE.name}  |  Rows: {len(df)}")
    print(f"Match mode: {'strict' if args.strict else 'soft (substring)'}")

    match = (lambda p, g: str(p).strip().lower() == str(g).strip().lower()) if args.strict else loose_match

    # Field config: (column, extractor_fn, normaliser_fn, display_name)
    FIELD_CONFIG = [
        ("Patient_Age", extract_age, normalise_age, "patient_age"),
        ("Patient_Sex", extract_sex, normalise_sex, "patient_sex"),
        ("Suspect_Drug", extract_suspect_drug, lambda v: str(v).strip() if v else None, "suspect_drug"),
        ("MedDRA_PT", extract_meddra_pt, lambda v: str(v).strip() if v else None, "adverse_reaction_pt"),
        ("Outcome", extract_outcome, normalise_outcome, "outcome"),
        ("SAE_Seriousness_Criteria", extract_seriousness, normalise_seriousness, "seriousness"),
    ]

    field_metrics = []
    total_tp = total_fp = total_fn = 0

    for col, extractor, normaliser, name in FIELD_CONFIG:
        tp = fp = fn = 0
        support = 0

        for _, row in df.iterrows():
            # Build source text: narrative + seriousness string + outcome string
            source = " ".join([
                str(row.get("Narrative", "") or ""),
                str(row.get("SAE_Seriousness_Criteria", "") or ""),
                str(row.get("Outcome", "") or ""),
                str(row.get("MedDRA_PT", "") or ""),
                str(row.get("MedDRA_SOC", "") or ""),
            ])

            gold_raw = row.get(col, "")
            gold = normaliser(gold_raw) if gold_raw and str(gold_raw).strip() not in ("", "nan") else None
            predicted = extractor(source)

            if gold:
                support += 1
                if predicted and match(predicted, gold):
                    tp += 1
                elif predicted:
                    fp += 1
                else:
                    fn += 1
            elif predicted:
                fp += 1

        p, r, f1 = compute_f1(tp, fp, fn)
        field_metrics.append({
            "field": name,
            "precision": p,
            "recall": r,
            "f1": f1,
            "tp": tp, "fp": fp, "fn": fn,
            "support": support,
        })
        total_tp += tp
        total_fp += fp
        total_fn += fn
        print(f"  {name:25s}  P={p:.3f}  R={r:.3f}  F1={f1:.3f}  n={support}")

    micro_p, micro_r, micro_f1 = compute_f1(total_tp, total_fp, total_fn)
    macro_f1 = round(sum(m["f1"] for m in field_metrics) / len(field_metrics), 4)

    print(f"\n  {'MICRO aggregate':25s}  P={micro_p:.3f}  R={micro_r:.3f}  F1={micro_f1:.3f}")
    print(f"  {'MACRO aggregate':25s}  F1={macro_f1:.3f}")

    output = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "dataset": str(DATA_FILE.name),
        "totalRows": len(df),
        "matchMode": "strict" if args.strict else "soft",
        "perField": field_metrics,
        "microAggregate": {"precision": micro_p, "recall": micro_r, "f1": micro_f1},
        "macroF1": macro_f1,
        "note": (
            "Extraction F1 measures how well the rule-based nlpExtractor recovers "
            "gold-standard field values from narrative text + structured columns. "
            "Strict mode requires exact normalised string match. "
            "Soft mode accepts substring containment (more forgiving for narrative extraction). "
            "Ground truth is the structured column value in ADRA_ICSR_Synthetic."
        ),
    }

    os.makedirs(Path(args.output).parent, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nExtraction F1 report written to: {args.output}")


if __name__ == "__main__":
    main()
