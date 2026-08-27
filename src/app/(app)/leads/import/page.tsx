import { LeadImportWizard } from '@/components/lead-import-wizard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { prisma } from '@/lib/db';

export const metadata = { title: 'Import leads' };
export const dynamic = 'force-dynamic';

export default async function ImportLeadsPage() {
  const campaigns = await prisma.campaign.findMany({
    where: { status: { in: ['DRAFT', 'READY', 'PAUSED'] } },
    select: { id: true, name: true, status: true },
    orderBy: { name: 'asc' },
  });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Import leads</h1>
        <p className="text-muted-foreground text-sm">
          Upload a CSV. Nothing is written until you review the preview and confirm.
        </p>
      </div>

      <LeadImportWizard campaigns={campaigns} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Expected columns</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-3 text-sm">
          <p>
            One column must hold the LinkedIn profile URL. Recognised headers include{' '}
            <code className="font-mono text-xs">linkedinUrl</code>,{' '}
            <code className="font-mono text-xs">LinkedIn URL</code>,{' '}
            <code className="font-mono text-xs">profileUrl</code> and{' '}
            <code className="font-mono text-xs">Profile</code>.
          </p>
          <p>
            Optional: <code className="font-mono text-xs">firstName</code>,{' '}
            <code className="font-mono text-xs">lastName</code>,{' '}
            <code className="font-mono text-xs">fullName</code>,{' '}
            <code className="font-mono text-xs">company</code>,{' '}
            <code className="font-mono text-xs">jobTitle</code>,{' '}
            <code className="font-mono text-xs">location</code>,{' '}
            <code className="font-mono text-xs">notes</code>. Unrecognised columns are reported and
            ignored, never silently dropped.
          </p>
          <div className="scroll-x rounded-md border">
            <pre className="p-3 font-mono text-xs">
{`firstName,lastName,linkedinUrl,company,jobTitle,location
John,Smith,https://www.linkedin.com/in/john-smith,Acme Clinical,CRA,Berlin
Sarah,Jones,https://www.linkedin.com/in/sarah-jones,Globex,CRC II,London`}
            </pre>
          </div>
          <p>
            Company pages, Sales Navigator links and non-LinkedIn URLs are rejected with a reason
            per row. Profiles already in the database are reported and left untouched — an import
            can never reset a lead that was already contacted.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
