FROM python:3.13-slim

WORKDIR /app

RUN addgroup --system anubis && adduser --system --ingroup anubis anubis

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini .
COPY alembic/ ./alembic/
COPY app/ ./app/

RUN chown -R anubis:anubis /app
USER anubis

EXPOSE 8000

ENTRYPOINT ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2"]