export interface TranslationRequest {
  page: number;
  force?: boolean;
}

export interface TranslationCached {
  page: number;
  lang: string;
  markdown: string;
  model: string;
  created_at: string;
}

export interface TranslationDone {
  page: number;
  cached: boolean;
  model: string;
}

export interface TranslationStreamHandlers {
  onDelta: (text: string) => void;
  onDone: (data: TranslationDone) => void;
  onError: (message: string) => void;
}
