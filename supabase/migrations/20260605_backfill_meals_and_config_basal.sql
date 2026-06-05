-- meals.daily_log_id バックフィル（AM4:00 JST締め）
UPDATE meals m
SET daily_log_id = dl.id
FROM daily_logs dl
WHERE m.user_id = dl.user_id
  AND m.daily_log_id IS NULL
  AND dl.target_date = (
    CASE
      WHEN EXTRACT(HOUR FROM m.measured_at AT TIME ZONE 'Asia/Tokyo') < 4
        THEN (m.measured_at AT TIME ZONE 'Asia/Tokyo')::date - INTERVAL '1 day'
      ELSE (m.measured_at AT TIME ZONE 'Asia/Tokyo')::date
    END
  )::date;

-- config: NOT NULL 制約緩和 + default_basal_metabolism_kcal 追加
ALTER TABLE config
  ALTER COLUMN height_cm DROP NOT NULL,
  ALTER COLUMN age        DROP NOT NULL,
  ALTER COLUMN gender     DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS default_basal_metabolism_kcal INTEGER;

COMMENT ON COLUMN config.default_basal_metabolism_kcal
  IS '基礎代謝デフォルト値(kcal) - 体組成計未入力日のフォールバック用';

INSERT INTO config (user_id, default_basal_metabolism_kcal)
VALUES ('7be1485c-ee4a-4d43-9571-5cdd10458413', NULL)
ON CONFLICT DO NOTHING;
