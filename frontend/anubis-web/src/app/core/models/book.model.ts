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
  collection_ids: number[];
  created_at: string;
}

export interface BookPage {
  items: Book[];
  total: number;
  page: number;
  page_size: number;
}