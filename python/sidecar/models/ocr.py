"""
PP-OCRv5 OCR + PP-Structure layout/table extraction.
Singleton pattern: one instance loaded per process.
"""
import logging
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

try:
    from paddleocr import PaddleOCR, PPStructure  # type: ignore
    _PADDLE_AVAILABLE = True
except ImportError:
    _PADDLE_AVAILABLE = False
    logger.warning("paddleocr not installed — /ocr endpoint will be disabled.")

_instance: Optional["OcrModel"] = None


def get_ocr_model(use_gpu: bool = False) -> "OcrModel":
    global _instance
    if _instance is None:
        _instance = OcrModel(use_gpu=use_gpu)
    return _instance


class OcrModel:
    def __init__(self, use_gpu: bool = False):
        self._ocr: Optional[object] = None
        self._structure: Optional[object] = None
        self._use_gpu = use_gpu
        self._loaded = False
        self.available = _PADDLE_AVAILABLE

    def load(self) -> None:
        if self._loaded or not _PADDLE_AVAILABLE:
            return
        logger.info(f"Loading PP-OCRv5 (use_gpu={self._use_gpu}) ...")
        self._ocr = PaddleOCR(
            use_angle_cls=True,
            lang="en",
            use_gpu=self._use_gpu,
            show_log=False,
        )
        self._structure = PPStructure(
            table=True,
            ocr=True,
            show_log=False,
            use_gpu=self._use_gpu,
        )
        self._loaded = True
        logger.info("PP-OCRv5 ready.")

    def run_ocr(self, image_bytes: bytes, lang: str = "en") -> dict:
        self.load()
        if not self._loaded:
            return {"error": "paddleocr not available", "text": "", "words": [], "average_confidence": 0.0}

        img = _decode_image(image_bytes)
        result = self._ocr.ocr(img, cls=True)

        words, lines, confidences = [], [], []
        for page in (result or []):
            for item in (page or []):
                bbox, (text, conf) = item
                words.append({
                    "text": text,
                    "confidence": round(float(conf), 3),
                    "bbox": _quad_to_rect(bbox),
                })
                lines.append(text)
                confidences.append(float(conf))

        avg_conf = round(sum(confidences) / len(confidences), 3) if confidences else 0.0
        return {
            "text": "\n".join(lines),
            "words": words,
            "average_confidence": avg_conf,
            "word_count": len(words),
            "engine": "PP-OCRv5",
        }

    def run_structure(self, image_bytes: bytes) -> dict:
        self.load()
        if not self._loaded:
            return {"tables": [], "regions": []}

        img = _decode_image(image_bytes)
        result = self._structure(img)

        tables, regions = [], []
        for region in (result or []):
            rtype = region.get("type", "").lower()
            regions.append({"type": rtype, "bbox": region.get("bbox")})
            if rtype == "table":
                res = region.get("res", {})
                tables.append({
                    "html": res.get("html", ""),
                    "cells": [{"bbox": c} for c in res.get("cell_bbox", [])],
                })

        return {"tables": tables, "regions": regions}


def _decode_image(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes — unsupported format.")
    return img


def _quad_to_rect(bbox) -> dict:
    if not bbox or len(bbox) < 4:
        return {}
    pts = [list(p) for p in bbox]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return {"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)}
