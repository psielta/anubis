export interface SketchGroup {
  id: number;
  book_id: number;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface SketchGroupCreate {
  name: string;
}

export interface SketchGroupUpdate {
  name?: string;
  position?: number;
}

export interface Sketch {
  id: number;
  book_id: number;
  group_id: number | null;
  title: string;
  content: string; // serialized Excalidraw scene JSON
  page: number | null;
  created_at: string;
  updated_at: string;
}

export interface SketchCreate {
  title: string;
  content?: string;
  group_id?: number | null;
  page?: number | null;
}

export interface SketchUpdate {
  title?: string;
  content?: string;
  group_id?: number | null;
  page?: number | null;
}
