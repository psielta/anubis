export type ExerciseStatus = 'pending' | 'completed' | 'doubt' | 'wrong';
export type ExerciseAIMode = 'statement' | 'hint' | 'review' | 'hint_level' | 'ask';

export interface ExerciseRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ExerciseResolution {
  id: number;
  book_id: number;
  title: string;
  page: number;
  region: ExerciseRegion;
  statement: string;
  latex_content: string;
  sketch_content: string;
  status: ExerciseStatus;
  ai_feedback: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExerciseResolutionCreate {
  title: string;
  page: number;
  region: ExerciseRegion;
  statement?: string;
  latex_content?: string;
  sketch_content?: string;
}

export interface ExerciseResolutionUpdate {
  title?: string;
  statement?: string;
  latex_content?: string;
  sketch_content?: string;
  status?: ExerciseStatus;
  ai_feedback?: string | null;
}

export interface ExerciseAttempt {
  id: number;
  resolution_id: number;
  latex_content: string;
  sketch_content: string;
  ai_feedback: string | null;
  created_at: string;
}

export interface ExerciseAIRequest {
  mode: ExerciseAIMode;
  question?: string;
  level?: number;
}

export interface ExerciseAIDone {
  mode: ExerciseAIMode;
  content: string;
}

export interface ExerciseAIHandlers {
  onThinking?: (text: string) => void;
  onDelta: (text: string) => void;
  onDone: (data: ExerciseAIDone) => void;
  onError: (message: string) => void;
}
