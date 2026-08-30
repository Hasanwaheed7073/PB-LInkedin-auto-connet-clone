import { z } from 'zod';

import { isValidLinkedInProfileUrl } from '../linkedin-url';
import { isValidTimezone } from '../schedule';
import { TEMPLATE_VARIABLES, inspectTemplateBody } from '../template';

/**
 * Every piece of external input - form submission, API body, worker report -
 * passes through a schema in this file. Nothing is trusted, including input
 * from the worker: a compromised or buggy worker must not be able to write
 * arbitrary state.
 */

export const cuidSchema = z.string().min(20).max(40).regex(/^[a-z0-9]+$/i, 'Invalid id');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export const leadStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'SENT',
  'ALREADY_CONNECTED',
  'ALREADY_PENDING',
  'SKIPPED',
  'FAILED',
  'REQUIRES_REVIEW',
  'BLOCKED',
]);

export const leadFilterSchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: leadStatusSchema.optional(),
  campaignId: cuidSchema.optional(),
  sort: z.enum(['createdAt', 'fullName', 'status', 'lastAttemptAt']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export const csvUploadSchema = z.object({
  /** Raw CSV text. 12 MB covers a 600-lead list many times over. */
  csv: z.string().min(1, 'CSV is empty').max(12 * 1024 * 1024, 'CSV file is too large'),
  fileName: z.string().max(300).optional(),
});

export const confirmImportSchema = z.object({
  csv: z.string().min(1).max(12 * 1024 * 1024),
  fileName: z.string().max(300).optional(),
  campaignId: cuidSchema.optional().nullable(),
  /**
   * Row count the operator saw on the preview. The import is refused if it no
   * longer matches, so a concurrent change cannot cause a different number of
   * leads to be created than was confirmed.
   */
  expectedCount: z.number().int().min(0).max(20_000),
});

export const updateLeadSchema = z.object({
  id: cuidSchema,
  firstName: z.string().trim().max(120).nullable().optional(),
  lastName: z.string().trim().max(120).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  jobTitle: z.string().trim().max(300).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
  campaignId: cuidSchema.nullable().optional(),
});

export const createLeadSchema = z.object({
  linkedinUrl: z
    .string()
    .trim()
    .min(1, 'LinkedIn URL is required')
    .refine(isValidLinkedInProfileUrl, 'Not a valid LinkedIn profile URL (expected /in/<name>)'),
  fullName: z.string().trim().max(300).optional(),
  firstName: z.string().trim().max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
  company: z.string().trim().max(200).optional(),
  jobTitle: z.string().trim().max(300).optional(),
  location: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2_000).optional(),
  campaignId: cuidSchema.optional().nullable(),
});

export const setLeadStatusSchema = z.object({
  id: cuidSchema,
  status: leadStatusSchema,
  reason: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/**
 * Template body rules. The `{{...}}` check runs here so an unsupported variable
 * is a form error rather than a runtime skip during a live campaign.
 */
export const templateBodySchema = z
  .string()
  .trim()
  .min(1, 'Template body is required')
  .max(2_000, 'Template body is too long')
  .superRefine((body, ctx) => {
    const { unknown } = inspectTemplateBody(body);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Unsupported variable(s): ${unknown
          .map((u) => `{{${u}}}`)
          .join(', ')}. Supported: ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`,
      });
    }
  });

export const messageTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).optional().nullable(),
  body: templateBodySchema,
});

export const updateMessageTemplateSchema = messageTemplateSchema.extend({ id: cuidSchema });

export const templatePreviewSchema = z.object({
  body: templateBodySchema,
  leadId: cuidSchema.optional(),
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const clockMinuteSchema = z.coerce.number().int().min(0).max(24 * 60);

export const campaignSettingsSchema = z
  .object({
    timezone: z
      .string()
      .trim()
      .min(1, 'Timezone is required')
      .refine(isValidTimezone, 'Not a recognised IANA timezone (e.g. Europe/Berlin)'),
    /**
     * Hard ceiling of 100/day. This is a configured conservative limit, not a
     * figure derived from any LinkedIn allowance, and the global limit in
     * `GLOBAL_DAILY_ACTION_LIMIT` still applies on top.
     */
    dailyLimit: z.coerce.number().int().min(1, 'Must allow at least 1 action').max(100),
    windowStartMinute: clockMinuteSchema,
    windowEndMinute: clockMinuteSchema,
    operatingDays: z
      .array(z.coerce.number().int().min(1).max(7))
      .min(1, 'Pick at least one operating day')
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    minActionDelaySeconds: z.coerce.number().int().min(5).max(3_600),
    maxActionDelaySeconds: z.coerce.number().int().min(5).max(7_200),
    maxAttemptsPerLead: z.coerce.number().int().min(1).max(10),
    pauseOnIncident: z.boolean().default(true),
    skipLeadsMissingTemplateVars: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.maxActionDelaySeconds < value.minActionDelaySeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxActionDelaySeconds'],
        message: 'Maximum delay must be at least the minimum delay',
      });
    }
    if (value.windowStartMinute === value.windowEndMinute) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowEndMinute'],
        message: 'Operating window cannot be zero-length',
      });
    }
  });

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  description: z.string().trim().max(1_000).optional().nullable(),
  messageTemplateId: cuidSchema.optional().nullable(),
  settings: campaignSettingsSchema,
});

export const updateCampaignSchema = createCampaignSchema.extend({ id: cuidSchema });

export const campaignIdSchema = z.object({ id: cuidSchema });

export const pauseCampaignSchema = z.object({
  id: cuidSchema,
  reason: z.string().trim().max(500).optional(),
});

/**
 * Campaign activation.
 *
 * `confirm` must be explicitly true. Requirement 4: a campaign never runs
 * without deliberate activation, so this cannot be triggered by a stray request
 * with a campaign id in it.
 */
export const activateCampaignSchema = z.object({
  id: cuidSchema,
  confirm: z.literal(true, {
    message: 'Activation must be explicitly confirmed',
  }),
  /** Generate queue jobs for pending leads as part of activation. */
  generateQueue: z.boolean().default(true),
});

export const assignLeadsSchema = z.object({
  campaignId: cuidSchema,
  leadIds: z.array(cuidSchema).min(1).max(5_000),
});

export const generateQueueSchema = z.object({
  campaignId: cuidSchema,
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
});

/**
 * A burst: "send this many, over this long, starting now."
 *
 * The ceilings here are shape checks, not the safety limits - the campaign's
 * daily limit and the global ceiling are enforced server-side against what has
 * actually been sent today, and trim the request rather than rejecting it.
 */
export const scheduleBurstSchema = z.object({
  campaignId: cuidSchema,
  count: z.coerce.number().int().min(1).max(200),
  minutes: z.coerce.number().int().min(1).max(720),
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export const queueStatusSchema = z.enum([
  'WAITING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REQUIRES_REVIEW',
]);

export const queueFilterSchema = paginationSchema.extend({
  status: queueStatusSchema.optional(),
  campaignId: cuidSchema.optional(),
  q: z.string().trim().max(200).optional(),
});

export const cancelJobSchema = z.object({
  id: cuidSchema,
  reason: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Worker API
// ---------------------------------------------------------------------------

export const pageStateSchema = z.enum([
  'AUTHENTICATED',
  'LOGIN_REQUIRED',
  'PROFILE_FOUND',
  'PROFILE_NOT_FOUND',
  'ALREADY_CONNECTED',
  'INVITATION_PENDING',
  'CONNECT_AVAILABLE',
  'SECURITY_CHALLENGE',
  'CAPTCHA',
  'ACCOUNT_RESTRICTED',
  'UNKNOWN_PAGE',
  'NETWORK_ERROR',
]);

export const errorClassSchema = z.enum(['NONE', 'TECHNICAL', 'PERMANENT', 'SAFETY']);

export const workerRegisterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  hostname: z.string().trim().min(1).max(200),
  pid: z.coerce.number().int().min(0).max(4_294_967_295),
  version: z.string().trim().max(40).optional(),
  forceTakeover: z.boolean().default(false),
});

export const workerHeartbeatSchema = z.object({
  workerId: cuidSchema,
  status: z
    .enum(['STARTING', 'IDLE', 'RUNNING', 'PAUSED', 'DRAINING', 'STOPPED', 'UNHEALTHY'])
    .optional(),
  browserStatus: z.enum(['CLOSED', 'LAUNCHING', 'OPEN', 'CRASHED']).optional(),
  sessionStatus: z
    .enum(['UNKNOWN', 'CONNECTED', 'DISCONNECTED', 'LOGIN_REQUIRED', 'CHALLENGE_DETECTED'])
    .optional(),
  currentJobId: cuidSchema.nullable().optional(),
  lastError: z.string().max(2_000).nullable().optional(),
});

export const workerClaimSchema = z.object({
  workerId: cuidSchema,
});

/**
 * A completion report. `result` is the *verified* outcome - either a detected
 * page state or `SENT` after the worker re-read the page and confirmed the
 * invitation went out.
 */
export const workerCompleteSchema = z.object({
  workerId: cuidSchema,
  jobId: cuidSchema,
  claimToken: z.string().min(10).max(200),
  result: z.union([pageStateSchema, z.literal('SENT')]),
  pageState: pageStateSchema.nullable().optional(),
  screenshotPath: z.string().max(500).nullable().optional(),
  durationMs: z.coerce.number().int().min(0).max(3_600_000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const workerFailSchema = z.object({
  workerId: cuidSchema,
  jobId: cuidSchema,
  claimToken: z.string().min(10).max(200),
  error: z.string().min(1).max(8_000),
  errorClass: errorClassSchema,
  pageState: pageStateSchema.nullable().optional(),
  pageUrl: z.string().max(1_000).nullable().optional(),
  screenshotPath: z.string().max(500).nullable().optional(),
});

export const workerStoppedSchema = z.object({
  workerId: cuidSchema,
  reason: z.string().trim().min(1).max(500),
  /**
   * True when the worker finished its work and exited, rather than stopping
   * because something went wrong. Without it every clean exit is recorded as
   * the worker's last error and shown to the operator in red.
   */
  clean: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Incidents / safety
// ---------------------------------------------------------------------------

export const incidentTypeSchema = z.enum([
  'LOGIN_REQUIRED',
  'CAPTCHA',
  'SECURITY_CHALLENGE',
  'ACCOUNT_RESTRICTED',
  'UNEXPECTED_PAGE',
  'PROFILE_UNPROCESSABLE',
  'BROWSER_ERROR',
  'NETWORK_FAILURE',
  'WORKER_UNHEALTHY',
  'DUPLICATE_GUARD_TRIGGERED',
  'CONFIGURATION_ERROR',
]);

export const createIncidentSchema = z.object({
  type: incidentTypeSchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('WARNING'),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(4_000),
  blocksWorker: z.boolean().default(true),
  campaignId: cuidSchema.nullable().optional(),
  leadId: cuidSchema.nullable().optional(),
  queueJobId: cuidSchema.nullable().optional(),
  workerId: cuidSchema.nullable().optional(),
  pageState: pageStateSchema.nullable().optional(),
  pageUrl: z.string().max(1_000).nullable().optional(),
  screenshotPath: z.string().max(500).nullable().optional(),
  engageKillSwitch: z.boolean().default(false),
});

export const resolveIncidentSchema = z.object({
  incidentId: cuidSchema,
  action: z.enum(['RESUME', 'SKIP_LEAD', 'BLOCK_LEAD', 'REQUEUE_LEAD', 'STOP_CAMPAIGN']),
  note: z.string().trim().max(2_000).optional().nullable(),
});

export const acknowledgeIncidentSchema = z.object({ incidentId: cuidSchema });

/**
 * The emergency stop. `confirm` is a literal so it cannot fire from a
 * mis-routed request, and a reason is mandatory so the audit log is meaningful.
 */
export const emergencyStopSchema = z.object({
  confirm: z.literal(true, { message: 'Emergency stop must be explicitly confirmed' }),
  reason: z.string().trim().min(1, 'A reason is required for the audit log').max(500),
});

export const clearEmergencyStopSchema = z.object({
  confirm: z.literal(true, { message: 'Clearing the stop must be explicitly confirmed' }),
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export const activityFilterSchema = paginationSchema.extend({
  campaignId: cuidSchema.optional(),
  leadId: cuidSchema.optional(),
  result: z
    .enum([
      'SUCCESS',
      'ALREADY_CONNECTED',
      'ALREADY_PENDING',
      'SKIPPED',
      'FAILED',
      'REQUIRES_REVIEW',
      'CANCELLED',
      'INFO',
    ])
    .optional(),
  action: z.string().trim().max(60).optional(),
  q: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required').max(300),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type CampaignSettingsInput = z.infer<typeof campaignSettingsSchema>;
export type MessageTemplateInput = z.infer<typeof messageTemplateSchema>;
export type LeadFilterInput = z.infer<typeof leadFilterSchema>;
export type QueueFilterInput = z.infer<typeof queueFilterSchema>;
export type ActivityFilterInput = z.infer<typeof activityFilterSchema>;
