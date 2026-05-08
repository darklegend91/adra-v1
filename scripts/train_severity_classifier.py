#!/usr/bin/env python3
"""
ADRA Severity Classifier — ML Training & Evaluation
=====================================================
Trains three model families on the synthetic ICSR dataset and reports
Macro-F1, MCC, and per-class confusion matrix for Annexure I.

Labels: {death, disability, hospitalisation, others}

Models compared
---------------
  1. TF-IDF + Logistic Regression (baseline)
  2. TF-IDF + Gradient Boosted Trees (LightGBM)
  3. TF-IDF + Random Forest

Usage
-----
  pip install scikit-learn lightgbm openpyxl pandas joblib
  python scripts/train_severity_classifier.py
  python scripts/train_severity_classifier.py --output reports/severity_eval.json
  python scripts/train_severity_classifier.py --save-model models/severity_lgbm.pkl
"""

import argparse
import json
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "ADRA_Synthetic_Evaluation_Dataset.xlsx"
DEFAULT_OUTPUT = ROOT / "reports" / "severity_eval.json"
MODEL_DIR = ROOT / "models"

SERIOUSNESS_MAP = {
    "Death": "death",
    "Life-threatening": "death",
    "Disability/incapacity": "disability",
    "Congenital anomaly": "disability",
    "Hospitalisation": "hospitalisation",
    "Required hospitalisation": "hospitalisation",
    "Other medically important": "others",
    "Non-serious": "others",
    "": "others",
}

CLASSES = ["death", "disability", "hospitalisation", "others"]


def main():
    parser = argparse.ArgumentParser(description="Train ADRA severity classifier.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--save-model", metavar="FILE", help="Save best model to this path (e.g. models/severity.pkl)")
    parser.add_argument("--folds", type=int, default=5, help="Stratified k-fold count (default 5)")
    parser.add_argument("--limit", type=int, default=0, help="Limit rows (0 = all)")
    args = parser.parse_args()

    try:
        import pandas as pd
    except ImportError:
        sys.exit("Missing: pip install pandas openpyxl")
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression
        from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
        from sklearn.pipeline import Pipeline
        from sklearn.model_selection import StratifiedKFold, cross_val_predict
        from sklearn.metrics import (classification_report, confusion_matrix,
                                     f1_score, matthews_corrcoef)
        from sklearn.preprocessing import LabelEncoder
    except ImportError:
        sys.exit("Missing: pip install scikit-learn")

    lgbm_available = False
    try:
        from lightgbm import LGBMClassifier
        lgbm_available = True
    except ImportError:
        print("Warning: lightgbm not installed. Replacing with GradientBoostingClassifier.")

    if not DATA_FILE.exists():
        sys.exit(f"Dataset not found: {DATA_FILE}")

    df = pd.read_excel(DATA_FILE, sheet_name="ADRA_ICSR_Synthetic")
    if args.limit > 0:
        df = df.head(args.limit)

    # Build feature text from clinical content only.
    # SAE_Seriousness_Criteria is EXCLUDED — it is the structured label field
    # that maps directly to the target class (near-tautological leakage).
    # The classifier must infer severity from MedDRA terms, narrative, drug, and
    # outcome — the same signals available when the structured field is absent or
    # unreliable (e.g. free-text uploads, scanned PDFs without checkboxes).
    def build_text(row):
        parts = [
            str(row.get("MedDRA_PT", "") or ""),
            str(row.get("MedDRA_SOC", "") or ""),
            str(row.get("MedDRA_LLT", "") or ""),
            str(row.get("Outcome", "") or ""),
            str(row.get("Narrative", "") or "")[:400],
            str(row.get("Suspect_Drug", "") or ""),
            str(row.get("Causality_Assessment", "") or ""),
        ]
        return " ".join(p for p in parts if p and p != "nan")

    df["_text"] = df.apply(build_text, axis=1)
    df["_label"] = df["SAE_Seriousness_Criteria"].map(
        lambda v: SERIOUSNESS_MAP.get(str(v).strip(), "others")
    )

    X = df["_text"].tolist()
    y = df["_label"].tolist()

    print(f"ADRA Severity Classifier Training")
    print("=" * 50)
    print(f"Dataset: {DATA_FILE.name}")
    print(f"Total rows: {len(X)}")
    for cls in CLASSES:
        count = y.count(cls)
        print(f"  {cls}: {count} ({100*count/len(y):.1f}%)")
    print(f"Folds: {args.folds}")

    cv = StratifiedKFold(n_splits=args.folds, shuffle=True, random_state=42)

    candidates = [
        ("Logistic Regression (TF-IDF)", Pipeline([
            ("tfidf", TfidfVectorizer(ngram_range=(1, 2), max_features=12000, sublinear_tf=True)),
            ("clf", LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced", solver="lbfgs")),
        ])),
        ("Random Forest (TF-IDF)", Pipeline([
            ("tfidf", TfidfVectorizer(ngram_range=(1, 2), max_features=8000, sublinear_tf=True)),
            ("clf", RandomForestClassifier(n_estimators=200, max_depth=20, class_weight="balanced", random_state=42, n_jobs=-1)),
        ])),
    ]

    if lgbm_available:
        candidates.append(("LightGBM (TF-IDF)", Pipeline([
            ("tfidf", TfidfVectorizer(ngram_range=(1, 2), max_features=10000, sublinear_tf=True)),
            ("clf", LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=63,
                                   class_weight="balanced", random_state=42, verbose=-1)),
        ])))
    else:
        candidates.append(("Gradient Boosting (TF-IDF)", Pipeline([
            ("tfidf", TfidfVectorizer(ngram_range=(1, 2), max_features=8000, sublinear_tf=True)),
            ("clf", GradientBoostingClassifier(n_estimators=200, learning_rate=0.05, max_depth=5, random_state=42)),
        ])))

    results = []
    best_model = None
    best_f1 = -1

    for name, pipeline in candidates:
        print(f"\n[Model] {name}")
        y_pred = cross_val_predict(pipeline, X, y, cv=cv, n_jobs=-1)
        macro_f1 = round(f1_score(y, y_pred, labels=CLASSES, average="macro", zero_division=0), 4)
        mcc = round(matthews_corrcoef(y, y_pred), 4)
        report = classification_report(y, y_pred, labels=CLASSES, output_dict=True, zero_division=0)
        cm = confusion_matrix(y, y_pred, labels=CLASSES).tolist()

        per_class = {
            cls: {
                "precision": round(report[cls]["precision"], 4),
                "recall": round(report[cls]["recall"], 4),
                "f1": round(report[cls]["f1-score"], 4),
                "support": int(report[cls]["support"]),
            }
            for cls in CLASSES if cls in report
        }

        print(f"  Macro-F1: {macro_f1}  MCC: {mcc}")
        for cls in CLASSES:
            pc = per_class.get(cls, {})
            print(f"  {cls:15s} P={pc.get('precision','?'):.3f}  R={pc.get('recall','?'):.3f}  F1={pc.get('f1','?'):.3f}  n={pc.get('support','?')}")

        model_result = {
            "model": name,
            "folds": args.folds,
            "macroF1": macro_f1,
            "mcc": mcc,
            "perClass": per_class,
            "confusionMatrix": {
                "labels": CLASSES,
                "matrix": cm,
            },
        }
        results.append(model_result)

        if macro_f1 > best_f1:
            best_f1 = macro_f1
            best_model = (name, pipeline)

    # Re-fit best model on full dataset for saving
    best_name, best_pipeline = best_model
    print(f"\n[Best model] {best_name} (Macro-F1 {best_f1})")
    best_pipeline.fit(X, y)

    if args.save_model:
        try:
            import joblib
            save_path = Path(args.save_model)
            save_path.parent.mkdir(parents=True, exist_ok=True)
            joblib.dump(best_pipeline, save_path)
            print(f"Model saved to: {save_path}")
        except ImportError:
            print("Warning: joblib not installed. Model not saved. Install with: pip install joblib")

    # ── Always export LR weights as JS-loadable JSON ──────────────────────────
    # Train a dedicated LR pipeline with 5,000 features (smaller JSON, fast JS inference).
    # This is the model that gets loaded by server/ai/lrClassifier.js at runtime.
    print("\n[Export] Training LR model for JS inference export...")
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression as LRExport

    lr_export_pipeline = Pipeline([
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2), max_features=5000, sublinear_tf=True)),
        ("clf", LRExport(C=1.0, max_iter=1000, class_weight="balanced", solver="lbfgs")),
    ])
    lr_export_pipeline.fit(X, y)

    vec = lr_export_pipeline.named_steps["tfidf"]
    clf_lr = lr_export_pipeline.named_steps["clf"]

    lr_json = {
        "modelType": "logistic-regression-tfidf",
        "classes": clf_lr.classes_.tolist(),
        "vocabulary": {word: int(idx) for word, idx in vec.vocabulary_.items()},
        "idf": vec.idf_.tolist(),
        "coef": clf_lr.coef_.tolist(),          # shape: [n_classes, n_features]
        "intercept": clf_lr.intercept_.tolist(), # shape: [n_classes]
        "sublinear_tf": True,
        "ngram_range": [1, 2],
        "macroF1": best_f1,
        "mcc": results[[r["model"] for r in results].index(best_name)]["mcc"] if best_name in [r["model"] for r in results] else None,
        "trainedOn": len(X),
        "features": len(vec.vocabulary_),
        "trainedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "note": (
            "Trained on MedDRA PT/SOC/LLT + outcome + narrative + drug + causality. "
            "SAE_Seriousness_Criteria excluded to prevent label leakage. "
            "Load with server/ai/lrClassifier.js for live JS inference."
        )
    }

    lr_model_path = ROOT / "models" / "severity_lr.json"
    lr_model_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lr_model_path, "w") as f:
        json.dump(lr_json, f, separators=(",", ":"))  # compact — no indent, smaller file

    kb = lr_model_path.stat().st_size // 1024
    print(f"LR model exported to: {lr_model_path} ({kb} KB, {len(vec.vocabulary_)} features)")

    output = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "dataset": str(DATA_FILE.name),
        "totalRows": len(X),
        "classDistribution": {cls: y.count(cls) for cls in CLASSES},
        "cvFolds": args.folds,
        "candidates": results,
        "bestModel": best_name,
        "bestMacroF1": best_f1,
        "note": (
            "Stratified k-fold CV ensures unbiased evaluation. "
            "Labels: death, disability, hospitalisation, others. "
            "Macro-F1 and MCC are the Annexure I required metrics."
        ),
    }

    os.makedirs(Path(args.output).parent, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nSeverity evaluation written to: {args.output}")


if __name__ == "__main__":
    main()
