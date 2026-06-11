export interface TocEntry {
  title: string;
  page: number | null;
  depth: number;
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
