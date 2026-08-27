/**
 * End-to-end scenario setup and reporting.
 *
 * Builds a real campaign whose leads map onto the mock-LinkedIn fixtures, so the
 * actual worker process - real Chromium, real HTTP API, real database - can be
 * driven end to end without touching LinkedIn.
 *
 *   npm run e2e:setup     # wipe, seed the scenario, activate the campaign
 *   npm run e2e:report    # show what the worker actually recorded
 *
 * Intended for a development database. `setup` deletes existing data, so it
 * refuses to run unless E2E_CONFIRM=yes is set.
 */

import 'dotenv/config';

import { createPrismaClient } from '../src/lib/prisma-factory';

const prisma = createPrismaClient({});

/** Slug -> what the mock server will serve for it. */
const SCENARIO: { slug: string; firstName: string; lastName: string; expect: string }[] = [
  { slug: 'connect-flow', firstName: 'Jane', lastName: 'Doe', expect: 'SENT' },
  { slug: 'already-connected', firstName: 'Alan', lastName: 'Ward', expect: 'ALREADY_CONNECTED' },
  { slug: 'invitation-pending', firstName: 'Priya', lastName: 'Rao', expect: 'ALREADY_PENDING' },
  { slug: 'not-found', firstName: 'Gone', lastName: 'Away', expect: 'SKIPPED (profile missing)' },
  { slug: 'no-affordance', firstName: 'Odd', lastName: 'Profile', expect: 'REQUIRES_REVIEW' },
];

const TABLES = [
  'activity_logs',
  'incidents',
  'queue_jobs',
  'leads',
  'campaign_settings',
  'campaigns',
  'message_templates',
  'workers',
  'system_state',
];

async function setup(): Promise<void> {
  if (process.env.E2E_CONFIRM !== 'yes') {
    throw new Error('Refusing to wipe data. Re-run with E2E_CONFIRM=yes if that is intended.');
  }

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await prisma.systemState.create({ data: { id: 'singleton' } });

  const template = await prisma.messageTemplate.create({
    data: {
      name: 'E2E note',
      body: 'Hi {{firstName}}, I came across your profile and thought it would be worth connecting.',
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      name: 'E2E scenario',
      description: 'Drives the worker against local fixtures.',
      messageTemplateId: template.id,
      // Activated directly: this script stands in for the operator pressing
      // Activate, which is the only other route to RUNNING.
      status: 'RUNNING',
      active: true,
      activatedAt: new Date(),
      activatedBy: 'e2e-script',
      settings: {
        create: {
          timezone: 'UTC',
          dailyLimit: 20,
          windowStartMinute: 0,
          windowEndMinute: 1439,
          operatingDays: [1, 2, 3, 4, 5, 6, 7],
          // No waiting around in a scripted run.
          minActionDelaySeconds: 5,
          maxActionDelaySeconds: 5,
          maxAttemptsPerLead: 2,
          pauseOnIncident: false,
          skipLeadsMissingTemplateVars: true,
        },
      },
    },
  });

  let scheduledFor = new Date(Date.now() - 60_000);
  for (const entry of SCENARIO) {
    const lead = await prisma.lead.create({
      data: {
        fullName: `${entry.firstName} ${entry.lastName}`,
        firstName: entry.firstName,
        lastName: entry.lastName,
        linkedinUrl: `https://www.linkedin.com/in/${entry.slug}`,
        publicIdentifier: entry.slug,
        company: 'Acme Clinical',
        jobTitle: 'Clinical Research Associate',
        campaignId: campaign.id,
        status: 'PENDING',
      },
    });

    await prisma.queueJob.create({
      data: {
        leadId: lead.id,
        campaignId: campaign.id,
        action: 'CONNECT',
        status: 'WAITING',
        scheduledFor,
        maxAttempts: 2,
      },
    });
    scheduledFor = new Date(scheduledFor.getTime() + 1_000);
  }

  process.stdout.write(
    `Scenario ready: campaign "${campaign.name}" RUNNING with ${SCENARIO.length} queued job(s).\n\n` +
      SCENARIO.map((s) => `  /in/${s.slug.padEnd(20)} expect ${s.expect}`).join('\n') +
      '\n\nNow run the mock server and the worker:\n' +
      '  npm run mock:linkedin\n' +
      '  NODE_ENV=test MOCK_LINKEDIN_BASE_URL=http://127.0.0.1:4010 WORKER_HEADLESS=true npm run worker\n\n',
  );
}

async function report(): Promise<void> {
  const leads = await prisma.lead.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      queueJobs: {
        orderBy: { createdAt: 'asc' },
        select: { status: true, result: true, attempts: true, error: true, errorClass: true },
      },
    },
  });

  process.stdout.write('\nLEAD OUTCOMES\n');
  for (const lead of leads) {
    const job = lead.queueJobs[0];
    process.stdout.write(
      `  ${lead.publicIdentifier.padEnd(22)} lead=${lead.status.padEnd(18)} ` +
        `job=${(job?.status ?? '-').padEnd(16)} result=${(job?.result ?? '-').padEnd(20)} ` +
        `sentAt=${lead.invitationSentAt ? 'yes' : 'no'}\n`,
    );
    if (job?.error) process.stdout.write(`      error: ${job.error.slice(0, 160)}\n`);
  }

  const activity = await prisma.activityLog.findMany({
    where: { action: 'CONNECT' },
    orderBy: { createdAt: 'asc' },
    include: { lead: { select: { fullName: true } } },
  });

  process.stdout.write('\nACTIVITY LOG (CONNECT actions)\n');
  for (const entry of activity) {
    const stamp = entry.createdAt.toISOString().replace('T', ' ').slice(0, 16);
    process.stdout.write(
      `  ${stamp}  ${(entry.lead?.fullName ?? '-').padEnd(16)} ${entry.result.padEnd(20)} ` +
        `${entry.pageState ?? ''}\n`,
    );
    if (entry.error) process.stdout.write(`      ${entry.error.slice(0, 160)}\n`);
  }

  const incidents = await prisma.incident.findMany({ orderBy: { createdAt: 'asc' } });
  process.stdout.write(`\nINCIDENTS (${incidents.length})\n`);
  for (const incident of incidents) {
    process.stdout.write(
      `  ${incident.type.padEnd(24)} ${incident.severity.padEnd(9)} blocks=${String(
        incident.blocksWorker,
      ).padEnd(5)} ${incident.title.slice(0, 70)}\n`,
    );
  }

  const state = await prisma.systemState.findUnique({ where: { id: 'singleton' } });
  const workers = await prisma.worker.findMany({ orderBy: { startedAt: 'asc' } });

  process.stdout.write(
    `\nSYSTEM\n  emergency stop: ${state?.killSwitchEngaged ? 'ENGAGED' : 'not engaged'}` +
      `${state?.killSwitchReason ? ` (${state.killSwitchReason})` : ''}\n`,
  );
  for (const worker of workers) {
    process.stdout.write(
      `  worker ${worker.name}: ${worker.status}, session ${worker.sessionStatus}, ` +
        `${worker.jobsProcessed} processed / ${worker.jobsFailed} failed\n`,
    );
  }
  process.stdout.write('\n');
}

const mode = process.argv[2];

void (async () => {
  try {
    if (mode === 'setup') await setup();
    else if (mode === 'report') await report();
    else throw new Error('Usage: e2e-scenario.ts <setup|report>');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
