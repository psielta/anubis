export type DiagramType = 'mermaid' | 'excalidraw';

export interface Diagram {
  id: number;
  book_id: number;
  title: string;
  type: DiagramType;
  content: string; // mermaid source OR serialized excalidraw scene JSON
  page: number | null;
  created_at: string;
  updated_at: string;
}

export interface DiagramCreate {
  title: string;
  type: DiagramType;
  content?: string;
  page?: number | null;
}

export interface DiagramUpdate {
  title?: string;
  content?: string;
  page?: number | null;
}
