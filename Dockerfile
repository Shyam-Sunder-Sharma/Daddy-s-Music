FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY . .

# Create writable data directory for Hugging Face Spaces non-root user (uid=1000)
RUN mkdir -p /tmp/.daddys_music_data/audio_cache && chmod -R 777 /tmp/.daddys_music_data /app

ENV PORT=7860
ENV DADDY_MUSIC_DATA_DIR=/tmp/.daddys_music_data

EXPOSE 7860

CMD ["sh", "-c", "gunicorn --chdir backend --worker-class gthread --workers 1 --threads 64 --timeout 120 --bind 0.0.0.0:${PORT:-7860} app:app"]
