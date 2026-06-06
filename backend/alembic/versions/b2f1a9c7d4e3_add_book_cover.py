"""add book cover

Revision ID: b2f1a9c7d4e3
Revises: 3a48e0e91414
Create Date: 2026-06-06 13:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2f1a9c7d4e3'
down_revision: Union[str, Sequence[str], None] = '3a48e0e91414'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'books', sa.Column('cover_object_key', sa.String(length=1024), nullable=True)
    )
    op.add_column(
        'books', sa.Column('cover_content_type', sa.String(length=100), nullable=True)
    )
    op.add_column('books', sa.Column('cover_file_size', sa.BigInteger(), nullable=True))
    op.create_unique_constraint(
        op.f('uq_books_cover_object_key'), 'books', ['cover_object_key']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f('uq_books_cover_object_key'), 'books', type_='unique')
    op.drop_column('books', 'cover_file_size')
    op.drop_column('books', 'cover_content_type')
    op.drop_column('books', 'cover_object_key')
