import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout } from '@/components/ui/misc';
import { currentUser, needsSetup } from '@/lib/auth';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string }>;
}) {
  const user = await currentUser();
  if (user) redirect('/');

  const params = await searchParams;
  const setupRequired = await needsSetup();

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center justify-center gap-2 font-semibold">
          <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-md text-xs font-bold">
            LO
          </span>
          LinkedIn Outreach
        </div>

        {setupRequired || params.setup ? (
          <Callout tone="warning" title="No operator account exists yet">
            <p>
              Run <code className="font-mono text-xs">npm run db:seed</code> to create one from the{' '}
              <code className="font-mono text-xs">SEED_USER_*</code> values in your{' '}
              <code className="font-mono text-xs">.env</code> file, then sign in here.
            </p>
          </Callout>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              This is the password for this dashboard. Your LinkedIn credentials are never
              requested or stored here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>

        <p className="text-muted-foreground text-center text-xs">
          The LinkedIn browser session is authenticated by hand, once, with{' '}
          <code className="font-mono">npm run worker -- --login</code>.
        </p>
      </div>
    </div>
  );
}
