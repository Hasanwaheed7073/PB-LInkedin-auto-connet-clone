'use client';

import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { signOut } from '@/server/actions/auth';

export function SignOutButton() {
  return (
    <form action={signOut}>
      <Button type="submit" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
        <LogOut className="size-3.5" />
        Sign out
      </Button>
    </form>
  );
}
