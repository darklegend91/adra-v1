from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from models.ner import get_ner_model

router = APIRouter()


class NerRequest(BaseModel):
    text: str


@router.post("/ner")
def ner(body: NerRequest):
    try:
        model = get_ner_model()
        return model.extract(body.text)
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
