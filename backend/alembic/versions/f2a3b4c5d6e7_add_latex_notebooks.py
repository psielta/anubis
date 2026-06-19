"""add latex notebooks

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-06-18 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f2a3b4c5d6e7'
down_revision: Union[str, Sequence[str], None] = 'e1f2a3b4c5d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'latex_notebook_groups',
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
        op.f('ix_latex_notebook_groups_book_id'),
        'latex_notebook_groups',
        ['book_id'],
        unique=False,
    )
    op.create_index(
        'ix_latex_notebook_groups_book_user_position',
        'latex_notebook_groups',
        ['book_id', 'user_id', 'position'],
        unique=False,
    )
    op.create_index(
        op.f('ix_latex_notebook_groups_user_id'),
        'latex_notebook_groups',
        ['user_id'],
        unique=False,
    )

    op.create_table(
        'latex_notebooks',
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
            ['group_id'], ['latex_notebook_groups.id'], ondelete='SET NULL'
        ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_latex_notebooks_book_id'),
        'latex_notebooks',
        ['book_id'],
        unique=False,
    )
    op.create_index(
        op.f('ix_latex_notebooks_group_id'),
        'latex_notebooks',
        ['group_id'],
        unique=False,
    )
    op.create_index(
        op.f('ix_latex_notebooks_user_id'),
        'latex_notebooks',
        ['user_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_latex_notebooks_user_id'), table_name='latex_notebooks')
    op.drop_index(op.f('ix_latex_notebooks_group_id'), table_name='latex_notebooks')
    op.drop_index(op.f('ix_latex_notebooks_book_id'), table_name='latex_notebooks')
    op.drop_table('latex_notebooks')
    op.drop_index(
        op.f('ix_latex_notebook_groups_user_id'),
        table_name='latex_notebook_groups',
    )
    op.drop_index(
        'ix_latex_notebook_groups_book_user_position',
        table_name='latex_notebook_groups',
    )
    op.drop_index(
        op.f('ix_latex_notebook_groups_book_id'),
        table_name='latex_notebook_groups',
    )
    op.drop_table('latex_notebook_groups')
