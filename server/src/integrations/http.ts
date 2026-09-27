/** The body was larger than the caller allows. */
export class ResponseTooLarge extends Error {
  constructor() {
    super('Response too large');
  }
}

export interface BufferedFetchInit extends Omit<RequestInit, 'signal'> {
  /** Deadline for the whole exchange: connecting, headers, and the body. */
  timeoutMs: number;
  /** Refuse bodies larger than this (checked against Content-Length, then while reading). */
  maxBytes?: number;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * fetch, with the body read to completion under one deadline, returned as an
 * already buffered Response.
 *
 * Why not `AbortSignal.timeout()`: its timer is held weakly, and once fetch has
 * the headers nothing else keeps the signal alive. If it is garbage collected
 * while the body is still streaming, the timeout never fires, and an upstream
 * that stalls mid-body hangs the caller forever, silently. Here the timer is an
 * ordinary one, cleared only when the exchange is over.
 */
export async function fetchBuffered(url: string, init: BufferedFetchInit): Promise<Response> {
  const { timeoutMs, maxBytes, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`No complete answer within ${timeoutMs} ms`, 'TimeoutError')),
    timeoutMs,
  );
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (maxBytes !== undefined && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLarge();
    }
    const body = await readAll(response, maxBytes);
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    controller.abort(); // release the connection when a body is refused part way
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readAll(response: Response, maxBytes: number | undefined): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (maxBytes !== undefined && total > maxBytes) throw new ResponseTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
