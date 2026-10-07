"""
IndicTrans2 distilled (200M) — Indic ↔ English translation.
Covers all 22 Indian scheduled languages.
Singleton pattern: one instance loaded per process.
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# fastText 2-letter code → IndicTrans2 Flores language code
LANG_CODE_MAP: dict[str, str] = {
    "hi": "hin_Deva",
    "bn": "ben_Beng",
    "ta": "tam_Taml",
    "te": "tel_Telu",
    "mr": "mar_Deva",
    "gu": "guj_Gujr",
    "kn": "kan_Knda",
    "ml": "mal_Mlym",
    "pa": "pan_Guru",
    "or": "ory_Orya",
    "as": "asm_Beng",
    "ur": "urd_Arab",
    "sa": "san_Deva",
    "ne": "npi_Deva",
    "sd": "snd_Arab",
    "ks": "kas_Arab",
    "mai": "mai_Deva",
    "en": "eng_Latn",
}
_ENGLISH_CODES = frozenset({"en", "eng_Latn"})

_instance: Optional["TranslateModel"] = None


def get_translate_model(torch_device: str = "cpu") -> "TranslateModel":
    global _instance
    if _instance is None:
        _instance = TranslateModel(torch_device=torch_device)
    return _instance


class TranslateModel:
    _MODEL_ID = "ai4bharat/indictrans2-indic-en-dist-200M"

    def __init__(self, torch_device: str = "cpu"):
        self._model = None
        self._tokenizer = None
        self._device = torch_device
        self._loaded = False

    def load(self) -> None:
        if self._loaded:
            return
        logger.info(f"Loading IndicTrans2 distilled on {self._device} ...")
        try:
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer  # type: ignore
            self._tokenizer = AutoTokenizer.from_pretrained(
                self._MODEL_ID, trust_remote_code=True
            )
            self._model = AutoModelForSeq2SeqLM.from_pretrained(
                self._MODEL_ID, trust_remote_code=True
            ).to(self._device)
            self._model.eval()
            logger.info("IndicTrans2 ready.")
        except Exception as exc:
            logger.warning(f"IndicTrans2 load failed ({exc}) — translation disabled.")
        finally:
            self._loaded = True

    def translate(self, text: str, src_lang_code: str) -> dict:
        self.load()
        indic_code = LANG_CODE_MAP.get(src_lang_code, src_lang_code)

        # Skip if already English or model unavailable
        if indic_code in _ENGLISH_CODES or self._model is None:
            return {
                "translated": text,
                "src_lang": src_lang_code,
                "tgt_lang": "eng_Latn",
                "was_translated": False,
            }

        try:
            import torch  # type: ignore
            inputs = self._tokenizer(
                text,
                src_lang=indic_code,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512,
            ).to(self._device)

            with torch.no_grad():
                tokens = self._model.generate(
                    **inputs,
                    tgt_lang="eng_Latn",
                    max_new_tokens=512,
                    num_beams=4,
                    early_stopping=True,
                )

            translated = self._tokenizer.batch_decode(
                tokens, skip_special_tokens=True, clean_up_tokenization_spaces=True
            )[0]

            return {
                "translated": translated,
                "src_lang": indic_code,
                "tgt_lang": "eng_Latn",
                "was_translated": True,
            }
        except Exception as exc:
            logger.error(f"Translation error: {exc}")
            return {
                "translated": text,
                "src_lang": src_lang_code,
                "tgt_lang": "eng_Latn",
                "was_translated": False,
            }
