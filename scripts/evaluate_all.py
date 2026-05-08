#!/usr/bin/env python3
"""
ADRA Master Evaluation Runner — Annexure I Report
===================================================
Runs all Python evaluation scripts and combines results into a single
Annexure I aligned JSON + plain-text report.

Covers:
  1. ROUGE-1/2/L + BERTScore     (evaluate_rouge.py)
  2. Severity classifier ML      (train_severity_classifier.py)
  3. Privacy metrics k/l/t       (evaluate_privacy_metrics.py)
  4. Field extraction F1         (evaluate_extraction_f1.py)
  5. Duplicate detection         (evaluate_duplicates.py)

Usage
-----
  pip install pandas openpyxl scikit-learn rouge-score
  python scripts/evaluate_all.py
  python scripts/evaluate_all.py --output reports/annexure_i.json --no-bertscore
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
REPORTS_DIR = ROOT / "reports"


def run_script(name, extra_args=None):
    """Run a sibling script and return its output JSON path."""
    script = SCRIPTS / name
    if not script.exists():
        print(f"  [skip] {name} not found.")
        return None
    output = REPORTS_DIR / name.replace(".py", ".json")
    cmd = [sys.executable, str(script), "--output", str(output)]
    if extra_args:
        cmd.extend(extra_args)
    print(f"  Running {name}...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"    ERROR: {result.stderr.strip()[:300]}")
        return None
    return output if output.exists() else None


def load_json(path):
    if path and Path(path).exists():
        with open(path) as f:
            return json.load(f)
    return None


def main():
    parser = argparse.ArgumentParser(description="ADRA master evaluation — Annexure I report.")
    parser.add_argument("--output", default=str(REPORTS_DIR / "annexure_i.json"))
    parser.add_argument("--no-bertscore", action="store_true", help="Skip BERTScore (faster)")
    parser.add_argument("--skip-ml", action="store_true", help="Skip ML training (faster)")
    args = parser.parse_args()

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    print("ADRA Evaluation — Annexure I Report")
    print("=" * 60)

    # 1. ROUGE
    print("\n[1/5] ROUGE + BERTScore evaluation")
    rouge_extra = ["--no-bertscore"] if args.no_bertscore else []
    rouge_path = run_script("evaluate_rouge.py", rouge_extra)
    rouge = load_json(rouge_path)

    # 2. Severity classifier
    print("\n[2/5] Severity classifier ML training")
    if not args.skip_ml:
        severity_path = run_script("train_severity_classifier.py")
        severity = load_json(severity_path)
    else:
        print("  [skip] --skip-ml flag set.")
        severity = None

    # 3. Privacy metrics
    print("\n[3/5] Privacy metrics (k/l/t)")
    privacy_path = run_script("evaluate_privacy_metrics.py")
    privacy = load_json(privacy_path)

    # 4. Extraction F1
    print("\n[4/5] Field extraction F1")
    extraction_path = run_script("evaluate_extraction_f1.py")
    extraction = load_json(extraction_path)

    # 5. Duplicate detection
    print("\n[5/5] Duplicate detection evaluation")
    dup_path = run_script("evaluate_duplicates.py")
    duplicates = load_json(dup_path)

    # ── Build Annexure I summary ──────────────────────────────────────────────
    summary = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "title": "ADRA Annexure I — Technical Evaluation Report",
        "note": (
            "All metrics computed on ADRA_Synthetic_Evaluation_Dataset.xlsx. "
            "ROUGE uses lead-3 sentences as reference proxy (CNN/DailyMail convention). "
            "Severity classifier uses stratified 5-fold CV. "
            "Privacy metrics use demographic quasi-identifiers (Strategy A). "
            "Extraction F1 uses soft substring match against structured column values."
        ),
    }

    # Populate from individual reports
    if rouge:
        agg = rouge.get("aggregate", {})
        summary["summarisation"] = {
            "documentsEvaluated": agg.get("documents_evaluated"),
            "rouge1_f": agg.get("rouge1_f"),
            "rouge2_f": agg.get("rouge2_f"),
            "rougeL_f": agg.get("rougeL_f"),
            "bertscore_f1": agg.get("bertscore_f1"),
            "method": agg.get("method"),
        }
    else:
        summary["summarisation"] = {"status": "not_computed"}

    if severity:
        summary["severityClassifier"] = {
            "totalRows": severity.get("totalRows"),
            "bestModel": severity.get("bestModel"),
            "bestMacroF1": severity.get("bestMacroF1"),
            "cvFolds": severity.get("cvFolds"),
            "candidates": [
                {
                    "model": c["model"],
                    "macroF1": c["macroF1"],
                    "mcc": c["mcc"],
                }
                for c in severity.get("candidates", [])
            ],
        }
    else:
        summary["severityClassifier"] = {"status": "not_computed"}

    if privacy:
        strat_a = privacy.get("strategies", {}).get("strategyA", {})
        k = strat_a.get("kAnonymity", {})
        l_list = strat_a.get("lDiversity", [])
        t_list = strat_a.get("tCloseness", [])
        summary["privacyMetrics"] = {
            "strategy": "A — Demographic QIs (ageBand, gender, region)",
            "totalRows": privacy.get("totalRows"),
            "kAnonymity": {
                "k": k.get("k"),
                "kAfterSuppression": k.get("kAfterSuppression"),
                "kTarget": k.get("kTarget"),
                "compliant": k.get("kAfterSuppressionCompliant"),
                "suppressionRate": k.get("suppressionRate"),
            },
            "lDiversity": [{"attribute": l.get("attribute"), "l": l.get("l"), "compliant": l.get("compliant")} for l in l_list],
            "tCloseness": [{"attribute": t.get("attribute"), "t": t.get("t"), "compliant": t.get("compliant"), "healthDataCompliant": t.get("healthDataCompliant")} for t in t_list],
        }
    else:
        summary["privacyMetrics"] = {"status": "not_computed"}

    if extraction:
        summary["extractionF1"] = {
            "totalRows": extraction.get("totalRows"),
            "matchMode": extraction.get("matchMode"),
            "macroF1": extraction.get("macroF1"),
            "microF1": extraction.get("microAggregate", {}).get("f1"),
            "perField": [
                {"field": f["field"], "f1": f["f1"], "precision": f["precision"], "recall": f["recall"]}
                for f in extraction.get("perField", [])
            ],
        }
    else:
        summary["extractionF1"] = {"status": "not_computed"}

    if duplicates:
        best_strat = duplicates.get("bestStrategy", "")
        best_metrics = duplicates.get("strategies", {}).get(best_strat, {})
        summary["duplicateDetection"] = {
            "labelledPairs": duplicates.get("labelledPairs"),
            "bestStrategy": best_strat,
            "bestF1": duplicates.get("bestF1"),
            "bestPrecision": best_metrics.get("precision"),
            "bestRecall": best_metrics.get("recall"),
            "allStrategies": {
                k: {"f1": v["f1"], "precision": v["precision"], "recall": v["recall"]}
                for k, v in duplicates.get("strategies", {}).items()
            },
        }
    else:
        summary["duplicateDetection"] = {"status": "not_computed"}

    with open(args.output, "w") as f:
        json.dump(summary, f, indent=2)

    # ── Print summary table ───────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("ANNEXURE I RESULTS SUMMARY")
    print("=" * 60)

    def row(label, value, pass_fail=""):
        pf = f"  [{pass_fail}]" if pass_fail else ""
        print(f"  {label:40s} {str(value):>10s}{pf}")

    print("\nSummarisation (ROUGE / BERTScore)")
    s = summary["summarisation"]
    row("ROUGE-1 F", s.get("rouge1_f", "N/A"))
    row("ROUGE-2 F", s.get("rouge2_f", "N/A"))
    row("ROUGE-L F", s.get("rougeL_f", "N/A"))
    row("BERTScore F1", s.get("bertscore_f1", "N/A"))

    print("\nSeverity Classifier (4-class)")
    sc = summary["severityClassifier"]
    row("Best model", sc.get("bestModel", "N/A"))
    row("Macro-F1", sc.get("bestMacroF1", "N/A"))

    print("\nPrivacy Metrics")
    pm = summary["privacyMetrics"]
    if isinstance(pm, dict) and "kAnonymity" in pm:
        k = pm["kAnonymity"]
        row("k (before suppression)", k.get("k", "N/A"))
        row("k (after suppression)", k.get("kAfterSuppression", "N/A"), "PASS" if k.get("compliant") else "FAIL")
        row("Suppression rate", f"{round((k.get('suppressionRate') or 0)*100, 1)}%")
        for l in pm.get("lDiversity", []):
            row(f"l-diversity ({l['attribute']})", l.get("l", "N/A"), "PASS" if l.get("compliant") else "FAIL")
        for t in pm.get("tCloseness", []):
            row(f"t-closeness ({t['attribute']})", t.get("t", "N/A"), "PASS" if t.get("healthDataCompliant") else "FAIL")

    print("\nField Extraction F1")
    ef = summary["extractionF1"]
    row("Macro-F1", ef.get("macroF1", "N/A"))
    row("Micro-F1", ef.get("microF1", "N/A"))

    print("\nDuplicate Detection")
    dd = summary["duplicateDetection"]
    row("Best strategy", dd.get("bestStrategy", "N/A"))
    row("Best F1", dd.get("bestF1", "N/A"))
    row("Precision", dd.get("bestPrecision", "N/A"))
    row("Recall", dd.get("bestRecall", "N/A"))

    print(f"\nFull report written to: {args.output}")


if __name__ == "__main__":
    main()
