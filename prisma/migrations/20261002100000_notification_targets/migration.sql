-- One target per chat channel: until now SLACK and WEBHOOK shared `webhookUrl`, so a rule with both
-- channels ticked posted the Slack payload AND the generic payload to the same URL.
ALTER TABLE "alert_rules" ADD COLUMN "slackWebhookUrl" TEXT,
ADD COLUMN "teamsWebhookUrl" TEXT;

-- Existing rules: the URL of a Slack rule was meant for Slack.
UPDATE "alert_rules" SET "slackWebhookUrl" = "webhookUrl" WHERE 'SLACK' = ANY("channels") AND "webhookUrl" IS NOT NULL;
UPDATE "alert_rules" SET "webhookUrl" = NULL WHERE 'SLACK' = ANY("channels") AND NOT ('WEBHOOK' = ANY("channels"));
