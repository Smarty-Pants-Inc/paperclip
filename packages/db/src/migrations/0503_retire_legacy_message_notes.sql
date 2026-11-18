-- paperclip:migration-compat online_compatible: Adds only a history marker to obsolete system notes. Existing readers tolerate additive metadata, and primary-key keyset batches visit at most 500 comments without rescanning prior rows.
-- paperclip:migration-safety-ignore loop-mutation-large-table: Existing issue_comments_pkey supports id >= cursor_id / id <= batch_end. Each batch visits at most 500 rows and advances past batch_end, so the remaining scan is linear, not a repeated metadata scan.
-- paperclip:migration-safety-ignore batched-mutation-large-table-missing-index: Existing issue_comments_pkey supports both ORDER BY id LIMIT 500 and the bounded id-range update. No new index is needed for a one-time, at-most-500-row keyset batch.
DO $$
DECLARE
  cursor_id uuid;
  batch_end uuid;
BEGIN
  SELECT id INTO cursor_id FROM issue_comments ORDER BY id LIMIT 1;
  LOOP
    EXIT WHEN cursor_id IS NULL;
    SELECT id INTO batch_end
    FROM (
      SELECT id FROM issue_comments WHERE id >= cursor_id ORDER BY id LIMIT 500
    ) batch
    ORDER BY id DESC LIMIT 1;
    EXIT WHEN batch_end IS NULL;

    UPDATE issue_comments
    SET metadata = jsonb_set(metadata, '{supersededByMigration}',
      '{"migration":"0495_retire_legacy_message_notes"}'::jsonb)
    WHERE id >= cursor_id AND id <= batch_end
      AND author_type = 'system'
      AND (starts_with(metadata->>'authorizationReason', 'unanswered_message:')
        OR starts_with(metadata->>'authorizationReason', 'retrying_message:'))
      AND metadata->'supersededByMigration' IS NULL;

    SELECT id INTO cursor_id FROM issue_comments WHERE id > batch_end ORDER BY id LIMIT 1;
  END LOOP;
END $$;
