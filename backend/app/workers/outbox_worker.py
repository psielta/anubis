"""Outbox poller with FOR UPDATE SKIP LOCKED lease semantics."""

from __future__ import annotations

import asyncio
import logging
import socket
import uuid

from app.core.config import settings
from app.crud import outbox as outbox_crud
from app.db.session import AsyncSessionLocal
from app.models.outbox import OutboxEventType
from app.models.pdf_conversion import (
    PdfConversionErrorCode,
    PdfConversionJob,
    PdfConversionStatus,
)
from app.services import pdf_conversion_service
from app.workers.pdf_conversion_worker import process_conversion

logger = logging.getLogger(__name__)

_CONVERSION_EVENTS = [
    OutboxEventType.PDF_CONVERSION_REQUESTED,
    OutboxEventType.PDF_CONVERSION_RETRY_REQUESTED,
    OutboxEventType.PDF_CONVERSION_CANCEL_REQUESTED,
]

WORKER_ID = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"


async def process_one() -> bool:
    async with AsyncSessionLocal() as db:
        event = await outbox_crud.claim_next(
            db, worker_id=WORKER_ID, event_types=_CONVERSION_EVENTS
        )
        if event is None:
            return False

        try:
            if event.event_type == OutboxEventType.PDF_CONVERSION_CANCEL_REQUESTED.value:
                await process_conversion(db, event)
                await outbox_crud.mark_done(db, event)
                await db.commit()
                return True

            await process_conversion(db, event)
            await db.refresh(event)
            job = await db.get(PdfConversionJob, event.aggregate_id)
            if job and job.status == PdfConversionStatus.FAILED.value:
                await outbox_crud.mark_failed(
                    db,
                    event,
                    error_message=job.error_message or "conversion failed",
                    schedule_retry=event.attempts < event.max_attempts,
                )
            else:
                await outbox_crud.mark_done(db, event)
            await db.commit()
        except Exception as exc:
            logger.exception("Outbox event %s failed", event.id)
            await db.rollback()
            async with AsyncSessionLocal() as err_db:
                fresh = await err_db.get(type(event), event.id)
                if fresh:
                    from app.crud import pdf_conversion as job_crud

                    job = await job_crud.get_by_id(err_db, fresh.aggregate_id)
                    if job:
                        pdf_conversion_service.mark_failed(
                            job,
                            error_code=PdfConversionErrorCode.CONVERSION_FAILED,
                            message=str(exc)[:2000],
                        )
                    await outbox_crud.mark_failed(
                        err_db,
                        fresh,
                        error_message=str(exc)[:2000],
                        schedule_retry=fresh.attempts < fresh.max_attempts,
                    )
                    await err_db.commit()
        return True


async def run_loop() -> None:
    poll = settings.PDF_CONVERSION_OUTBOX_POLL_SECONDS
    logger.info("Outbox worker %s started (poll=%ss)", WORKER_ID, poll)
    while True:
        processed = await process_one()
        if not processed:
            await asyncio.sleep(poll)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_loop())


if __name__ == "__main__":
    main()