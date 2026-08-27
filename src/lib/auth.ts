import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

import { logActivity } from './activity';
import { prisma } from './db';
import { serverEnv } from './env';

/**
 * Dashboard authentication.
 *
 * Single-operator internal tool, so this is deliberately small: one operator
 * account, a scrypt password hash, and a signed session cookie.
 *
 * What this is NOT: anything to do with LinkedIn credentials. No LinkedIn
 * username or password is ever accepted, stored or transmitted by this
 * application - the browser session is authenticated by hand in a real browser
 * window (see `src/worker/session.ts`).
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SESSION_COOKIE = 'outreach_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1]!, 'base64');
  const expected = Buffer.from(parts[2]!, 'base64');
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(derived, expected);
}

function sessionKey(): Uint8Array {
  return new TextEncoder().encode(serverEnv().SESSION_SECRET);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionKey());
}

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'INVALID_CREDENTIALS' | 'NO_USERS' };

/**
 * Authenticate and set the session cookie.
 *
 * The failure reason is intentionally identical for an unknown email and a wrong
 * password, so this cannot be used to enumerate accounts.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const userCount = await prisma.user.count();
  if (userCount === 0) return { ok: false, reason: 'NO_USERS' };

  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });

  // Always run a hash comparison so timing does not reveal whether the account
  // exists.
  const stored =
    user?.passwordHash ??
    'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(SCRYPT_KEYLEN).toString('base64');
  const passwordOk = await verifyPassword(password, stored);

  if (!user || !passwordOk) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  const sessionUser: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };

  const token = await createSessionToken(sessionUser);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await logActivity({
    action: 'USER_LOGIN',
    result: 'SUCCESS',
    actorType: 'USER',
    actorId: user.id,
    actorName: user.name,
    message: 'Operator signed in.',
  });

  return { ok: true, user: sessionUser };
}

export async function logout(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Current operator, or null. Never throws - callers decide how to handle absence. */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, sessionKey());
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: String(payload.email ?? ''),
      name: String(payload.name ?? 'Operator'),
      role: String(payload.role ?? 'OPERATOR'),
    };
  } catch {
    return null;
  }
}

/**
 * Require an authenticated operator. Server actions that change state call this
 * first, so nothing mutating is reachable without a session.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  return user;
}

/** True when no operator account exists yet, so the UI can point at `npm run db:seed`. */
export async function needsSetup(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

/**
 * Constant-time bearer-token check for the worker API.
 *
 * The worker holds no database credentials and no session cookie; this shared
 * token is its only access path.
 */
export function verifyWorkerToken(authorizationHeader: string | null): boolean {
  if (!authorizationHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) return false;

  const provided = Buffer.from(match[1]!.trim(), 'utf8');
  const expected = Buffer.from(serverEnv().WORKER_API_TOKEN, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
