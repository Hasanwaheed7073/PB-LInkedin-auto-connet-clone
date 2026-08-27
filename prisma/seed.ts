import 'dotenv/config';

import { hashPassword } from '../src/lib/auth';
import { createPrismaClient } from '../src/lib/prisma-factory';

/**
 * Seed the minimum needed to sign in and start working.
 *
 * Creates the operator account and the SystemState singleton. Deliberately does
 * NOT create demo leads, demo campaigns or example activity: the dashboard must
 * only ever show real data (requirement 26), and a seeded fake campaign would be
 * indistinguishable from a real one.
 */

const prisma = createPrismaClient({
  connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
});

async function main(): Promise<void> {
  const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
  const name = process.env.SEED_USER_NAME?.trim() || 'Operator';
  const password = process.env.SEED_USER_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'SEED_USER_EMAIL and SEED_USER_PASSWORD must be set in .env before seeding.',
    );
  }
  if (password.length < 10) {
    throw new Error('SEED_USER_PASSWORD must be at least 10 characters.');
  }
  if (/^change-this/i.test(password)) {
    throw new Error('SEED_USER_PASSWORD is still the .env.example placeholder - set a real one.');
  }

  // The plaintext is read once here and never stored.
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash, role: 'OPERATOR' },
    update: { name, passwordHash },
  });
  process.stdout.write(`Operator account ready: ${user.email}\n`);

  const state = await prisma.systemState.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
  process.stdout.write(
    `System state ready. Emergency stop is ${state.killSwitchEngaged ? 'ENGAGED' : 'not engaged'}.\n`,
  );

  const [leads, campaigns, templates] = await Promise.all([
    prisma.lead.count(),
    prisma.campaign.count(),
    prisma.messageTemplate.count(),
  ]);

  process.stdout.write(
    `\nCurrent contents: ${leads} lead(s), ${campaigns} campaign(s), ${templates} template(s).\n` +
      'No demo data is created - import your own CSV from the dashboard.\n\n',
  );
}

void main()
  .catch((error) => {
    process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
