import { BusinessChooser } from '@/components/business-chooser';
import { listBusinessProfiles } from '@/lib/business-profile';

/**
 * Business selection, shown after sign-in and reachable from the switcher.
 *
 * Deliberately inside the authenticated layout: choosing a business is not a
 * step on the way to being authenticated, it is the first thing an
 * authenticated operator does.
 */
export const dynamic = 'force-dynamic';

export default async function ChoosePage() {
  const profiles = await listBusinessProfiles();
  return <BusinessChooser profiles={profiles} />;
}
