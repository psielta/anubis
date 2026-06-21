"""add exercise resolutions

Revision ID: b2c3d4e5f6a7
Revises: f2a3b4c5d6e7
Create Date: 2026-06-20 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'f2a3b4c5d6e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'exercise_resolutions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('book_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('page', sa.Integer(), nullable=False),
        sa.Column('region', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('statement', sa.Text(), server_default='', nullable=False),
        sa.Column('latex_content', sa.Text(), server_default='', nullable=False),
        sa.Column('sketch_content', sa.Text(), server_default='', nullable=False),
        sa.Column(
            'status', sa.String(length=16), server_default='pending', nullable=False
        ),
        sa.Column('ai_feedback', sa.Text(), nullable=True),
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
        op.f('ix_exercise_resolutions_book_id'),
        'exercise_resolutions',
        ['book_id'],
        unique=False,
    )
    op.create_index(
        op.f('ix_exercise_resolutions_user_id'),
        'exercise_resolutions',
        ['user_id'],
        unique=False,
    )

    op.create_table(
        'exercise_attempts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('resolution_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('latex_content', sa.Text(), server_default='', nullable=False),
        sa.Column('sketch_content', sa.Text(), server_default='', nullable=False),
        sa.Column('ai_feedback', sa.Text(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['resolution_id'], ['exercise_resolutions.id'], ondelete='CASCADE'
        ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_exercise_attempts_resolution_id'),
        'exercise_attempts',
        ['resolution_id'],
        unique=False,
    )
    op.create_index(
        op.f('ix_exercise_attempts_user_id'),
        'exercise_attempts',
        ['user_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        op.f('ix_exercise_attempts_user_id'), table_name='exercise_attempts'
    )
    op.drop_index(
        op.f('ix_exercise_attempts_resolution_id'), table_name='exercise_attempts'
    )
    op.drop_table('exercise_attempts')
    op.drop_index(
        op.f('ix_exercise_resolutions_user_id'), table_name='exercise_resolutions'
    )
    op.drop_index(
        op.f('ix_exercise_resolutions_book_id'), table_name='exercise_resolutions'
    )
    op.drop_table('exercise_resolutions')
