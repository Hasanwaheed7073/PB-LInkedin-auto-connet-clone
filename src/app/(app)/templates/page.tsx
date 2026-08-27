import { MessageSquareText } from 'lucide-react';

import { TemplateEditor } from '@/components/template-editor';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/misc';
import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { TEMPLATE_VARIABLES } from '@/lib/template';
import { formatTimestamp } from '@/lib/utils';

export const metadata = { title: 'Message templates' };
export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const env = serverEnv();

  const [templates, leadCount] = await Promise.all([
    prisma.messageTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        campaigns: { select: { id: true, name: true, status: true, active: true } },
      },
    }),
    prisma.lead.count(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connection note templates</h1>
        <p className="text-muted-foreground text-sm">
          Previewed against a real lead from your database — never a made-up example.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Variables</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATE_VARIABLES.map((variable) => (
              <Badge key={variable} variant="secondary" className="font-mono">
                {`{{${variable}}}`}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            Maximum rendered length: {env.MAX_CONNECTION_NOTE_CHARS} characters. A lead whose values
            cannot fill every variable used is skipped rather than sent a note with a gap in it, so
            &ldquo;Hi , I came across your profile&rdquo; cannot happen.
          </p>
        </CardContent>
      </Card>

      <TemplateEditor mode="create" leadCount={leadCount} />

      {templates.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={<MessageSquareText className="size-6" />}
              title="No templates yet"
              description="A campaign with no template sends invitations without a note, which is perfectly valid."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {templates.map((template) => {
            const runningUse = template.campaigns.filter(
              (c) => c.active && c.status === 'RUNNING',
            );

            return (
              <Card key={template.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {template.campaigns.length === 0 ? (
                        <Badge variant="muted">Unused</Badge>
                      ) : (
                        template.campaigns.map((campaign) => (
                          <Badge
                            key={campaign.id}
                            variant={campaign.active ? 'success' : 'secondary'}
                          >
                            {campaign.name}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                  {template.description ? (
                    <p className="text-muted-foreground text-sm">{template.description}</p>
                  ) : null}
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <pre className="bg-muted/50 scroll-x rounded-md p-3 text-sm whitespace-pre-wrap">
                    {template.body}
                  </pre>
                  <p className="text-muted-foreground text-xs">
                    Created {formatTimestamp(template.createdAt)} · {template.body.length} raw
                    characters
                  </p>

                  <TemplateEditor
                    mode="edit"
                    leadCount={leadCount}
                    template={{
                      id: template.id,
                      name: template.name,
                      description: template.description ?? '',
                      body: template.body,
                    }}
                    lockedReason={
                      runningUse.length > 0
                        ? `In use by running campaign(s): ${runningUse
                            .map((c) => c.name)
                            .join(', ')}. Pause them before editing.`
                        : undefined
                    }
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
