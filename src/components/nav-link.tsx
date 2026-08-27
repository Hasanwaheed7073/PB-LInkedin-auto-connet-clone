'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Activity,
  AlertTriangle,
  Cpu,
  LayoutDashboard,
  ListOrdered,
  MessageSquareText,
  Settings,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Main navigation.
 *
 * The whole nav lives in this client component, icons included. A server
 * component cannot pass an icon *component* across the boundary - React refuses
 * to serialise a function - so the list is defined here rather than in the
 * server-rendered shell.
 */

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/leads', label: 'Leads', icon: Users },
  { href: '/campaigns', label: 'Campaigns', icon: Target },
  { href: '/templates', label: 'Templates', icon: MessageSquareText },
  { href: '/queue', label: 'Queue', icon: ListOrdered },
  { href: '/activity', label: 'Activity', icon: Activity },
  { href: '/incidents', label: 'Incidents', icon: AlertTriangle },
  { href: '/workers', label: 'Worker', icon: Cpu },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function MainNav() {
  const pathname = usePathname();

  return (
    <nav className="scroll-x flex gap-1 border-t px-2 py-1.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        // Exact match for the dashboard, prefix match elsewhere, so
        // /campaigns/abc still highlights Campaigns.
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
