/** Contracts for book RAG activate / status / query (backend `/books/{id}/rag/*`). */

export type RagApiStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface RagActivateResponse {
  document_id: string;
  book_id: number;
  status: RagApiStatus | string;
  message: string;
}

export interface RagStatusResponse {
  document_id: string;
  book_id: number;
  status: RagApiStatus | string;
  progress: number;
  chunk_count: number;
  page_count: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RagQueryRequest {
  question: string;
  top_k?: number;
}

export interface RagSource {
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  title: string;
  excerpt: string;
  score: number | null;
}

export interface RagQueryResponse {
  book_id: number;
  question: string;
  answer: string;
  sources: RagSource[];
}
