"""
ADRA ML Sidecar — FastAPI microservice for local ML inference.

Endpoints:
  GET  /health         — liveness + device info
  POST /ocr            — PP-OCRv5 image/scanned-PDF OCR
  POST /ner            — scispaCy clinical entity extraction
  POST /translate      — IndicTrans2 Indic→English translation
  POST /voice          — faster-whisper speech-to-text
  POST /detect-lang    — fastText language identification
  POST /extract-pdf    — pdfplumber layout-aware PDF text + table extraction

Run:
  cd python/sidecar
  uvicorn main:app --host 127.0.0.1 --port 7070
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from config import DEVICE_CONFIG, FASTTEXT_MODEL_PATH
from routes import credibility, health, langdetect, ner, ocr, pdf_extract, translate, voice

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info(f"ADRA Sidecar starting — device config: {DEVICE_CONFIG}")

    # Pre-warm lightweight models so the first request is fast.
    # Heavy models (OCR, voice, translate) load lazily on first request
    # to avoid OOM if some packages are not installed.
    from models.langdetect import get_langdetect_model
    from models.ner import get_ner_model

    get_langdetect_model(model_path=FASTTEXT_MODEL_PATH).load()
    get_ner_model().load()

    logger.info("ADRA Sidecar ready.")
    yield
    logger.info("ADRA Sidecar shutting down.")


app = FastAPI(
    title="ADRA ML Sidecar",
    version="1.0.0",
    description="Local ML inference for OCR, NER, translation, and voice.",
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(ocr.router)
app.include_router(ner.router)
app.include_router(translate.router)
app.include_router(voice.router)
app.include_router(langdetect.router)
app.include_router(pdf_extract.router)
app.include_router(credibility.router)
