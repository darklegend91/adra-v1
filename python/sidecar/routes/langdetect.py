from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import FASTTEXT_MODEL_PATH
from models.langdetect import get_langdetect_model

router = APIRouter()


class LangDetectRequest(BaseModel):
    text: str


@router.post("/detect-lang")
def detect_lang(body: LangDetectRequest):
    try:
        model = get_langdetect_model(model_path=FASTTEXT_MODEL_PATH)
        return model.detect(body.text)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
