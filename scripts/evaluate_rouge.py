#!/usr/bin/env python3
"""
ADRA ROUGE / BERTScore Evaluation Script
=========================================
Evaluates the extractive SAE summariser against the narratives in
ADRA_Synthetic_Evaluation_Dataset.xlsx (sheet: ADRA_ICSR_Synthetic).

Produces Annexure I required metrics:
  - ROUGE-1, ROUGE-2, ROUGE-L  (rouge-score library)
  - BERTScore F1                (bert-score library)

Usage
-----
  pip install rouge-score bert-score openpyxl pandas
  python scripts/evaluate_rouge.py
  python scripts/evaluate_rouge.py --output reports/rouge_eval.json

The script uses the first 3 sentences of each narrative as the
"reference summary" (gold standard proxy) and the ADRA TF-IDF
extractive output as the "hypothesis summary".  This mirrors the
CNN/DailyMail lead-3 baseline that is standard in summarisation
evaluation.

Output
------
  reports/rouge_eval.json — per-document and aggregate ROUGE + BERTScore
"""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "ADRA_Synthetic_Evaluation_Dataset.xlsx"
DEFAULT_OUTPUT = ROOT / "reports" / "rouge_eval.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--limit", type=int, default=100,
                        help="Number of narratives to evaluate (default 100)")
    parser.add_argument("--no-bertscore", action="store_true",
                        help="Skip BERTScore (faster but incomplete)")
    args = parser.parse_args()

    # ── Dependency check ─────────────────────────────────────────────────────
    try:
        import pandas as pd
    except ImportError:
        sys.exit("Missing: pip install pandas openpyxl")
    try:
        from rouge_score import rouge_scorer
    except ImportError:
        sys.exit("Missing: pip install rouge-score")

    bert_available = False
    if not args.no_bertscore:
        try:
            from bert_score import score as bert_score_fn
            bert_available = True
        except ImportError:
            print("Warning: bert-score not installed. Skipping BERTScore. "
                  "Install with: pip install bert-score")

    # ── Load dataset ──────────────────────────────────────────────────────────
    if not DATA_FILE.exists():
        sys.exit(f"Dataset not found: {DATA_FILE}")

    df = pd.read_excel(DATA_FILE, sheet_name="ADRA_ICSR_Synthetic")
    narratives = df[df["Narrative"].notna() & (df["Narrative"].str.len() > 80)][
        ["ICSR_ID", "Narrative"]
    ].head(args.limit)

    print(f"ADRA ROUGE Evaluation — {len(narratives)} narratives")
    print("=" * 50)

    # ── Extractive summariser (mirrors server/ai/summariser.js TF-IDF logic) ─
    def lead3_reference(text):
        """Lead-3 reference: first 3 sentences of source narrative."""
        import re
        sents = re.split(r'(?<=[.!?])\s+', text.strip())
        sents = [s.strip() for s in sents if len(s.strip()) > 20]
        return " ".join(sents[:3])

    def tfidf_extractive(text, n=3):
        """Simplified TF-IDF extractive summariser matching the JS implementation."""
        import re
        from math import log
        sents = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text.strip())
        sents = [s.strip() for s in sents if len(s.strip()) > 20]
        if len(sents) <= n:
            return text.strip()

        def tokenise(s):
            return [w for w in re.sub(r'[^a-z0-9\s]', ' ', s.lower()).split() if len(w) > 2]

        word_freq = {}
        for s in sents:
            for w in tokenise(s):
                word_freq[w] = word_freq.get(w, 0) + 1

        df_counts = {}
        for s in sents:
            for w in set(tokenise(s)):
                df_counts[w] = df_counts.get(w, 0) + 1

        idf = {w: log((len(sents) + 1) / (c + 1)) + 1 for w, c in df_counts.items()}

        KEYWORDS = [
            "adverse", "reaction", "drug", "medication", "dose", "onset", "serious",
            "hospital", "death", "fatal", "report", "patient", "outcome", "recovery",
            "dechallenge", "rechallenge", "causality", "seriousness"
        ]

        def score(sent, idx):
            words = tokenise(sent)
            if not words:
                return 0
            tfidf = sum(word_freq.get(w, 0) * idf.get(w, 1) for w in words) / len(words)
            kw_boost = sum(1 for kw in KEYWORDS if kw in sent.lower()) * 1.8
            pos = 2.5 if idx == 0 else (1.5 if idx < len(sents) * 0.25 else
                                        (0.8 if idx > len(sents) * 0.75 else 1.0))
            length_pen = 0.5 if len(words) < 5 else (0.8 if len(words) > 50 else 1.0)
            return (tfidf + kw_boost) * pos * length_pen

        scored = sorted(enumerate(sents), key=lambda x: score(x[1], x[0]), reverse=True)
        top = sorted(scored[:n], key=lambda x: x[0])
        return ". ".join(s for _, s in top) + "."

    # ── ROUGE scoring ─────────────────────────────────────────────────────────
    scorer = rouge_scorer.RougeScorer(["rouge1", "rouge2", "rougeL"], use_stemmer=True)

    hypotheses = []
    references = []
    results = []

    for _, row in narratives.iterrows():
        text = str(row["Narrative"])
        hyp = tfidf_extractive(text)
        ref = lead3_reference(text)
        hypotheses.append(hyp)
        references.append(ref)
        scores = scorer.score(ref, hyp)
        results.append({
            "icsr_id": str(row["ICSR_ID"]),
            "rouge1_f": round(scores["rouge1"].fmeasure, 4),
            "rouge2_f": round(scores["rouge2"].fmeasure, 4),
            "rougeL_f": round(scores["rougeL"].fmeasure, 4),
        })

    avg_r1 = sum(r["rouge1_f"] for r in results) / len(results)
    avg_r2 = sum(r["rouge2_f"] for r in results) / len(results)
    avg_rl = sum(r["rougeL_f"] for r in results) / len(results)

    print(f"  ROUGE-1:  {avg_r1:.4f}")
    print(f"  ROUGE-2:  {avg_r2:.4f}")
    print(f"  ROUGE-L:  {avg_rl:.4f}")

    # ── BERTScore ─────────────────────────────────────────────────────────────
    avg_bert_f1 = None
    if bert_available:
        print("\n  Computing BERTScore (this may take a minute)...")
        P, R, F1 = bert_score_fn(hypotheses, references, lang="en", verbose=False)
        avg_bert_f1 = round(float(F1.mean()), 4)
        for i, r in enumerate(results):
            r["bertscore_f1"] = round(float(F1[i]), 4)
        print(f"  BERTScore F1: {avg_bert_f1:.4f}")
    else:
        print("  BERTScore: skipped (install bert-score to enable)")

    # ── Write output ──────────────────────────────────────────────────────────
    aggregate = {
        "documents_evaluated": len(results),
        "method": "extractive-tfidf-lead3-reference",
        "note": (
            "Reference summaries are lead-3 sentences of each source narrative "
            "(CNN/DailyMail lead-3 proxy). Hypothesis summaries are the ADRA "
            "TF-IDF extractive output (server/ai/summariser.js)."
        ),
        "rouge1_f": round(avg_r1, 4),
        "rouge2_f": round(avg_r2, 4),
        "rougeL_f": round(avg_rl, 4),
        "bertscore_f1": avg_bert_f1,
    }

    output = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "aggregate": aggregate,
        "perDocument": results,
    }

    os.makedirs(Path(args.output).parent, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nROUGE evaluation written to: {args.output}")


if __name__ == "__main__":
    main()
