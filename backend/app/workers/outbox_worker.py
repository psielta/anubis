"""Outbox poller with FOR UPDATE SKIP LOCKED lease semantics."""

from __future__ import annotations

import asyncio
import logging
import socket
import uuid

from app.core.config import settings
from app.crud import outbox as outbox_crud
from app.db.session import AsyncSessionLocal
from app.models.outbox import OutboxEvent, OutboxEventType
from app.models.pdf_conversion import (
    PdfConversionErrorCode,
    PdfConversionJob,
    PdfConversionStatus,
)
from app.models.rag import RagStatus
from app.services import pdf_conversion_service
from app.workers.pdf_conversion_worker import process_conversion
from app.workers.rag_worker import RagWorkerError, process_rag_event

logger = logging.getLogger(__name__)

_CONVERSION_EVENTS = [
    OutboxEventType.PDF_CONVERSION_REQUESTED,
    OutboxEventType.PDF_CONVERSION_RETRY_REQUESTED,
    OutboxEventType.PDF_CONVERSION_CANCEL_REQUESTED,
]

_RAG_EVENTS = [
    OutboxEventType.RAG_INDEX_REQUESTED,
    OutboxEventType.RAG_REINDEX_REQUESTED,
]

_ALL_EVENTS = _CONVERSION_EVENTS + _RAG_EVENTS
_RAG_EVENT_VALUES = {e.value for e in _RAG_EVENTS}

WORKER_ID = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"


async def _handle_conversion(db, event: OutboxEvent) -> None:
    if event.event_type == OutboxEventType.PDF_CONVERSION_CANCEL_REQUESTED.value:
        await process_conversion(db, event)
        await outbox_crud.mark_done(db, event)
        await db.commit()
        return

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


async def _handle_rag(db, event: OutboxEvent) -> None:
    """Process one RAG outbox event; never re-raise handled RagWorkerError."""
    from app.crud import rag as rag_crud

    event_id = event.id
    try:
        await process_rag_event(db, event)
    except RagWorkerError as exc:
        # Already committed document side-effects inside process_rag_event.
        await db.rollback()
        async with AsyncSessionLocal() as err_db:
            fresh = await err_db.get(OutboxEvent, event_id)
            if fresh is None:
                return
            schedule = exc.retryable and fresh.attempts < fresh.max_attempts
            await outbox_crud.mark_failed(
                err_db,
                fresh,
                error_message=str(exc)[:2000],
                schedule_retry=schedule,
            )
            if not schedule:
                # Exhausted retries or non-retryable raise path: terminal fail.
                doc = await rag_crud.get_document_by_id(err_db, fresh.aggregate_id)
                if doc and doc.status != RagStatus.COMPLETED.value:
                    await rag_crud.mark_failed(
                        err_db,
                        doc,
                        error_code=exc.error_code,
                        message=str(exc)[:2000],
                    )
            await err_db.commit()
        return

    # Clean return from process_rag_event (success or non-retryable terminal).
    doc = await rag_crud.get_document_by_id(db, event.aggregate_id)
    if doc and doc.status == RagStatus.FAILED.value:
        await outbox_crud.mark_failed(
            db,
            event,
            error_message=doc.error_message or "rag indexing failed",
            schedule_retry=False,
        )
    else:
        await outbox_crud.mark_done(db, event)
    await db.commit()


async def process_one() -> bool:
    async with AsyncSessionLocal() as db:
        event = await outbox_crud.claim_next(
            db, worker_id=WORKER_ID, event_types=_ALL_EVENTS
        )
        if event is None:
            return False

        event_id = event.id
        try:
            if event.event_type in _RAG_EVENT_VALUES:
                await _handle_rag(db, event)
            else:
                await _handle_conversion(db, event)
        except Exception as exc:
            # Unexpected errors only (RagWorkerError is fully handled in _handle_rag).
            logger.exception("Outbox event %s failed", event_id)
            await db.rollback()
            async with AsyncSessionLocal() as err_db:
                fresh = await err_db.get(OutboxEvent, event_id)
                if fresh is None:
                    return True
                if fresh.event_type in _RAG_EVENT_VALUES:
                    from app.crud import rag as rag_crud

                    schedule = fresh.attempts < fresh.max_attempts
                    await outbox_crud.mark_failed(
                        err_db,
                        fresh,
                        error_message=str(exc)[:2000],
                        schedule_retry=schedule,
                    )
                    if not schedule:
                        doc = await rag_crud.get_document_by_id(
                            err_db, fresh.aggregate_id
                        )
                        if doc and doc.status not in (
                            RagStatus.FAILED.value,
                            RagStatus.COMPLETED.value,
                        ):
                            await rag_crud.mark_failed(
                                err_db,
                                doc,
                                error_code="indexing_failed",
                                message=str(exc)[:2000],
                            )
                else:
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
