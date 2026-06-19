export interface LatexNotebookGroup {
  id: number;
  book_id: number;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface LatexNotebookGroupCreate {
  name: string;
}

export interface LatexNotebookGroupUpdate {
  name?: string;
  position?: number;
}

export interface LatexNotebook {
  id: number;
  book_id: number;
  group_id: number | null;
  title: string;
  content: string; // LaTeX source
  page: number | null;
  created_at: string;
  updated_at: string;
}

export interface LatexNotebookCreate {
  title: string;
  content?: string;
  group_id?: number | null;
  page?: number | null;
}

export interface LatexNotebookUpdate {
  title?: string;
  content?: string;
  group_id?: number | null;
  page?: number | null;
}
