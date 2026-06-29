export interface WordDocument {
  id: number;
  book_id: number;
  title: string;
  page: number | null;
  file_size: number;
  revision: number;
  last_saved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WordDocumentCreate {
  title: string;
  page?: number | null;
}

export interface WordDocumentUpdate {
  title?: string;
  page?: number | null;
}

export interface OnlyOfficeEditorConfig {
  document_server_url: string;
  config: Record<string, unknown>;
}
