export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

export interface SseStreamHandlers {
  /** Called for each parsed SSE frame (event name + decoded JSON data). */
  onFrame: (frame: SseFrame) => void;
  /** Called on network / HTTP / parse failure with a user-facing message. */
  onError: (message: string) => void;
}

/**
 * Stream Server-Sent Events over fetch + ReadableStream (not EventSource, which
 * can't send the Authorization header). Attaches the bearer token manually and
 * splits the body on blank lines into event/data frames. Shared by the study
 * assistant and the exercise-resolution AI actions.
 */
export async function streamSse(
  url: string,
  body: unknown,
  handlers: SseStreamHandlers,
  token: string | null,
  signal?: AbortSignal,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    handlers.onError('Erro de rede — o servidor está em execução?');
    return;
  }

  if (!resp.ok || !resp.body) {
    let detail = `A requisição falhou (${resp.status}).`;
    try {
      const err = await resp.json();
      if (err?.detail) detail = err.detail;
    } catch {
      /* non-JSON error body */
    }
    if (resp.status === 401) detail = 'Sessão expirada — recarregue a página.';
    handlers.onError(detail);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const parsed = parseFrame(frame);
        if (parsed) handlers.onFrame(parsed);
      }
    }
  } catch {
    handlers.onError('A transmissão foi interrompida.');
  }
}

function parseFrame(frame: string): SseFrame | null {
  let event = '';
  let dataLine = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
  }
  if (!event) return null;
  let data: Record<string, unknown> = {};
  try {
    data = dataLine ? (JSON.parse(dataLine) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  return { event, data };
}
