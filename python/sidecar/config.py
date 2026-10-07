import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format="[ADRA-Sidecar] %(asctime)s %(levelname)s — %(message)s",
    datefmt="%H:%M:%S",
)

# ── Server ────────────────────────────────────────────────────────────────────
SIDECAR_PORT = int(os.environ.get("SIDECAR_PORT", 7070))
SIDECAR_HOST = os.environ.get("SIDECAR_HOST", "127.0.0.1")

# ── Model storage ─────────────────────────────────────────────────────────────
MODEL_CACHE_DIR = os.environ.get(
    "MODEL_CACHE_DIR", os.path.expanduser("~/.adra_models")
)
FASTTEXT_MODEL_PATH = os.environ.get(
    "FASTTEXT_MODEL_PATH",
    os.path.join(MODEL_CACHE_DIR, "lid.176.ftz"),
)
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "medium")


# ── Device detection ──────────────────────────────────────────────────────────
def _detect_devices() -> dict:
    """
    Probe the environment for CUDA / Apple MPS / CPU.
    Returns separate flags for PaddlePaddle, PyTorch, and faster-whisper
    because each library has its own device API.
    """
    paddle_gpu = False
    torch_device = "cpu"
    whisper_device = "cpu"
    whisper_compute = "int8"

    # PaddlePaddle GPU probe
    try:
        import paddle  # type: ignore

        if (
            paddle.device.is_compiled_with_cuda()
            and paddle.device.cuda.device_count() > 0
        ):
            paddle_gpu = True
    except Exception:
        pass

    # PyTorch / MPS probe (used by IndicTrans2 + faster-whisper)
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch_device = "cuda"
            whisper_device = "cuda"
            whisper_compute = "float16"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            torch_device = "mps"
            whisper_device = "cpu"   # faster-whisper does not support MPS
            whisper_compute = "float32"
    except Exception:
        pass

    return {
        "paddle_gpu": paddle_gpu,
        "torch_device": torch_device,
        "whisper_device": whisper_device,
        "whisper_compute": whisper_compute,
    }


DEVICE_CONFIG = _detect_devices()
