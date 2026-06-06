from collections.abc import AsyncIterator

import aioboto3

from app.core.config import settings


class StorageService:
    def __init__(self) -> None:
        self._session = aioboto3.Session()

    def _client(self):
        return self._session.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
        )

    async def upload(self, key: str, body: bytes, content_type: str) -> None:
        async with self._client() as s3:
            await s3.put_object(
                Bucket=settings.S3_BUCKET, Key=key, Body=body, ContentType=content_type
            )

    async def stream(self, key: str) -> AsyncIterator[bytes]:
        async with self._client() as s3:
            resp = await s3.get_object(Bucket=settings.S3_BUCKET, Key=key)
            body = resp["Body"]
            try:
                async for chunk in body.iter_chunks(chunk_size=64 * 1024):
                    yield chunk
            finally:
                body.close()

    async def delete(self, key: str) -> None:
        async with self._client() as s3:
            await s3.delete_object(Bucket=settings.S3_BUCKET, Key=key)


storage = StorageService()
