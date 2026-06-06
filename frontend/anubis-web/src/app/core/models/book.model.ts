export interface Book {
  id: number;
  title: string;
  author: string | null;
  file_format: string;
  content_type: string;
  file_size: number;
  original_filename: string;
  created_at: string;
}