import * as React from 'react';

import { cn } from '@/lib/utils';

/** Loading placeholder used by Suspense boundaries. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />;
}

/**
 * Empty state.
 *
 * Used wherever a table or panel has no rows. Says so plainly rather than
 * rendering fabricated placeholder data.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground/60 mb-1">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="text-muted-foreground max-w-md text-sm">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Inline key/value row used on detail panels. */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 py-1.5', className)}>
      <dt className="text-muted-foreground shrink-0 text-sm">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

/** Small coloured dot for status indicators. */
export function StatusDot({
  tone,
  pulse,
  className,
}: {
  tone: 'success' | 'warning' | 'danger' | 'info' | 'muted';
  pulse?: boolean;
  className?: string;
}) {
  const colour = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-destructive',
    info: 'bg-info',
    muted: 'bg-muted-foreground/50',
  }[tone];

  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)}>
      {pulse ? (
        <span className={cn('absolute inline-flex size-2 animate-ping rounded-full opacity-60', colour)} />
      ) : null}
      <span className={cn('relative inline-flex size-2 rounded-full', colour)} />
    </span>
  );
}

/** Prominent banner for a condition the operator must act on. */
export function Callout({
  tone = 'info',
  title,
  children,
  className,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title: string;
  children?: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  const tones = {
    info: 'border-info/30 bg-info/8',
    warning: 'border-warning/35 bg-warning/10',
    danger: 'border-destructive/35 bg-destructive/8',
    success: 'border-success/30 bg-success/8',
  };

  return (
    <div className={cn('rounded-lg border p-4', tones[tone], className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          {children ? <div className="text-muted-foreground mt-1 text-sm">{children}</div> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * Marks a feature that is intentionally not implemented.
 *
 * Requirement 26: incomplete features are labelled as incomplete rather than
 * given a button that pretends to work.
 */
export function NotImplemented({ what, why }: { what: string; why: string }) {
  return (
    <div className="border-border/70 text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
      <p className="text-foreground font-medium">{what} — not implemented</p>
      <p className="mt-1">{why}</p>
    </div>
  );
}
