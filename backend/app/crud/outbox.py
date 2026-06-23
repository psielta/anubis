import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.outbox import OutboxEvent, OutboxEventType, OutboxStatus


async def enqueue(
    db: AsyncSession,
    *,
    aggregate_id: uuid.UUID,
    event_type: OutboxEventType,
    payload: dict | None = None,
    max_attempts: int | None = None,
) -> OutboxEvent:
    event = OutboxEvent(
        aggregate_id=aggregate_id,
        event_type=event_type.value,
        payload_json=payload or {},
        max_attempts=max_attempts or settings.PDF_CONVERSION_OUTBOX_MAX_ATTEMPTS,
    )
    db.add(event)
    await db.flush()
    return event


async def claim_next(
    db: AsyncSession,
    *,
    worker_id: str,
    event_types: list[OutboxEventType] | None = None,
) -> OutboxEvent | None:
    """Claim one pending outbox row with FOR UPDATE SKIP LOCKED."""
    now = datetime.now(UTC)
    lease = timedelta(seconds=settings.PDF_CONVERSION_OUTBOX_LEASE_SECONDS)

    conditions = [
        OutboxEvent.status == OutboxStatus.PENDING.value,
        or_(OutboxEvent.next_retry_at.is_(None), OutboxEvent.next_retry_at <= now),
        or_(OutboxEvent.locked_until.is_(None), OutboxEvent.locked_until <= now),
    ]
    if event_types:
        types = [t.value for t in event_types]
        conditions.append(OutboxEvent.event_type.in_(types))

    stmt = (
        select(OutboxEvent)
        .where(and_(*conditions))
        .order_by(OutboxEvent.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    result = await db.execute(stmt)
    event = result.scalar_one_or_none()
    if event is None:
        return None

    event.status = OutboxStatus.PROCESSING.value
    event.locked_by = worker_id
    event.locked_until = now + lease
    event.attempts += 1
    await db.flush()
    return event


async def mark_done(db: AsyncSession, event: OutboxEvent) -> None:
    now = datetime.now(UTC)
    event.status = OutboxStatus.DONE.value
    event.processed_at = now
    event.locked_by = None
    event.locked_until = None
    event.error_message = None
    await db.flush()


async def mark_failed(
    db: AsyncSession,
    event: OutboxEvent,
    *,
    error_message: str,
    schedule_retry: bool,
) -> None:
    now = datetime.now(UTC)
    event.error_message = error_message
    event.locked_by = None
    event.locked_until = None

    if schedule_retry and event.attempts < event.max_attempts:
        backoff = min(300, 2 ** event.attempts * 5)
        event.status = OutboxStatus.PENDING.value
        event.next_retry_at = now + timedelta(seconds=backoff)
    else:
        event.status = OutboxStatus.FAILED.value
        event.processed_at = now
    await db.flush()


async def pending_count(db: AsyncSession) -> int:
    from sqlalchemy import func

    stmt = select(func.count()).select_from(OutboxEvent).where(
        OutboxEvent.status == OutboxStatus.PENDING.value
    )
    result = await db.execute(stmt)
    return int(result.scalar_one())