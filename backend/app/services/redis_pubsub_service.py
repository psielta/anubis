"""Redis Pub/Sub for ephemeral PDF conversion progress events."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis

from app.core.config import settings

_CHANNEL_PREFIX = "pdf_conversion:"


def channel_for_job(job_id: uuid.UUID) -> str:
    return f"{_CHANNEL_PREFIX}{job_id}"


class RedisPubSubService:
    def __init__(self, url: str | None = None) -> None:
        self._url = url or settings.REDIS_URL
        self._client: aioredis.Redis | None = None

    async def connect(self) -> None:
        if self._client is None:
            self._client = aioredis.from_url(self._url, decode_responses=True)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def publish_event(
        self,
        job_id: uuid.UUID,
        *,
        status: str,
        progress: int,
        message: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        seq: int | None = None,
    ) -> None:
        await self.connect()
        assert self._client is not None
        payload = {
            "job_id": str(job_id),
            "status": status,
            "progress": progress,
            "message": message,
            "error_code": error_code,
            "error_message": error_message,
            "timestamp": datetime.now(UTC).isoformat(),
            "seq": seq,
        }
        await self._client.publish(channel_for_job(job_id), json.dumps(payload))

    def pubsub(self) -> Any:
        assert self._client is not None
        return self._client.pubsub()


redis_pubsub = RedisPubSubService()