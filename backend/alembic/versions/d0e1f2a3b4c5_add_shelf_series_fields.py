"""add shelf series fields

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-06-18 18:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd0e1f2a3b4c5'
down_revision: Union[str, Sequence[str], None] = 'c9d0e1f2a3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'books',
        sa.Column(
            'is_favorite',
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )
    op.add_column(
        'book_collections',
        sa.Column('position', sa.Integer(), server_default='0', nullable=False),
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                bc.book_id,
                bc.collection_id,
                row_number() OVER (
                    PARTITION BY bc.collection_id
                    ORDER BY b.created_at ASC, b.id ASC
                ) - 1 AS position
            FROM book_collections bc
            JOIN books b ON b.id = bc.book_id
        )
        UPDATE book_collections bc
        SET position = ranked.position
        FROM ranked
        WHERE
            bc.book_id = ranked.book_id
            AND bc.collection_id = ranked.collection_id
        """
    )
    op.create_index(
        'ix_book_collections_collection_position',
        'book_collections',
        ['collection_id', 'position'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        'ix_book_collections_collection_position',
        table_name='book_collections',
    )
    op.drop_column('book_collections', 'position')
    op.drop_column('books', 'is_favorite')
