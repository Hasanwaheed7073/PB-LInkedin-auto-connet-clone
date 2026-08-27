'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/utils';

/** URL-driven pagination, so a page link is shareable and survives a refresh. */
export function Pagination({
  page,
  totalPages,
  total,
}: {
  page: number;
  totalPages: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function goTo(next: number) {
    const search = new URLSearchParams(params.toString());
    if (next <= 1) search.delete('page');
    else search.set('page', String(next));
    const query = search.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-sm">
        Page <span className="tabular">{formatNumber(page)}</span> of{' '}
        <span className="tabular">{formatNumber(totalPages)}</span> ·{' '}
        <span className="tabular">{formatNumber(total)}</span> total
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
          className="gap-1"
        >
          <ChevronLeft className="size-4" />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => goTo(page + 1)}
          className="gap-1"
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
