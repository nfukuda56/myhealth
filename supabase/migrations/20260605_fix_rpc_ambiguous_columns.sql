-- Fix: get_body_trend - LATERAL サブクエリのカラム名衝突を解消
CREATE OR REPLACE FUNCTION get_body_trend(p_start_date DATE, p_end_date DATE)
RETURNS TABLE(target_date DATE, weight NUMERIC, body_fat_pct NUMERIC,
              fat_mass NUMERIC, lean_body_mass NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT dl.target_date, bm.w, bm.bfp,
    CASE WHEN bm.w IS NOT NULL AND bm.bfp IS NOT NULL
      THEN ROUND(bm.w * bm.bfp / 100, 2) ELSE NULL END,
    CASE WHEN bm.w IS NOT NULL AND bm.bfp IS NOT NULL
      THEN ROUND(bm.w - (bm.w * bm.bfp / 100), 2) ELSE NULL END
  FROM daily_logs dl
  JOIN LATERAL (
    SELECT weight_kg AS w, body_fat_pct AS bfp FROM body_metrics
    WHERE daily_log_id = dl.id AND weight_kg IS NOT NULL
    ORDER BY measured_at DESC LIMIT 1
  ) bm ON true
  WHERE dl.user_id = auth.uid()
    AND dl.target_date BETWEEN p_start_date AND p_end_date
  ORDER BY dl.target_date ASC;
END;$$;
GRANT EXECUTE ON FUNCTION get_body_trend(DATE, DATE) TO authenticated;

-- Fix: get_daily_timeline - UNION ALL の ORDER BY をサブクエリ化で解消
CREATE OR REPLACE FUNCTION get_daily_timeline(p_target_date DATE)
RETURNS TABLE(event_time TIMESTAMPTZ, event_type TEXT, summary TEXT, ref_id BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_user_id UUID; v_log_id BIGINT;
BEGIN
  v_user_id := auth.uid();
  SELECT id INTO v_log_id FROM daily_logs
  WHERE user_id = v_user_id AND target_date = p_target_date;
  IF v_log_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT * FROM (
    SELECT bm.measured_at, 'body_metric'::TEXT,
      CONCAT(CASE WHEN bm.weight_kg IS NOT NULL THEN '体重 '||bm.weight_kg||'kg' ELSE '' END,
             CASE WHEN bm.body_fat_pct IS NOT NULL THEN ' / 体脂肪 '||bm.body_fat_pct||'%' ELSE '' END),
      bm.id::BIGINT
    FROM body_metrics bm WHERE bm.daily_log_id = v_log_id
    UNION ALL
    SELECT m.measured_at, 'meal'::TEXT,
      CONCAT(CASE m.meal_type WHEN 'breakfast' THEN '朝食' WHEN 'lunch' THEN '昼食'
               WHEN 'dinner' THEN '夕食' WHEN 'snack' THEN '間食' ELSE m.meal_type END,
             CASE WHEN m.menu_name IS NOT NULL THEN ': '||m.menu_name ELSE '' END,
             CASE WHEN m.calories_kcal IS NOT NULL THEN ' '||m.calories_kcal||'kcal' ELSE '' END),
      m.id::BIGINT
    FROM meals m WHERE m.daily_log_id = v_log_id
    UNION ALL
    SELECT e.measured_at, 'exercise'::TEXT,
      CONCAT(e.exercise_type,
             CASE WHEN e.duration_min IS NOT NULL THEN ' '||e.duration_min||'分' ELSE '' END,
             CASE WHEN e.burned_kcal IS NOT NULL THEN ' '||e.burned_kcal||'kcal' ELSE '' END),
      e.id::BIGINT
    FROM exercises e WHERE e.daily_log_id = v_log_id
  ) sub ORDER BY event_time ASC;
END;$$;
GRANT EXECUTE ON FUNCTION get_daily_timeline(DATE) TO authenticated;
