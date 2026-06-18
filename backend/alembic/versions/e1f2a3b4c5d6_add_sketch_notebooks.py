"""add sketch notebooks

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-06-18 21:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e1f2a3b4c5d6'
down_revision: Union[str, Sequence[str], None] = 'd0e1f2a3b4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'sketch_groups',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('book_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('position', sa.Integer(), server_default='0', nullable=False),
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
    )
    op.create_index(
        op.f('ix_sketch_groups_book_id'), 'sketch_groups', ['book_id'], unique=False
    )
    op.create_index(
        'ix_sketch_groups_book_user_position',
        'sketch_groups',
        ['book_id', 'user_id', 'position'],
        unique=False,
    )
    op.create_index(
        op.f('ix_sketch_groups_user_id'), 'sketch_groups', ['user_id'], unique=False
    )

    op.create_table(
        'sketches',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('book_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('group_id', sa.Integer(), nullable=True),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('page', sa.Integer(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ['group_id'], ['sketch_groups.id'], ondelete='SET NULL'
        ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_sketches_book_id'), 'sketches', ['book_id'], unique=False)
    op.create_index(
        op.f('ix_sketches_group_id'), 'sketches', ['group_id'], unique=False
    )
    op.create_index(op.f('ix_sketches_user_id'), 'sketches', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_sketches_user_id'), table_name='sketches')
    op.drop_index(op.f('ix_sketches_group_id'), table_name='sketches')
    op.drop_index(op.f('ix_sketches_book_id'), table_name='sketches')
    op.drop_table('sketches')
    op.drop_index(op.f('ix_sketch_groups_user_id'), table_name='sketch_groups')
    op.drop_index(
        'ix_sketch_groups_book_user_position', table_name='sketch_groups'
    )
    op.drop_index(op.f('ix_sketch_groups_book_id'), table_name='sketch_groups')
    op.drop_table('sketch_groups')
