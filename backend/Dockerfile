FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CHANDRA_ENV=production

WORKDIR /app

COPY backend/requirements-prod.txt backend/requirements-prod.txt
RUN pip install --no-cache-dir -r backend/requirements-prod.txt

COPY backend backend

EXPOSE 8000

CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
