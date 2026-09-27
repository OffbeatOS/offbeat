import type { ApiErrorBody } from '@offbeat/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { STATUS_CODES } from 'node:http';
import type { z } from 'zod';

/** Throw from a handler to return `{ error, message }` with the given status. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Validates untrusted input, turning Zod issues into a readable 400. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.');
    throw new HttpError(400, field ? `${field}: ${issue?.message}` : (issue?.message ?? 'Invalid request'));
  }
  return result.data;
}

export function errorBody(statusCode: number, message: string): ApiErrorBody {
  return { error: STATUS_CODES[statusCode] ?? 'Error', message };
}

export function apiErrorHandler(error: FastifyError | HttpError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).headers(error.headers).send(errorBody(error.statusCode, error.message));
  }
  // Fastify's own client errors (bad JSON, unsupported media type, and so on).
  if (error.statusCode && error.statusCode < 500) {
    return reply.code(error.statusCode).send(errorBody(error.statusCode, error.message));
  }
  request.log.error(error);
  return reply.code(500).send(errorBody(500, 'Something went wrong. Check the server logs.'));
}
