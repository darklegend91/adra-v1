FROM node:22-bookworm

ENV NODE_ENV=production \
    PORT=7860 \
    SIDECAR_URL=http://127.0.0.1:7070 \
    SIDECAR_HOST=127.0.0.1 \
    SIDECAR_PORT=7070 \
    MODEL_CACHE_DIR=/tmp/adra-models \
    WHISPER_MODEL_SIZE=tiny \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY python/sidecar/requirements.txt ./python/sidecar/requirements.txt
RUN python3 -m venv /opt/adra-sidecar \
  && /opt/adra-sidecar/bin/pip install --upgrade pip \
  && /opt/adra-sidecar/bin/pip install -r ./python/sidecar/requirements.txt \
  && /opt/adra-sidecar/bin/python -m spacy download en_core_web_sm || true

COPY . .

RUN npm run build \
  && chmod +x scripts/start_hf_space.sh

EXPOSE 7860

CMD ["scripts/start_hf_space.sh"]
