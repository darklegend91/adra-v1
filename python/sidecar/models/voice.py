"""
faster-whisper speech-to-text transcription.
Supports GPU (float16) and CPU (int8).
Singleton pattern: one instance loaded per process.
"""
import logging
import os
import tempfile
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from faster_whisper import WhisperModel  # type: ignore
    _WHISPER_AVAILABLE = True
except ImportError:
    _WHISPER_AVAILABLE = False
    logger.warning("faster-whisper not installed — /voice endpoint will be disabled.")

_instance: Optional["VoiceModel"] = None


def get_voice_model(
    model_size: str = "medium",
    device: str = "cpu",
    compute_type: str = "int8",
) -> "VoiceModel":
    global _instance
    if _instance is None:
        _instance = VoiceModel(model_size=model_size, device=device, compute_type=compute_type)
    return _instance


class VoiceModel:
    def __init__(self, model_size: str, device: str, compute_type: str):
        self._model = None
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._loaded = False
        self.available = _WHISPER_AVAILABLE

    def load(self) -> None:
        if self._loaded or not _WHISPER_AVAILABLE:
            return
        logger.info(
            f"Loading faster-whisper '{self._model_size}' "
            f"(device={self._device}, compute={self._compute_type}) ..."
        )
        self._model = WhisperModel(
            self._model_size,
            device=self._device,
            compute_type=self._compute_type,
        )
        self._loaded = True
        logger.info("faster-whisper ready.")

    def transcribe(self, audio_bytes: bytes, audio_format: str = "mp3") -> dict:
        self.load()
        if not self._loaded:
            return {"error": "faster-whisper not available", "text": "", "language": ""}

        # Write to temp file — faster-whisper requires a seekable file or path
        suffix = f".{audio_format.lstrip('.')}"
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name

            segments_iter, info = self._model.transcribe(
                tmp_path,
                beam_size=5,
                language=None,      # auto-detect
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
            )

            segments, parts = [], []
            for seg in segments_iter:
                segments.append({
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": seg.text.strip(),
                })
                parts.append(seg.text.strip())

            return {
                "text": " ".join(parts),
                "language": info.language,
                "language_probability": round(info.language_probability, 3),
                "duration": round(info.duration, 2),
                "segments": segments,
            }
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
