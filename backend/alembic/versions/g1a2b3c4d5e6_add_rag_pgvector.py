"""add rag documents, chunks, pgvector hnsw

Revision ID: g1a2b3c4d5e6
Revises: f7a8b9c0d1e2
Create Date: 2026-07-26 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "g1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "f7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RAG_EMBEDDING_DIM = 768


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "rag_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("book_id", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "chunk_count", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(length=32), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("book_id"),
    )
    op.create_index(
        op.f("ix_rag_documents_book_id"), "rag_documents", ["book_id"], unique=True
    )
    op.create_index(
        op.f("ix_rag_documents_owner_id"),
        "rag_documents",
        ["owner_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_rag_documents_status"), "rag_documents", ["status"], unique=False
    )

    # Vector column via raw SQL so Alembic does not require pgvector dialect
    # registered on the offline path.
    op.execute(
        f"""
        CREATE TABLE rag_chunks (
            id UUID PRIMARY KEY,
            document_id UUID NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
            book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            title VARCHAR(512) NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            page_start INTEGER,
            page_end INTEGER,
            embedding vector({RAG_EMBEDDING_DIM}) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_rag_chunk_doc_index UNIQUE (document_id, chunk_index)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_rag_chunks_document_id ON rag_chunks (document_id)"
    )
    op.execute("CREATE INDEX ix_rag_chunks_book_id ON rag_chunks (book_id)")
    # HNSW for cosine similarity (Gemini embeddings are typically L2-normalized;
    # cosine distance is the right metric for retrieval).
    op.execute(
        """
        CREATE INDEX ix_rag_chunks_embedding_hnsw
        ON rag_chunks
        USING hnsw (embedding vector_cosine_ops)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_rag_chunks_embedding_hnsw")
    op.execute("DROP INDEX IF EXISTS ix_rag_chunks_book_id")
    op.execute("DROP INDEX IF EXISTS ix_rag_chunks_document_id")
    op.execute("DROP TABLE IF EXISTS rag_chunks")
    op.drop_index(op.f("ix_rag_documents_status"), table_name="rag_documents")
    op.drop_index(op.f("ix_rag_documents_owner_id"), table_name="rag_documents")
    op.drop_index(op.f("ix_rag_documents_book_id"), table_name="rag_documents")
    op.drop_table("rag_documents")
