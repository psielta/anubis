"""add word documents

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-06-29 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f7a8b9c0d1e2'
down_revision: Union[str, Sequence[str], None] = 'e6f7a8b9c0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'word_documents',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('book_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('page', sa.Integer(), nullable=True),
        sa.Column('object_key', sa.String(length=1024), nullable=False),
        sa.Column('file_size', sa.BigInteger(), nullable=False),
        sa.Column('content_type', sa.String(length=120), nullable=False),
        sa.Column('revision', sa.Integer(), server_default='1', nullable=False),
        sa.Column('last_saved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(['book_id'], ['books.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('object_key'),
    )
    op.create_index(
        op.f('ix_word_documents_book_id'),
        'word_documents',
        ['book_id'],
        unique=False,
    )
    op.create_index(
        'ix_word_documents_book_user_updated',
        'word_documents',
        ['book_id', 'user_id', 'updated_at'],
        unique=False,
    )
    op.create_index(
        op.f('ix_word_documents_user_id'),
        'word_documents',
        ['user_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_word_documents_user_id'), table_name='word_documents')
    op.drop_index(
        'ix_word_documents_book_user_updated',
        table_name='word_documents',
    )
    op.drop_index(op.f('ix_word_documents_book_id'), table_name='word_documents')
    op.drop_table('word_documents')
