import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { requireUser, verifyWorkerToken, type SessionUser } from './auth';

/**
 * Route-handler plumbing.
 *
 * Two wrappers, so no handler has to remember to authenticate or validate:
 *  - `workerRoute` for `/api/worker/*`, gated on the shared bearer token.
 *  - `operatorRoute` for dashboard-facing routes, gated on the session cookie.
 *
 * Both validate the body with Zod before the handler runs, and both convert
 * thrown errors into a safe response: internal messages and stack traces are
 * logged server-side, never returned to the client.
 */

export function jsonError(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

function formatZodIssues(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

/**
 * Worker-authenticated route.
 *
 * The worker presents `Authorization: Bearer $WORKER_API_TOKEN`. The token is
 * compared in constant time and is never echoed back or logged.
 */
export function workerRoute<S extends z.ZodType>(
  schema: S,
  handler: (input: z.infer<S>, request: Request) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    if (!verifyWorkerToken(request.headers.get('authorization'))) {
      return jsonError(401, 'Unauthorized');
    }

    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      return jsonError(400, 'Request body is not valid JSON');
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError(422, 'Validation failed', { issues: formatZodIssues(parsed.error) });
    }

    try {
      return await handler(parsed.data, request);
    } catch (error) {
      // Log the detail, return a generic message.
      console.error('[api/worker] handler failed', error);
      return jsonError(500, 'Internal error');
    }
  };
}

/** Session-authenticated route for dashboard fetches. */
export function operatorRoute<S extends z.ZodType>(
  schema: S,
  handler: (input: z.infer<S>, user: SessionUser, request: Request) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    let user: SessionUser;
    try {
      user = await requireUser();
    } catch {
      return jsonError(401, 'Sign in required');
    }

    let body: unknown;
    if (request.method === 'GET') {
      body = Object.fromEntries(new URL(request.url).searchParams.entries());
    } else {
      try {
        body = await readJson(request);
      } catch {
        return jsonError(400, 'Request body is not valid JSON');
      }
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return jsonError(422, 'Validation failed', { issues: formatZodIssues(parsed.error) });
    }

    try {
      return await handler(parsed.data, user, request);
    } catch (error) {
      console.error('[api] handler failed', error);
      return jsonError(500, 'Internal error');
    }
  };
}

/**
 * Shape returned by server actions.
 *
 * A discriminated union so the UI can render field errors without guessing, and
 * so an action never has to throw across the server/client boundary.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; issues?: { field: string; message: string }[] };

export function actionOk<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export function actionError<T = undefined>(
  error: string,
  issues?: { field: string; message: string }[],
): ActionResult<T> {
  return { ok: false, error, issues };
}

/** Validate server-action input, returning a renderable error instead of throwing. */
export function validate<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; result: ActionResult<never> } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    result: actionError('Validation failed', formatZodIssues(parsed.error)),
  };
}
