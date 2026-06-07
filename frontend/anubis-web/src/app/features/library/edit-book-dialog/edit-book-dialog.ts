import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Book } from '../../../core/models/book.model';
import { LibraryService } from '../../../core/services/library';

export interface EditBookData {
  book: Book;
}

@Component({
  selector: 'app-edit-book-dialog',
  imports: [MatButtonModule, MatFormFieldModule, MatInputModule, MatIconModule],
  templateUrl: './edit-book-dialog.html',
  styleUrl: './edit-book-dialog.scss',
})
export class EditBookDialog {
  private library = inject(LibraryService);
  private dialogRef = inject<MatDialogRef<EditBookDialog, Book>>(MatDialogRef);
  private data = inject<EditBookData>(MAT_DIALOG_DATA);

  protected readonly book = this.data.book;
  protected readonly editTitle = signal(this.data.book.title);
  protected readonly editAuthor = signal(this.data.book.author ?? '');
  protected readonly savingEdit = signal(false);
  protected readonly error = signal<string | null>(null);

  cancel() {
    this.dialogRef.close();
  }

  save() {
    const title = this.editTitle().trim();
    if (!title) return; // title is required
    const author = this.editAuthor().trim();
    this.savingEdit.set(true);
    this.error.set(null);

    this.library.update(this.book.id, { title, author: author || null }).subscribe({
      next: (updated) => {
        this.savingEdit.set(false);
        this.dialogRef.close(updated);
      },
      error: (e) => {
        this.error.set(e?.error?.detail ?? 'Could not update book');
        this.savingEdit.set(false);
      },
    });
  }
}
