'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { actionError, actionOk, validate, type ActionResult } from '@/lib/api';
import { login, logout } from '@/lib/auth';
import { loginSchema } from '@/lib/validation/schemas';

/**
 * Dashboard sign-in.
 *
 * This is the operator's password for THIS application. No LinkedIn credential
 * is ever accepted here - the LinkedIn session is established by hand in a real
 * browser window (`npm run worker -- --login`).
 */
export async function signIn(input: unknown): Promise<ActionResult<undefined>> {
  const parsed = validate(loginSchema, input);
  if (!parsed.ok) return parsed.result;

  const result = await login(parsed.data.email, parsed.data.password);

  if (!result.ok) {
    if (result.reason === 'NO_USERS') {
      return actionError(
        'No operator account exists yet. Run `npm run db:seed` to create one from the ' +
          'SEED_USER_* values in your .env file.',
      );
    }
    // Same message for unknown email and wrong password - no account enumeration.
    return actionError('Incorrect email or password.');
  }

  revalidatePath('/');
  return actionOk(undefined, 'Signed in.');
}

export async function signOut(): Promise<void> {
  await logout();
  redirect('/login');
}
