"""
fastText language identification (lid.176.ftz, 917 KB).
Auto-downloads the model on first use.
Singleton pattern: one instance loaded per process.
"""
import logging
import os
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)

_MODEL_URL = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"

_INDIC_LANG_CODES = frozenset({
    "hi", "bn", "ta", "te", "mr", "gu", "kn", "ml",
    "pa", "or", "as", "ur", "sa", "ne", "sd", "ks", "mai",
})

_instance: Optional["LangDetectModel"] = None


def get_langdetect_model(model_path: str = "") -> "LangDetectModel":
    global _instance
    if _instance is None:
        _instance = LangDetectModel(model_path=model_path)
    return _instance


class LangDetectModel:
    def __init__(self, model_path: str):
        self._model = None
        self._model_path = model_path
        self._loaded = False

    def load(self) -> None:
        if self._loaded:
            return
        self._ensure_model_file()
        logger.info(f"Loading fastText LID from {self._model_path} ...")
        try:
            import fasttext  # type: ignore
            # Suppress fasttext's own verbose output
            fasttext.FastText.eprint = lambda *args, **kwargs: None
            self._model = fasttext.load_model(self._model_path)
            logger.info("fastText LID ready (176 languages).")
        except Exception as exc:
            logger.error(f"fastText load failed: {exc}")
        finally:
            self._loaded = True

    def detect(self, text: str) -> dict:
        self.load()
        if self._model is None:
            return {"lang": "en", "confidence": 0.5, "is_english": True, "is_indic": False}

        clean = text.replace("\n", " ").strip()[:500]
        if not clean:
            return {"lang": "en", "confidence": 1.0, "is_english": True, "is_indic": False}

        predictions = self._model.predict(clean, k=1)
        lang = predictions[0][0].replace("__label__", "")
        confidence = float(predictions[1][0])

        return {
            "lang": lang,
            "confidence": round(confidence, 3),
            "is_english": lang == "en",
            "is_indic": lang in _INDIC_LANG_CODES,
        }

    def _ensure_model_file(self) -> None:
        if os.path.exists(self._model_path):
            return
        logger.info(f"Downloading fastText LID model to {self._model_path} ...")
        os.makedirs(os.path.dirname(self._model_path), exist_ok=True)
        urllib.request.urlretrieve(_MODEL_URL, self._model_path)
        logger.info("fastText LID downloaded.")
