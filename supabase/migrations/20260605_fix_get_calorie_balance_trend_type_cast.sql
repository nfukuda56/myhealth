-- Fix: burned_kcal(INTEGER) / basal_metabolism_kcal(INTEGER) → NUMERIC キャストで型不一致を解消
-- config.default_basal_metabolism_kcal をフォールバックとして利用
CREATE OR REPLACE FUNCTION get_calorie_balance_trend(p_start_date DATE, p_end_date DATE)
RETURNS TABLE(
  target_date DATE, intake_kcal NUMERIC, burned_kcal NUMERIC,
  basal_metabolism NUMERIC, estimated_total_burned NUMERIC, balance NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_default_basal NUMERIC;
BEGIN
  SELECT default_basal_metabolism_kcal::NUMERIC INTO v_default_basal
  FROM config WHERE user_id = auth.uid() LIMIT 1;

  RETURN QUERY
  SELECT
    dl.target_date,
    COALESCE((SELECT SUM(m.calories_kcal) FROM meals m WHERE m.daily_log_id = dl.id), 0)::NUMERIC,
    COALESCE((SELECT SUM(e.burned_kcal::NUMERIC) FROM exercises e WHERE e.daily_log_id = dl.id), 0)::NUMERIC,
    COALESCE(
      (SELECT bm.basal_metabolism_kcal::NUMERIC FROM body_metrics bm
       WHERE bm.user_id = dl.user_id AND bm.basal_metabolism_kcal IS NOT NULL
         AND bm.measured_at <= dl.day_start_at + INTERVAL '1 day'
       ORDER BY bm.measured_at DESC LIMIT 1),
      v_default_basal
    ),
    COALESCE((SELECT SUM(e2.burned_kcal::NUMERIC) FROM exercises e2 WHERE e2.daily_log_id = dl.id), 0)::NUMERIC
    + COALESCE(
        (SELECT bm2.basal_metabolism_kcal::NUMERIC FROM body_metrics bm2
         WHERE bm2.user_id = dl.user_id AND bm2.basal_metabolism_kcal IS NOT NULL
           AND bm2.measured_at <= dl.day_start_at + INTERVAL '1 day'
         ORDER BY bm2.measured_at DESC LIMIT 1),
        v_default_basal, 0::NUMERIC),
    COALESCE((SELECT SUM(m2.calories_kcal) FROM meals m2 WHERE m2.daily_log_id = dl.id), 0)::NUMERIC
    - (COALESCE((SELECT SUM(e3.burned_kcal::NUMERIC) FROM exercises e3 WHERE e3.daily_log_id = dl.id), 0)::NUMERIC
       + COALESCE(
           (SELECT bm3.basal_metabolism_kcal::NUMERIC FROM body_metrics bm3
            WHERE bm3.user_id = dl.user_id AND bm3.basal_metabolism_kcal IS NOT NULL
              AND bm3.measured_at <= dl.day_start_at + INTERVAL '1 day'
            ORDER BY bm3.measured_at DESC LIMIT 1),
           v_default_basal, 0::NUMERIC))
  FROM daily_logs dl
  WHERE dl.user_id = auth.uid()
    AND dl.target_date BETWEEN p_start_date AND p_end_date
  ORDER BY dl.target_date ASC;
END;$$;
GRANT EXECUTE ON FUNCTION get_calorie_balance_trend(DATE, DATE) TO authenticated;
