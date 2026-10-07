from fastapi import APIRouter

from config import DEVICE_CONFIG

router = APIRouter()


@router.get("/health")
def health():
    return {
        "ok": True,
        "service": "ADRA ML Sidecar",
        "device_config": DEVICE_CONFIG,
    }
