export interface TocEntry {
  title: string;
  page: number | null;
  depth: number;
}

export type ReaderPanel = 'assistant' | 'diagrams' | 'notes' | 'toc' | 'content_tree';
export type ReaderSubView = 'list' | 'edit';

export interface ReaderNotesState {
  view: ReaderSubView;
  active_id: number | null;
  search: string;
}

export interface ReaderDiagramsState {
  view: ReaderSubView;
  active_id: number | null;
}

export interface ReaderState {
  version: 1;
  zoom_pct: number;
  panel: ReaderPanel | null;
  panel_width_px: number;
  notes: ReaderNotesState;
  diagrams: ReaderDiagramsState;
}

export interface Book {
  id: number;
  title: string;
  author: string | null;
  file_format: string;
  content_type: string;
  file_size: number;
  original_filename: string;
  has_cover: boolean;
  last_page: number | null;
  page_count: number | null;
  toc: TocEntry[] | null;
  reader_state: ReaderState | null;
  collection_ids: number[];
  created_at: string;
}

export interface BookPage {
  items: Book[];
  total: number;
  page: number;
  page_size: number;
}

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  id: number; // local client id (incrementing counter)
  file: File;
  status: UploadStatus;
  progress: number; // 0..100
  error?: string;
  book?: Book; // populated on success
}
