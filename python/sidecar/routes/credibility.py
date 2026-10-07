"""
ADR report credibility analyser.

Uses scispaCy NER (trained on biomedical text — BC5CDR / en_core_web_sm)
combined with heuristic rule checks across five dimensions:

  medical_coherence   — entities recognised by the biomedical NER model
  completeness        — mandatory + advisory field presence
  consistency         — cross-field logical agreement (severity vs outcome etc.)
  demographic         — plausibility of age / weight values
  narrative_quality   — length, specificity, absence of generic filler text

Score: weighted average 0–100. Does NOT modify stored data.
"""

import re
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# ── Known drug → plausible reaction families (sample; not exhaustive) ─────────
_DRUG_REACTION_MAP: dict[str, list[str]] = {
    "methotrexate":   ["hepatotoxicity", "nausea", "stomatitis", "myelosuppression", "pulmonary"],
    "amoxicillin":    ["rash", "urticaria", "anaphylaxis", "diarrhoea", "allergy"],
    "aspirin":        ["bleeding", "gastrointestinal", "tinnitus", "reye", "ulcer"],
    "warfarin":       ["bleeding", "haemorrhage", "bruising", "haematoma"],
    "heparin":        ["bleeding", "thrombocytopenia", "haemorrhage", "hit"],
    "vancomycin":     ["nephrotoxicity", "ototoxicity", "red man", "rash"],
    "rifampicin":     ["hepatotoxicity", "nausea", "rash", "fever", "flu", "thrombocytopenia"],
    "phenytoin":      ["ataxia", "nystagmus", "rash", "gingival", "hirsutism", "lymphadenopathy"],
    "tocilizumab":    ["infection", "neutropenia", "hepatotoxicity", "hyperlipidaemia"],
    "enoxaparin":     ["bleeding", "haemorrhage", "thrombocytopenia", "hematoma"],
    "bevacizumab":    ["hypertension", "proteinuria", "wound", "thrombosis", "bleeding"],
    "valproate":      ["hepatotoxicity", "thrombocytopenia", "tremor", "weight", "alopecia"],
    "oseltamivir":    ["nausea", "vomiting", "headache", "psychiatric"],
    "gefitinib":      ["rash", "diarrhoea", "hepatotoxicity", "interstitial lung"],
    "imatinib":       ["oedema", "nausea", "muscle cramps", "hepatotoxicity", "myelosuppression"],
    "tenofovir":      ["nephrotoxicity", "bone", "lactic acidosis", "hepatotoxicity"],
    "erlotinib":      ["rash", "diarrhoea", "fatigue", "anorexia", "hepatotoxicity"],
    "clopidogrel":    ["bleeding", "thrombocytopenia", "rash", "gastrointestinal"],
    "lisinopril":     ["cough", "hypotension", "angioedema", "hyperkalaemia"],
    "atorvastatin":   ["myopathy", "rhabdomyolysis", "hepatotoxicity", "headache"],
}

_GENERIC_PHRASES = [
    "see attached", "not applicable", "n/a", "adverse reaction reported",
    "as described", "patient experienced", "side effect", "as per report",
    "unknown", "no further information",
]


class CredibilityRequest(BaseModel):
    medicine: Optional[str] = ""
    adverseReaction: Optional[str] = ""
    narrative: Optional[str] = ""
    seriousness: Optional[str] = ""
    severity: Optional[str] = ""
    age: Optional[str] = ""
    weight: Optional[str] = ""
    gender: Optional[str] = ""
    onsetDate: Optional[str] = ""
    reportDate: Optional[str] = ""
    outcome: Optional[str] = ""
    dose: Optional[str] = ""
    route: Optional[str] = ""
    reporter: Optional[str] = ""


class CredibilityResponse(BaseModel):
    score: int
    grade: str
    flags: List[str]
    dimensions: dict
    summary: str
    plausiblePair: bool


@router.post("/credibility")
async def analyze_credibility(req: CredibilityRequest) -> CredibilityResponse:
    flags: List[str] = []
    dim = {
        "medical_coherence": 100,
        "completeness": 100,
        "consistency": 100,
        "demographic": 100,
        "narrative_quality": 100,
    }

    medicine = (req.medicine or "").strip()
    reaction = (req.adverseReaction or "").strip()
    narrative = (req.narrative or "").strip()

    # ── 1. Medical coherence via scispaCy NER ─────────────────────────────────
    try:
        from models.ner import get_ner_model
        nlp = get_ner_model().nlp
        if nlp and narrative:
            doc = nlp(narrative[:600])
            labels = [e.label_ for e in doc.ents]
            has_chemical = any(l in ("CHEMICAL", "DRUG", "MEDICATION") for l in labels)
            has_disease  = any(l in ("DISEASE", "SYMPTOM", "DISORDER", "FINDING") for l in labels)
            entity_count = len(doc.ents)

            if not has_disease and entity_count < 2:
                dim["medical_coherence"] -= 25
                flags.append("narrative_lacks_medical_entities")
            elif not has_disease:
                dim["medical_coherence"] -= 12

            if not has_chemical and entity_count < 1:
                dim["medical_coherence"] -= 10

            # Medicine name mentioned in narrative?
            med_short = medicine.lower()[:8]
            if med_short and med_short not in narrative.lower():
                dim["medical_coherence"] -= 8

            # Reaction term mentioned?
            rxn_short = reaction.lower().split("(")[0].strip()[:10]
            if rxn_short and rxn_short not in narrative.lower():
                dim["medical_coherence"] -= 10
                flags.append("reaction_absent_from_narrative")

    except Exception:
        # NER unavailable — no penalty, skip dimension
        dim["medical_coherence"] -= 0

    # ── 2. Known drug-reaction plausibility ───────────────────────────────────
    plausible_pair = False
    med_key = medicine.lower().strip()
    rxn_text = reaction.lower()
    if med_key in _DRUG_REACTION_MAP:
        plausible_pair = any(kw in rxn_text for kw in _DRUG_REACTION_MAP[med_key])
        if not plausible_pair:
            dim["medical_coherence"] -= 18
            flags.append("unusual_adr_for_this_drug")
    else:
        # Unknown drug — neutral, neither penalise nor reward
        plausible_pair = True

    # ── 3. Completeness ───────────────────────────────────────────────────────
    def _missing(v: Optional[str]) -> bool:
        return not v or v.strip().lower() in ("", "not extracted", "unknown", "none", "n/a")

    mandatory = [
        (medicine, "suspect_drug_missing"),
        (reaction, "adverse_reaction_missing"),
        (req.reporter, "reporter_missing"),
    ]
    advisory = [
        (req.onsetDate, "onset_date_missing"),
        (req.age, "patient_age_missing"),
        (req.dose, "dose_missing"),
        (req.route, "route_missing"),
        (req.gender, "gender_missing"),
    ]

    for val, flag in mandatory:
        if _missing(val):
            dim["completeness"] -= 22
            flags.append(flag)

    for val, flag in advisory:
        if _missing(val):
            dim["completeness"] -= 7
            flags.append(flag)

    # ── 4. Cross-field consistency ────────────────────────────────────────────
    sev = (req.severity or "").lower()
    seriousness = (req.seriousness or "").lower()
    outcome = (req.outcome or "").lower()

    SERIOUS_OUTCOMES = {"death", "life-threatening", "hospitalisation", "disability/incapacity", "congenital anomaly"}

    if sev == "death" and seriousness not in ("death", "fatal"):
        dim["consistency"] -= 25
        flags.append("death_severity_but_non_fatal_seriousness")

    if sev == "death" and outcome in ("recovered", "recovering"):
        dim["consistency"] -= 30
        flags.append("death_class_but_recovered_outcome")

    if sev in ("death", "disability") and seriousness.lower() in ("non-serious", ""):
        dim["consistency"] -= 20
        flags.append("serious_severity_marked_non_serious")

    if seriousness in SERIOUS_OUTCOMES and sev == "others":
        dim["consistency"] -= 15
        flags.append("seriousness_severity_class_mismatch")

    # ── 5. Demographic plausibility ───────────────────────────────────────────
    age_raw = re.sub(r"[^\d.]", "", req.age or "")
    if age_raw:
        try:
            age = float(age_raw)
            if age < 0 or age > 120:
                dim["demographic"] -= 45
                flags.append("implausible_age_value")
            elif age == 0:
                dim["demographic"] -= 10
        except ValueError:
            pass

    wt_raw = re.sub(r"[^\d.]", "", req.weight or "")
    if wt_raw:
        try:
            wt = float(wt_raw)
            if wt < 0.5 or wt > 350:
                dim["demographic"] -= 35
                flags.append("implausible_weight_value")
        except ValueError:
            pass

    # ── 6. Narrative quality ──────────────────────────────────────────────────
    words = len(narrative.split())
    if not narrative:
        dim["narrative_quality"] -= 45
        flags.append("narrative_absent")
    elif words < 8:
        dim["narrative_quality"] -= 35
        flags.append("narrative_too_short")
    elif words < 20:
        dim["narrative_quality"] -= 15

    lower_narr = narrative.lower()
    generic_hit = sum(1 for p in _GENERIC_PHRASES if p in lower_narr)
    if generic_hit >= 2:
        dim["narrative_quality"] -= 20
        flags.append("generic_filler_language_detected")
    elif generic_hit == 1:
        dim["narrative_quality"] -= 8

    # Repetitive content (simple check: same sentence repeated)
    sentences = [s.strip() for s in re.split(r"[.!?]", narrative) if len(s.strip()) > 10]
    unique_sentences = len(set(sentences))
    if sentences and unique_sentences / len(sentences) < 0.5:
        dim["narrative_quality"] -= 20
        flags.append("repetitive_narrative_content")

    # ── Final score ───────────────────────────────────────────────────────────
    dim = {k: max(0, min(100, v)) for k, v in dim.items()}
    weights = {
        "medical_coherence": 0.30,
        "completeness":      0.25,
        "consistency":       0.25,
        "demographic":       0.10,
        "narrative_quality": 0.10,
    }
    score = int(sum(dim[k] * w for k, w in weights.items()))

    grade = "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 50 else "D"

    serious_flags = [f for f in flags if any(kw in f for kw in ("missing", "mismatch", "implausible", "unusual", "absent"))]
    if not flags:
        summary = "No credibility concerns detected across all five dimensions."
    elif score >= 70:
        summary = f"{len(flags)} advisory note(s) — credible report, minor gaps only."
    elif score >= 50:
        summary = f"{len(serious_flags)} concern(s) flagged — reverification recommended before final processing."
    else:
        summary = f"Multiple credibility concerns ({len(flags)} flags) — escalate for manual review."

    return CredibilityResponse(
        score=score,
        grade=grade,
        flags=flags,
        dimensions=dim,
        summary=summary,
        plausiblePair=plausible_pair,
    )
