import { redirect } from 'next/navigation';

import { AppShell } from '@/components/app-shell';
import { currentUser, needsSetup } from '@/lib/auth';

/**
 * Authenticated layout.
 *
 * Every page under this route group requires a session. The check happens here,
 * server-side, so no dashboard data is fetched or rendered for an
 * unauthenticated request.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (await needsSetup()) redirect('/login?setup=1');

  const user = await currentUser();
  if (!user) redirect('/login');

  return <AppShell user={user}>{children}</AppShell>;
}
