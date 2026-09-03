/**
 * Single source of truth for the @argosvix/sdk version.
 *
 * Must match the `version` field in package.json exactly. The recorder embeds
 * this value in the `redactionMetadata.redactor` field, so the dashboard and
 * backend can audit which SDK version performed the redaction.
 *
 * Update procedure:
 *   1. Update SDK_VERSION in this file
 *   2. Update `version` in packages/sdk/package.json to the same value
 *   3. Verify npm run build && tests pass before committing
 */

export const SDK_VERSION = "0.5.14" as const;
