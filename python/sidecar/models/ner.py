"""
Clinical NER using scispaCy en_ner_bc5cdr_md.
Extracts: drugs, diseases, dose, route, frequency, age, gender, dates,
outcome, seriousness — with simple negation detection.
Singleton pattern: one instance loaded per process.
"""
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

# ── Compiled patterns ─────────────────────────────────────────────────────────
_DOSE_RE = re.compile(
    r"\b(\d+(?:\.\d+)?)\s*(mg|ml|g|mcg|µg|units?|IU|mEq|mmol)\b", re.I
)
_ROUTE_RE = re.compile(
    r"\b(oral(?:ly)?|by\s+mouth|inhale[d]?|inhal(?:ation)?|"
    r"intravenous(?:ly)?|\bIV\b|intramuscular(?:ly)?|\bIM\b|"
    r"subcutaneous(?:ly)?|\bSC\b|topical(?:ly)?|transdermal|"
    r"sublingual|rectal(?:ly)?|nasal(?:ly)?|ophthalmic|"
    r"intrathecal|epidural|intradermal)\b",
    re.I,
)
_FREQ_RE = re.compile(
    r"\b(once\s+daily|twice\s+daily|three\s+times\s+(?:a\s+)?daily|"
    r"four\s+times\s+(?:a\s+)?daily|once\s+a\s+day|twice\s+a\s+day|"
    r"\bOD\b|\bBD\b|\bTDS\b|\bQID\b|\bQDS\b|\bPRN\b|as\s+needed|"
    r"every\s+\d+\s+hours?|once\b|twice\b|thrice\b|"
    r"daily\b|weekly\b|monthly\b|fortnightly\b)\b",
    re.I,
)
_AGE_GENDER_RE = re.compile(
    r"\b(\d{1,3})\s*[\-\s]?(?:year|yr)s?\s*[\-\s]?old\s+"
    r"(male|female|man|woman|boy|girl|child|patient)\b",
    re.I,
)
_DATE_RE = re.compile(
    r"\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})\b"
)
_OUTCOME_RE = re.compile(
    r"\b(recovered\s+with\s+sequelae|recovered|recovering|"
    r"not\s+recovered|fatal|died|death|unknown)\b",
    re.I,
)
_SERIOUSNESS_RE = re.compile(
    r"\b(hospitali[sz]ation|hospitali[sz]ed|life[\s\-]threatening|"
    r"disability|congenital\s+anomaly|died|death|fatal|"
    r"medically\s+important)\b",
    re.I,
)
_NEG_WORDS = frozenset({
    "no", "not", "without", "denies", "denied", "absent",
    "negative", "never", "non", "rule", "ruled",
})

_instance: Optional["NerModel"] = None


def get_ner_model() -> "NerModel":
    global _instance
    if _instance is None:
        _instance = NerModel()
    return _instance


class NerModel:
    def __init__(self):
        self._nlp = None
        self._loaded = False

    def load(self) -> None:
        if self._loaded:
            return
        logger.info("Loading scispaCy en_ner_bc5cdr_md ...")
        try:
            import spacy  # type: ignore
            self._nlp = spacy.load("en_ner_bc5cdr_md")
            logger.info("scispaCy bc5cdr loaded.")
        except OSError:
            logger.warning("en_ner_bc5cdr_md not found — trying en_core_web_sm fallback.")
            try:
                import spacy  # type: ignore
                self._nlp = spacy.load("en_core_web_sm")
            except OSError:
                logger.warning("No spaCy model available — pattern-only NER mode.")
                self._nlp = None
        self._loaded = True

    def extract(self, text: str) -> dict:
        self.load()

        drugs, diseases, negated = [], [], []
        if self._nlp is not None:
            doc = self._nlp(text)
            for ent in doc.ents:
                neg = _is_negated(ent, doc)
                if ent.label_ == "CHEMICAL":
                    (negated if neg else drugs).append(ent.text)
                elif ent.label_ == "DISEASE":
                    (negated if neg else diseases).append(ent.text)

        # Pattern extraction always runs — fills gaps even without NER model
        dose_m = _DOSE_RE.search(text)
        route_m = _ROUTE_RE.search(text)
        freq_m = _FREQ_RE.search(text)
        ag_m = _AGE_GENDER_RE.search(text)
        outcome_m = _OUTCOME_RE.search(text)
        serious_m = _SERIOUSNESS_RE.search(text)
        dates = _DATE_RE.findall(text)

        result = {
            "drugs": _dedup(drugs),
            "diseases": _dedup(diseases),
            "negated": _dedup(negated),
            "dose": dose_m.group(0) if dose_m else "",
            "route": route_m.group(0) if route_m else "",
            "frequency": freq_m.group(0) if freq_m else "",
            "age": ag_m.group(1) if ag_m else "",
            "gender": _norm_gender(ag_m.group(2) if ag_m else ""),
            "onset_date": dates[0] if dates else "",
            "all_dates": dates,
            "outcome": outcome_m.group(0) if outcome_m else "",
            "seriousness": serious_m.group(0) if serious_m else "",
        }

        filled = sum(1 for v in result.values() if v and v != [])
        result["coverage"] = round(filled / len(result), 2)
        return result


def _is_negated(ent, doc) -> bool:
    start = max(0, ent.start - 4)
    return any(tok.lower_ in _NEG_WORDS for tok in doc[start:ent.start])


def _norm_gender(raw: str) -> str:
    lower = raw.lower()
    if lower in ("female", "woman", "girl"):
        return "female"
    if lower in ("male", "man", "boy"):
        return "male"
    return ""


def _dedup(lst: list) -> list:
    return list(dict.fromkeys(lst))
