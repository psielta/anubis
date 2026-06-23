"""SSE helpers for PDF conversion events."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from app.models.pdf_conversion import PdfConversionJob
from app.services.redis_pubsub_service import RedisPubSubService, channel_for_job


def sse_frame(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def job_snapshot_event(job: PdfConversionJob) -> dict[str, Any]:
    return {
        "job_id": str(job.id),
        "status": job.status,
        "progress": job.progress,
        "message": None,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "timestamp": datetime.now(UTC).isoformat(),
        "seq": 0,
    }


def _event_key(data: dict[str, Any]) -> str:
    ts = data.get("timestamp", "")
    seq = data.get("seq", "")
    status = data.get("status", "")
    progress = data.get("progress", "")
    return f"{ts}:{seq}:{status}:{progress}"


_TERMINAL = frozenset({"completed", "failed", "canceled"})


async def stream_job_events(
    job_id: UUID,
    redis: RedisPubSubService,
    fetch_job: Callable[[], Awaitable[PdfConversionJob]],
    *,
    heartbeat_seconds: float = 15.0,
) -> AsyncIterator[str]:
    """
    Subscribe to Redis first, then read DB snapshot (subscribe-before-snapshot).
    """
    await redis.connect()
    channel = channel_for_job(job_id)
    ps = redis.pubsub()
    await ps.subscribe(channel)

    seen: set[str] = set()
    try:
        job = await fetch_job()
        snapshot = job_snapshot_event(job)
        seen.add(_event_key(snapshot))
        yield sse_frame("progress", snapshot)

        if job.status in _TERMINAL:
            return

        last_ping = asyncio.get_event_loop().time()
        while True:
            message = await ps.get_message(
                ignore_subscribe_messages=True, timeout=1.0
            )
            if message and message.get("type") == "message":
                raw = message.get("data")
                if isinstance(raw, str):
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = None
                    if data:
                        key = _event_key(data)
                        if key not in seen:
                            seen.add(key)
                            yield sse_frame("progress", data)
                            if data.get("status") in _TERMINAL:
                                return

            now = asyncio.get_event_loop().time()
            if now - last_ping >= heartbeat_seconds:
                yield ": ping\n\n"
                last_ping = now
    finally:
        await ps.unsubscribe(channel)
        await ps.aclose()