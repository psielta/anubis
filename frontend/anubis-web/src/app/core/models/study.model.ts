export type StudyKind = 'chat' | 'summary' | 'flashcards';
export type StudyScope = 'book' | 'chapter';

export interface StudyMessage {
  id: number;
  role: 'user' | 'assistant';
  kind: StudyKind;
  content: string;
  scope: string | null;
  created_at: string;
}

export interface StudyRequest {
  kind: StudyKind;
  question?: string;
  scope: StudyScope;
  page_from?: number;
  page_to?: number;
  selection?: string;
}

export interface StudyDone {
  id: number;
  scope: string;
  kind: StudyKind;
}

export interface StudyStreamHandlers {
  onThinking?: (text: string) => void;
  onDelta: (text: string) => void;
  onDone: (data: StudyDone) => void;
  onError: (message: string) => void;
}
