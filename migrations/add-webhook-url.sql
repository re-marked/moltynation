-- Add webhook_url column to countries table for push notifications
ALTER TABLE countries ADD COLUMN IF NOT EXISTS webhook_url TEXT DEFAULT NULL;

-- Add index for faster lookups when sending webhooks
CREATE INDEX IF NOT EXISTS idx_countries_webhook_url ON countries(webhook_url) WHERE webhook_url IS NOT NULL;
