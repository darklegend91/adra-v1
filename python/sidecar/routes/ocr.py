import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import DEVICE_CONFIG
from models.ocr import get_ocr_model

router = APIRouter()


class OcrRequest(BaseModel):
    image_b64: str
    lang: str = "en"
    run_structure: bool = False


@router.post("/ocr")
def ocr(body: OcrRequest):
    try:
        image_bytes = base64.b64decode(body.image_b64)
        model = get_ocr_model(use_gpu=DEVICE_CONFIG["paddle_gpu"])

        if not model.available:
            raise HTTPException(503, "paddleocr not installed on this sidecar.")

        result = model.run_ocr(image_bytes, lang=body.lang)

        if body.run_structure:
            structure = model.run_structure(image_bytes)
            result["tables"] = structure["tables"]
            result["regions"] = structure["regions"]

        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
