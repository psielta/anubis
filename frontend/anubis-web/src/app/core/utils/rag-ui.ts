/**
 * Pure helpers for RAG UI labels, poll lifecycle, and source → page navigation.
 * Kept free of Angular DI so unit tests can import this module directly.
 */

export type RagUiStatus =
  | 'not_indexed'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'unknown';

export type RagBadgeKind = 'muted' | 'pending' | 'ready' | 'error';

/** Map API status (or 404/not found) to a stable UI status. */
export function mapApiStatus(
  status: string | null | undefined,
  options: { notFound?: boolean } = {},
): RagUiStatus {
  if (options.notFound) return 'not_indexed';
  if (!status) return 'unknown';
  switch (status) {
    case 'pending':
      return 'pending';
    case 'processing':
      return 'processing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** Short pt-BR label for badges and menus. */
export function ragStatusLabel(status: RagUiStatus, progress?: number | null): string {
  switch (status) {
    case 'not_indexed':
      return 'Não indexado';
    case 'pending':
      return 'Na fila';
    case 'processing': {
      const p = progress ?? 0;
      return p > 0 ? `Processando ${Math.min(100, Math.max(0, Math.round(p)))}%` : 'Processando';
    }
    case 'completed':
      return 'Pronto';
    case 'failed':
      return 'Falhou';
    default:
      return 'Desconhecido';
  }
}

export function ragBadgeKind(status: RagUiStatus): RagBadgeKind {
  switch (status) {
    case 'completed':
      return 'ready';
    case 'failed':
      return 'error';
    case 'pending':
    case 'processing':
      return 'pending';
    default:
      return 'muted';
  }
}

/** Poll until completed or failed; not_indexed/unknown stop (nothing in flight). */
export function shouldContinuePolling(status: RagUiStatus): boolean {
  return status === 'pending' || status === 'processing';
}

export function canSubmitQuery(status: RagUiStatus): boolean {
  return status === 'completed';
}

/** Prefer page_start for navigation; null if unknown. */
export function sourcePageTarget(
  pageStart: number | null | undefined,
  pageEnd?: number | null,
): number | null {
  if (pageStart != null && pageStart >= 1) return pageStart;
  if (pageEnd != null && pageEnd >= 1) return pageEnd;
  return null;
}

export function formatSourcePages(
  pageStart: number | null | undefined,
  pageEnd: number | null | undefined,
): string {
  if (pageStart == null && pageEnd == null) return 'Página desconhecida';
  if (pageStart != null && pageEnd != null && pageStart !== pageEnd) {
    return `Páginas ${pageStart}–${pageEnd}`;
  }
  const p = pageStart ?? pageEnd;
  return `Página ${p}`;
}

/** Router link commands for opening the reader (optional page via query params helper). */
export function readerRagCommands(bookId: number): (string | number)[] {
  return ['/read', bookId];
}

export function readerRagQueryParams(options: {
  page?: number | null;
  openRag?: boolean;
} = {}): Record<string, string> {
  const params: Record<string, string> = {};
  if (options.openRag) params['rag'] = '1';
  if (options.page != null && options.page >= 1) params['page'] = String(options.page);
  return params;
}
