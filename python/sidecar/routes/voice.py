import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import DEVICE_CONFIG, WHISPER_MODEL_SIZE
from models.voice import get_voice_model

router = APIRouter()


class VoiceRequest(BaseModel):
    audio_b64: str
    format: str = "mp3"  # mp3 | wav | ogg | webm | m4a | flac


@router.post("/voice")
def voice(body: VoiceRequest):
    try:
        audio_bytes = base64.b64decode(body.audio_b64)
        model = get_voice_model(
            model_size=WHISPER_MODEL_SIZE,
            device=DEVICE_CONFIG["whisper_device"],
            compute_type=DEVICE_CONFIG["whisper_compute"],
        )
        if not model.available:
            raise HTTPException(503, "faster-whisper not installed on this sidecar.")
        return model.transcribe(audio_bytes, audio_format=body.format)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc
