"""add reading progress

Revision ID: c3d4e5f6a7b8
Revises: b2f1a9c7d4e3
Create Date: 2026-06-06 13:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, Sequence[str], None] = 'b2f1a9c7d4e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('books', sa.Column('last_page', sa.Integer(), nullable=True))
    op.add_column('books', sa.Column('page_count', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('books', 'page_count')
    op.drop_column('books', 'last_page')
