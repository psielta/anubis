export interface TocEntry {
  title: string;
  page: number | null;
  depth: number;
}

export type ReaderPanel =
  | 'assistant'
  | 'diagrams'
  | 'exercises'
  | 'notes'
  | 'sketches'
  | 'latex'
  | 'toc'
  | 'content_tree'
  | 'translate';
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

export interface ReaderSketchesState {
  view: ReaderSubView;
  active_id: number | null;
  active_group_id: number | null;
  search: string;
}

export interface ReaderLatexState {
  view: ReaderSubView;
  active_id: number | null;
  active_group_id: number | null;
  search: string;
}

export interface ReaderExercisesState {
  view: ReaderSubView;
  active_id: number | null;
  search: string;
}

export interface ReaderState {
  version: 1;
  zoom_pct: number;
  panel: ReaderPanel | null;
  panel_width_px: number;
  notes: ReaderNotesState;
  diagrams: ReaderDiagramsState;
  sketches: ReaderSketchesState;
  latex: ReaderLatexState;
  exercises: ReaderExercisesState;
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
  is_favorite: boolean;
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

export type BookStatus = 'all' | 'favorites' | 'plan_to_read' | 'completed';
export type BookSort = 'date' | 'title' | 'series';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  id: number; // local client id (incrementing counter)
  file: File;
  status: UploadStatus;
  progress: number; // 0..100
  error?: string;
  book?: Book; // populated on success
}
