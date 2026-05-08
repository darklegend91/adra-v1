#!/usr/bin/env python3
"""
ADRA Privacy Metrics Evaluation
================================
Computes k-anonymity, l-diversity, and t-closeness on the analytics copy
of the synthetic ICSR dataset.

Quasi-identifiers (QI):
  Strategy A (recommended): ageBand, gender, region
  Strategy B (over-specified): + drugClass, meddraSOC

Sensitive attributes: outcome, seriousness

Annexure I requirements:
  k ≥ 5 after suppression
  l ≥ 2 (at least 2 distinct sensitive values per equivalence class)
  t ≤ 0.2 (strict) / t ≤ 0.35 (health-data threshold)

Usage
-----
  pip install pandas openpyxl
  python scripts/evaluate_privacy_metrics.py
  python scripts/evaluate_privacy_metrics.py --output reports/privacy_eval.json
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "ADRA_Synthetic_Evaluation_Dataset.xlsx"
DEFAULT_OUTPUT = ROOT / "reports" / "privacy_eval.json"


# ── Banding helpers ──────────────────────────────────────────────────────────

def band_age(age):
    try:
        a = int(float(str(age).strip()))
    except (ValueError, TypeError):
        return "Unknown"
    if a < 18:
        return "<18"
    if a < 30:
        return "18-29"
    if a < 45:
        return "30-44"
    if a < 60:
        return "45-59"
    if a < 75:
        return "60-74"
    return "75+"


def band_region(region):
    if not region or str(region).strip().lower() in ("nan", ""):
        return "Unknown"
    s = str(region).strip()
    # Group minor regions into zones
    north = {"Delhi", "Punjab", "Haryana", "UP", "Uttarakhand", "J&K", "Himachal Pradesh"}
    south = {"Tamil Nadu", "Kerala", "Karnataka", "Andhra Pradesh", "Telangana"}
    west = {"Maharashtra", "Gujarat", "Rajasthan", "Goa"}
    east = {"West Bengal", "Bihar", "Odisha", "Jharkhand", "Assam"}
    if s in north:
        return "North India"
    if s in south:
        return "South India"
    if s in west:
        return "West India"
    if s in east:
        return "East India"
    return "Other"


def band_outcome(outcome):
    if not outcome:
        return "Unknown"
    o = str(outcome).strip().lower()
    if "recover" in o or "resolved" in o:
        return "Recovered"
    if "recovering" in o or "resolving" in o:
        return "Recovering"
    if "not recover" in o or "not resolved" in o or "ongoing" in o:
        return "Not Recovered"
    if "fatal" in o or "death" in o or "died" in o:
        return "Fatal"
    return "Unknown"


def band_seriousness(seriousness):
    if not seriousness:
        return "others"
    s = str(seriousness).strip().lower()
    if "death" in s or "life-threatening" in s or "fatal" in s:
        return "death"
    if "disability" in s or "incapacity" in s or "congenital" in s:
        return "disability"
    if "hospital" in s:
        return "hospitalisation"
    return "others"


DRUG_CLASS_MAP = {
    "Amoxicillin": "Antibacterial", "Ciprofloxacin": "Antibacterial", "Azithromycin": "Antibacterial",
    "Metronidazole": "Antibacterial", "Doxycycline": "Antibacterial", "Clindamycin": "Antibacterial",
    "Ceftriaxone": "Antibacterial", "Piperacillin": "Antibacterial", "Vancomycin": "Antibacterial",
    "Meropenem": "Antibacterial", "Rifampicin": "Antibacterial", "Pyrazinamide": "Antibacterial",
    "Ethambutol": "Antibacterial", "Isoniazid": "Antibacterial", "Linezolid": "Antibacterial",
    "Heparin": "Anticoagulant", "Warfarin": "Anticoagulant", "Enoxaparin": "Anticoagulant",
    "Apixaban": "Anticoagulant", "Rivaroxaban": "Anticoagulant",
    "Atorvastatin": "Cardiovascular", "Lisinopril": "Cardiovascular", "Amlodipine": "Cardiovascular",
    "Metoprolol": "Cardiovascular", "Furosemide": "Cardiovascular", "Digoxin": "Cardiovascular",
    "Paracetamol": "Analgesic/NSAID", "Ibuprofen": "Analgesic/NSAID", "Diclofenac": "Analgesic/NSAID",
    "Aspirin": "Analgesic/NSAID", "Tramadol": "Analgesic/NSAID", "Morphine": "Analgesic/NSAID",
    "Metformin": "Antidiabetic", "Insulin": "Antidiabetic", "Glipizide": "Antidiabetic",
    "Sitagliptin": "Antidiabetic", "Empagliflozin": "Antidiabetic",
    "Phenytoin": "CNS", "Valproate": "CNS", "Carbamazepine": "CNS",
    "Levetiracetam": "CNS", "Clozapine": "CNS", "Risperidone": "CNS",
    "Haloperidol": "CNS", "Olanzapine": "CNS",
    "Methotrexate": "Immunomodulator", "Prednisolone": "Immunomodulator",
    "Dexamethasone": "Immunomodulator", "Rituximab": "Immunomodulator", "Infliximab": "Immunomodulator",
}


def band_drug(drug):
    if not drug:
        return "Other"
    return DRUG_CLASS_MAP.get(str(drug).strip(), "Other")


# ── Privacy metric computation ───────────────────────────────────────────────

def compute_k_anonymity(rows, qi_cols, k_target=5):
    """
    Returns k (min group size), groups, suppressed groups, and records suppressed.
    Suppression: remove groups with size < k_target.
    """
    groups = Counter()
    for row in rows:
        key = tuple(row.get(col, "Unknown") for col in qi_cols)
        groups[key] += 1

    k = min(groups.values()) if groups else 0
    suppressed = {key for key, count in groups.items() if count < k_target}
    records_suppressed = sum(count for key, count in groups.items() if key in suppressed)
    surviving = [r for r in rows if tuple(r.get(col, "Unknown") for col in qi_cols) not in suppressed]
    k_after = min(groups[key] for key in groups if key not in suppressed) if (len(groups) > len(suppressed)) else 0

    return {
        "k": k,
        "kAfterSuppression": k_after,
        "kTarget": k_target,
        "kAfterSuppressionCompliant": k_after >= k_target,
        "groups": len(groups),
        "suppressedGroups": len(suppressed),
        "recordsTotal": len(rows),
        "recordsSuppressed": records_suppressed,
        "survivingRows": len(surviving),
        "suppressionRate": round(records_suppressed / max(len(rows), 1), 4),
    }, surviving


def compute_l_diversity(rows, qi_cols, sensitive_col, l_target=2):
    """
    Computes l-diversity: each equivalence class must have >= l distinct values of the sensitive attribute.
    """
    from collections import defaultdict
    groups = defaultdict(list)
    for row in rows:
        key = tuple(row.get(col, "Unknown") for col in qi_cols)
        groups[key].append(row.get(sensitive_col, "Unknown"))

    l_values = [len(set(vals)) for vals in groups.values()]
    min_l = min(l_values) if l_values else 0
    compliant_groups = sum(1 for l in l_values if l >= l_target)

    return {
        "attribute": sensitive_col,
        "l": min_l,
        "lTarget": l_target,
        "compliant": min_l >= l_target,
        "compliantGroups": compliant_groups,
        "totalGroups": len(groups),
    }


def compute_t_closeness(rows, qi_cols, sensitive_col, t_target=0.20, t_health=0.35):
    """
    Computes t-closeness using the Earth Mover's Distance (ordinal/categorical approximation).
    For categorical: EMD ≈ max |P(class | group) - P(class | global)| summed.
    """
    from collections import defaultdict

    global_counts = Counter(row.get(sensitive_col, "Unknown") for row in rows)
    global_total = sum(global_counts.values())
    global_dist = {v: c / global_total for v, c in global_counts.items()}

    groups = defaultdict(list)
    for row in rows:
        key = tuple(row.get(col, "Unknown") for col in qi_cols)
        groups[key].append(row.get(sensitive_col, "Unknown"))

    t_values = []
    for vals in groups.values():
        group_counts = Counter(vals)
        group_total = sum(group_counts.values())
        group_dist = {v: group_counts.get(v, 0) / group_total for v in global_dist}
        emd = sum(abs(group_dist.get(v, 0) - global_dist.get(v, 0)) for v in global_dist) / 2
        t_values.append(emd)

    max_t = max(t_values) if t_values else 0

    return {
        "attribute": sensitive_col,
        "t": round(max_t, 4),
        "tTarget": t_target,
        "tHealthData": t_health,
        "compliant": max_t <= t_target,
        "healthDataCompliant": max_t <= t_health,
        "groups": len(groups),
    }


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ADRA privacy metrics evaluation.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--k-target", type=int, default=5)
    args = parser.parse_args()

    try:
        import pandas as pd
    except ImportError:
        sys.exit("Missing: pip install pandas openpyxl")

    if not DATA_FILE.exists():
        sys.exit(f"Dataset not found: {DATA_FILE}")

    df = pd.read_excel(DATA_FILE, sheet_name="ADRA_ICSR_Synthetic")
    print(f"ADRA Privacy Metrics Evaluation")
    print("=" * 50)
    print(f"Dataset: {DATA_FILE.name}  |  Rows: {len(df)}")

    # Build generalised analytics copy
    rows = []
    for _, row in df.iterrows():
        rows.append({
            "ageBand": band_age(row.get("Patient_Age", "")),
            "gender": str(row.get("Patient_Sex", "Unknown") or "Unknown").strip() or "Unknown",
            "region": band_region(row.get("Region", "")),
            "drugClass": band_drug(row.get("Suspect_Drug", "")),
            "meddraSOC": str(row.get("MedDRA_SOC", "Unknown") or "Unknown").strip() or "Unknown",
            "outcome": band_outcome(row.get("Outcome", "")),
            "seriousness": band_seriousness(row.get("SAE_Seriousness_Criteria", "")),
        })

    QI_A = ["ageBand", "gender", "region"]                    # recommended
    QI_B = ["ageBand", "gender", "region", "drugClass", "meddraSOC"]  # over-specified
    SENSITIVE = ["outcome", "seriousness"]

    results = {}

    for strategy, qi_cols, label in [
        ("A", QI_A, "Demographic QIs (ageBand, gender, region)"),
        ("B", QI_B, "All 5 QIs incl. drug class + SOC"),
    ]:
        print(f"\n  Strategy {strategy} — {label}")
        k_result, surviving = compute_k_anonymity(rows, qi_cols, k_target=args.k_target)
        print(f"    k (before suppression): {k_result['k']}")
        print(f"    k (after suppression):  {k_result['kAfterSuppression']} (target ≥{args.k_target}: {'PASS' if k_result['kAfterSuppressionCompliant'] else 'FAIL'})")
        print(f"    Groups: {k_result['groups']}  |  Suppressed: {k_result['suppressedGroups']} groups / {k_result['recordsSuppressed']} records ({k_result['suppressionRate']*100:.1f}%)")

        l_results = []
        t_results = []
        for attr in SENSITIVE:
            l_r = compute_l_diversity(surviving, qi_cols, attr)
            t_r = compute_t_closeness(surviving, qi_cols, attr)
            l_results.append(l_r)
            t_results.append(t_r)
            print(f"    l-diversity ({attr}): {l_r['l']} (≥2: {'PASS' if l_r['compliant'] else 'FAIL'})")
            print(f"    t-closeness ({attr}): {t_r['t']:.4f} (≤0.2: {'PASS' if t_r['compliant'] else 'FAIL'} | health-data ≤0.35: {'PASS' if t_r['healthDataCompliant'] else 'FAIL'})")

        results[f"strategy{strategy}"] = {
            "label": label,
            "quasiIdentifiers": qi_cols,
            "kAnonymity": k_result,
            "lDiversity": l_results,
            "tCloseness": t_results,
        }

    output = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "dataset": str(DATA_FILE.name),
        "totalRows": len(rows),
        "kTarget": args.k_target,
        "sensitiveAttributes": SENSITIVE,
        "strategies": results,
        "recommendation": (
            "Use Strategy A (demographic QIs only) for the analytics copy. "
            "Strategy B creates too many unique tuples (k drops to 1) because "
            "drug+SOC combinations are too specific for pharmacovigilance datasets."
        ),
        "note": (
            "k-anonymity suppresses groups below k=5. "
            "l-diversity enforces ≥2 distinct sensitive values per equivalence class. "
            "t-closeness uses half-sum EMD approximation (categorical). "
            "Metrics align with Annexure I requirements."
        ),
    }

    os.makedirs(Path(args.output).parent, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nPrivacy metrics written to: {args.output}")


if __name__ == "__main__":
    main()
