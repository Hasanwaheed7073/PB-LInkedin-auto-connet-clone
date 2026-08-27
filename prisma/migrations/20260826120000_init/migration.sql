-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'ALREADY_CONNECTED', 'ALREADY_PENDING', 'SKIPPED', 'FAILED', 'REQUIRES_REVIEW', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'ERROR');

-- CreateEnum
CREATE TYPE "QueueAction" AS ENUM ('CONNECT', 'MESSAGE', 'FOLLOW', 'PROFILE_VISIT');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REQUIRES_REVIEW');

-- CreateEnum
CREATE TYPE "PageState" AS ENUM ('AUTHENTICATED', 'LOGIN_REQUIRED', 'PROFILE_FOUND', 'PROFILE_NOT_FOUND', 'ALREADY_CONNECTED', 'INVITATION_PENDING', 'CONNECT_AVAILABLE', 'SECURITY_CHALLENGE', 'CAPTCHA', 'ACCOUNT_RESTRICTED', 'UNKNOWN_PAGE', 'NETWORK_ERROR');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('STARTING', 'IDLE', 'RUNNING', 'PAUSED', 'DRAINING', 'STOPPED', 'UNHEALTHY');

-- CreateEnum
CREATE TYPE "BrowserStatus" AS ENUM ('CLOSED', 'LAUNCHING', 'OPEN', 'CRASHED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('UNKNOWN', 'CONNECTED', 'DISCONNECTED', 'LOGIN_REQUIRED', 'CHALLENGE_DETECTED');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('LOGIN_REQUIRED', 'CAPTCHA', 'SECURITY_CHALLENGE', 'ACCOUNT_RESTRICTED', 'UNEXPECTED_PAGE', 'PROFILE_UNPROCESSABLE', 'BROWSER_ERROR', 'NETWORK_FAILURE', 'WORKER_UNHEALTHY', 'DUPLICATE_GUARD_TRIGGERED', 'CONFIGURATION_ERROR');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ErrorClass" AS ENUM ('NONE', 'TECHNICAL', 'PERMANENT', 'SAFETY');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('CONNECT', 'MESSAGE', 'FOLLOW', 'PROFILE_VISIT', 'LEADS_IMPORTED', 'LEAD_SKIPPED', 'LEAD_STATUS_CHANGED', 'LEAD_DELETED', 'CAMPAIGN_CREATED', 'CAMPAIGN_UPDATED', 'CAMPAIGN_ACTIVATED', 'CAMPAIGN_PAUSED', 'CAMPAIGN_RESUMED', 'CAMPAIGN_COMPLETED', 'CAMPAIGN_ERROR', 'QUEUE_GENERATED', 'JOB_CLAIMED', 'JOB_COMPLETED', 'JOB_FAILED', 'JOB_CANCELLED', 'JOB_RETRY_SCHEDULED', 'WORKER_REGISTERED', 'WORKER_HEARTBEAT_STALE', 'WORKER_STOPPED', 'SESSION_STATUS_CHANGED', 'EMERGENCY_STOP', 'EMERGENCY_STOP_CLEARED', 'INCIDENT_OPENED', 'INCIDENT_RESOLVED', 'TEMPLATE_CREATED', 'TEMPLATE_UPDATED', 'SETTINGS_UPDATED', 'USER_LOGIN');

-- CreateEnum
CREATE TYPE "ActivityResult" AS ENUM ('SUCCESS', 'ALREADY_CONNECTED', 'ALREADY_PENDING', 'SKIPPED', 'FAILED', 'REQUIRES_REVIEW', 'CANCELLED', 'INFO');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'WORKER', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OPERATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pausedBy" TEXT,
    "pauseReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "messageTemplateId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_settings" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "dailyLimit" INTEGER NOT NULL DEFAULT 20,
    "windowStartMinute" INTEGER NOT NULL DEFAULT 540,
    "windowEndMinute" INTEGER NOT NULL DEFAULT 1020,
    "operatingDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "minActionDelaySeconds" INTEGER NOT NULL DEFAULT 45,
    "maxActionDelaySeconds" INTEGER NOT NULL DEFAULT 180,
    "maxAttemptsPerLead" INTEGER NOT NULL DEFAULT 3,
    "pauseOnIncident" BOOLEAN NOT NULL DEFAULT true,
    "skipLeadsMissingTemplateVars" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "fullName" TEXT NOT NULL,
    "linkedinUrl" TEXT NOT NULL,
    "publicIdentifier" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "company" TEXT,
    "jobTitle" TEXT,
    "location" TEXT,
    "campaignId" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "notes" TEXT,
    "invitationSentAt" TIMESTAMP(3),
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_jobs" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "action" "QueueAction" NOT NULL DEFAULT 'CONNECT',
    "status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3),
    "error" TEXT,
    "errorClass" "ErrorClass" NOT NULL DEFAULT 'NONE',
    "result" TEXT,
    "resultPageState" "PageState",
    "resultDetail" JSONB,
    "claimedByWorkerId" TEXT,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "status" "WorkerStatus" NOT NULL DEFAULT 'STARTING',
    "browserStatus" "BrowserStatus" NOT NULL DEFAULT 'CLOSED',
    "sessionStatus" "SessionStatus" NOT NULL DEFAULT 'UNKNOWN',
    "currentJobId" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "jobsProcessed" INTEGER NOT NULL DEFAULT 0,
    "jobsFailed" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" "ActivityAction" NOT NULL,
    "result" "ActivityResult" NOT NULL,
    "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "actorName" TEXT,
    "campaignId" TEXT,
    "leadId" TEXT,
    "queueJobId" TEXT,
    "workerId" TEXT,
    "incidentId" TEXT,
    "message" TEXT,
    "error" TEXT,
    "pageState" "PageState",
    "screenshotPath" TEXT,
    "durationMs" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "type" "IncidentType" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL DEFAULT 'WARNING',
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "blocksWorker" BOOLEAN NOT NULL DEFAULT true,
    "campaignId" TEXT,
    "leadId" TEXT,
    "queueJobId" TEXT,
    "workerId" TEXT,
    "pageState" "PageState",
    "pageUrl" TEXT,
    "screenshotPath" TEXT,
    "detail" JSONB,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "resolutionAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "killSwitchEngaged" BOOLEAN NOT NULL DEFAULT false,
    "killSwitchReason" TEXT,
    "killSwitchEngagedAt" TIMESTAMP(3),
    "killSwitchEngagedBy" TEXT,
    "activeWorkerId" TEXT,
    "controlEpoch" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_name_key" ON "campaigns"("name");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaigns_active_status_idx" ON "campaigns"("active", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_settings_campaignId_key" ON "campaign_settings"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_name_key" ON "message_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "leads_linkedinUrl_key" ON "leads"("linkedinUrl");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_campaignId_status_idx" ON "leads"("campaignId", "status");

-- CreateIndex
CREATE INDEX "leads_publicIdentifier_idx" ON "leads"("publicIdentifier");

-- CreateIndex
CREATE INDEX "leads_importBatchId_idx" ON "leads"("importBatchId");

-- CreateIndex
CREATE INDEX "leads_campaignId_status_createdAt_idx" ON "leads"("campaignId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "queue_jobs_status_scheduledFor_idx" ON "queue_jobs"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "queue_jobs_campaignId_status_idx" ON "queue_jobs"("campaignId", "status");

-- CreateIndex
CREATE INDEX "queue_jobs_leadId_idx" ON "queue_jobs"("leadId");

-- CreateIndex
CREATE INDEX "queue_jobs_status_campaignId_priority_scheduledFor_idx" ON "queue_jobs"("status", "campaignId", "priority", "scheduledFor");

-- CreateIndex
CREATE INDEX "queue_jobs_claimedByWorkerId_idx" ON "queue_jobs"("claimedByWorkerId");

-- CreateIndex
CREATE INDEX "queue_jobs_claimExpiresAt_idx" ON "queue_jobs"("claimExpiresAt");

-- CreateIndex
CREATE INDEX "workers_status_idx" ON "workers"("status");

-- CreateIndex
CREATE INDEX "workers_lastHeartbeatAt_idx" ON "workers"("lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_campaignId_createdAt_idx" ON "activity_logs"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_leadId_createdAt_idx" ON "activity_logs"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_action_createdAt_idx" ON "activity_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_result_createdAt_idx" ON "activity_logs"("result", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_workerId_createdAt_idx" ON "activity_logs"("workerId", "createdAt");

-- CreateIndex
CREATE INDEX "incidents_status_createdAt_idx" ON "incidents"("status", "createdAt");

-- CreateIndex
CREATE INDEX "incidents_status_blocksWorker_idx" ON "incidents"("status", "blocksWorker");

-- CreateIndex
CREATE INDEX "incidents_type_status_idx" ON "incidents"("type", "status");

-- CreateIndex
CREATE INDEX "incidents_campaignId_status_idx" ON "incidents"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_messageTemplateId_fkey" FOREIGN KEY ("messageTemplateId") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_settings" ADD CONSTRAINT "campaign_settings_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_jobs" ADD CONSTRAINT "queue_jobs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_jobs" ADD CONSTRAINT "queue_jobs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_jobs" ADD CONSTRAINT "queue_jobs_claimedByWorkerId_fkey" FOREIGN KEY ("claimedByWorkerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_queueJobId_fkey" FOREIGN KEY ("queueJobId") REFERENCES "queue_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_queueJobId_fkey" FOREIGN KEY ("queueJobId") REFERENCES "queue_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

