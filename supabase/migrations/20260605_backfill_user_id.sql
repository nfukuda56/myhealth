-- user_id バックフィル（初期データマイグレーション後の紐付け）
-- daily_logs の重複レコード（子なし）を削除してからバックフィル
DO $$
DECLARE
  v_uid UUID := '7be1485c-ee4a-4d43-9571-5cdd10458413';
BEGIN
  DELETE FROM daily_logs dl
  WHERE (SELECT COUNT(*) FROM daily_logs dl2 WHERE dl2.target_date = dl.target_date) > 1
    AND (SELECT COUNT(*) FROM meals        WHERE daily_log_id = dl.id) = 0
    AND (SELECT COUNT(*) FROM exercises    WHERE daily_log_id = dl.id) = 0
    AND (SELECT COUNT(*) FROM body_metrics WHERE daily_log_id = dl.id) = 0;

  UPDATE daily_logs    SET user_id = v_uid WHERE user_id IS NULL;
  UPDATE body_metrics  SET user_id = v_uid WHERE user_id IS NULL;
  UPDATE meals         SET user_id = v_uid WHERE user_id IS NULL;
  UPDATE exercises     SET user_id = v_uid WHERE user_id IS NULL;
  UPDATE config        SET user_id = v_uid WHERE user_id IS NULL;
END;
$$;
