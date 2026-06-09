export interface Note {
  id: number;
  book_id: number;
  title: string;
  content: string; // Markdown source
  page: number | null;
  created_at: string;
  updated_at: string;
}

export interface NoteCreate {
  title: string;
  content?: string;
  page?: number | null;
}

export interface NoteUpdate {
  title?: string;
  content?: string;
  page?: number | null;
}
