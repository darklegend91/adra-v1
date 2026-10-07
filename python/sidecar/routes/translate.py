from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import DEVICE_CONFIG
from models.translate import get_translate_model

router = APIRouter()


class TranslateRequest(BaseModel):
    text: str
    src_lang: str  # fastText 2-letter code e.g. "hi", "ta", "te"


@router.post("/translate")
def translate(body: TranslateRequest):
    try:
        model = get_translate_model(torch_device=DEVICE_CONFIG["torch_device"])
        return model.translate(body.text, body.src_lang)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
