-- =========================================================
-- RPC v1: get_daily_summary
-- 日次サマリー（摂取kcal・消費kcal・基礎代謝・推定収支）
-- =========================================================
CREATE OR REPLACE FUNCTION get_daily_summary(p_target_date DATE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_user_id          UUID;
  v_log_id           BIGINT;
  v_day_start        TIMESTAMPTZ;
  v_basal            NUMERIC;
  v_elapsed_ratio    NUMERIC;
  v_basal_elapsed    NUMERIC;
  v_intake           NUMERIC;
  v_burned           NUMERIC;
  v_total_burned     NUMERIC;
BEGIN
  v_user_id := auth.uid();

  SELECT id, day_start_at INTO v_log_id, v_day_start
  FROM daily_logs
  WHERE user_id = v_user_id AND target_date = p_target_date;

  IF v_log_id IS NULL THEN
    RETURN json_build_object(
      'target_date',          p_target_date,
      'total_intake_kcal',    0,
      'total_burned_kcal',    0,
      'basal_metabolism',     NULL,
      'basal_elapsed_kcal',   NULL,
      'estimated_total_burned', 0,
      'estimated_balance',    0,
      'latest_weight',        NULL,
      'latest_body_fat_pct',  NULL
    );
  END IF;

  SELECT basal_metabolism_kcal INTO v_basal
  FROM body_metrics
  WHERE user_id = v_user_id
    AND basal_metabolism_kcal IS NOT NULL
    AND measured_at <= v_day_start + INTERVAL '1 day'
  ORDER BY measured_at DESC LIMIT 1;

  IF p_target_date = CURRENT_DATE AND v_day_start IS NOT NULL THEN
    v_elapsed_ratio := LEAST(
      EXTRACT(EPOCH FROM (NOW() - v_day_start)) / 86400.0, 1.0
    );
  ELSE
    v_elapsed_ratio := 1.0;
  END IF;

  v_basal_elapsed := CASE WHEN v_basal IS NOT NULL
    THEN ROUND(v_basal * v_elapsed_ratio) ELSE NULL END;

  SELECT COALESCE(SUM(calories_kcal), 0) INTO v_intake
  FROM meals WHERE daily_log_id = v_log_id;

  SELECT COALESCE(SUM(burned_kcal), 0) INTO v_burned
  FROM exercises WHERE daily_log_id = v_log_id;

  v_total_burned := COALESCE(v_basal_elapsed, 0) + v_burned;

  RETURN json_build_object(
    'target_date',            p_target_date,
    'total_intake_kcal',      v_intake,
    'total_burned_kcal',      v_burned,
    'basal_metabolism',       v_basal,
    'basal_elapsed_kcal',     v_basal_elapsed,
    'estimated_total_burned', v_total_burned,
    'estimated_balance',      v_intake - v_total_burned,
    'latest_weight',          (SELECT weight_kg FROM body_metrics
                               WHERE daily_log_id = v_log_id ORDER BY measured_at DESC LIMIT 1),
    'latest_body_fat_pct',    (SELECT body_fat_pct FROM body_metrics
                               WHERE daily_log_id = v_log_id ORDER BY measured_at DESC LIMIT 1)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_daily_summary(DATE) TO authenticated;


-- =========================================================
-- RPC v1: get_daily_timeline
-- =========================================================
CREATE OR REPLACE FUNCTION get_daily_timeline(p_target_date DATE)
RETURNS TABLE(event_time TIMESTAMPTZ, event_type TEXT, summary TEXT, ref_id BIGINT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_log_id  BIGINT;
BEGIN
  v_user_id := auth.uid();
  SELECT id INTO v_log_id FROM daily_logs
  WHERE user_id = v_user_id AND target_date = p_target_date;
  IF v_log_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT bm.measured_at, 'body_metric'::TEXT,
      CONCAT(
        CASE WHEN bm.weight_kg IS NOT NULL THEN '体重 '||bm.weight_kg||'kg' ELSE '' END,
        CASE WHEN bm.body_fat_pct IS NOT NULL THEN ' / 体脂肪 '||bm.body_fat_pct||'%' ELSE '' END
      ), bm.id::BIGINT
    FROM body_metrics bm WHERE bm.daily_log_id = v_log_id
  UNION ALL
    SELECT m.measured_at, 'meal'::TEXT,
      CONCAT(
        CASE m.meal_type WHEN 'breakfast' THEN '朝食' WHEN 'lunch' THEN '昼食'
          WHEN 'dinner' THEN '夕食' WHEN 'snack' THEN '間食' ELSE m.meal_type END,
        CASE WHEN m.menu_name IS NOT NULL THEN ': '||m.menu_name ELSE '' END,
        CASE WHEN m.calories_kcal IS NOT NULL THEN ' '||m.calories_kcal||'kcal' ELSE '' END
      ), m.id::BIGINT
    FROM meals m WHERE m.daily_log_id = v_log_id
  UNION ALL
    SELECT e.measured_at, 'exercise'::TEXT,
      CONCAT(e.exercise_type,
        CASE WHEN e.duration_min IS NOT NULL THEN ' '||e.duration_min||'分' ELSE '' END,
        CASE WHEN e.burned_kcal IS NOT NULL THEN ' '||e.burned_kcal||'kcal' ELSE '' END
      ), e.id::BIGINT
    FROM exercises e WHERE e.daily_log_id = v_log_id
  ORDER BY event_time ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_daily_timeline(DATE) TO authenticated;


-- =========================================================
-- RPC v1: get_body_trend
-- =========================================================
CREATE OR REPLACE FUNCTION get_body_trend(p_start_date DATE, p_end_date DATE)
RETURNS TABLE(target_date DATE, weight NUMERIC, body_fat_pct NUMERIC,
              fat_mass NUMERIC, lean_body_mass NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT dl.target_date, bm.weight_kg, bm.body_fat_pct,
    CASE WHEN bm.weight_kg IS NOT NULL AND bm.body_fat_pct IS NOT NULL
      THEN ROUND(bm.weight_kg * bm.body_fat_pct / 100, 2) ELSE NULL END,
    CASE WHEN bm.weight_kg IS NOT NULL AND bm.body_fat_pct IS NOT NULL
      THEN ROUND(bm.weight_kg - (bm.weight_kg * bm.body_fat_pct / 100), 2) ELSE NULL END
  FROM daily_logs dl
  JOIN LATERAL (
    SELECT weight_kg, body_fat_pct FROM body_metrics
    WHERE daily_log_id = dl.id AND weight_kg IS NOT NULL
    ORDER BY measured_at DESC LIMIT 1
  ) bm ON true
  WHERE dl.user_id = auth.uid()
    AND dl.target_date BETWEEN p_start_date AND p_end_date
  ORDER BY dl.target_date ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_body_trend(DATE, DATE) TO authenticated;


-- =========================================================
-- RPC v1: get_calorie_balance_trend
-- =========================================================
CREATE OR REPLACE FUNCTION get_calorie_balance_trend(p_start_date DATE, p_end_date DATE)
RETURNS TABLE(target_date DATE, intake_kcal NUMERIC, burned_kcal NUMERIC,
              basal_metabolism NUMERIC, estimated_total_burned NUMERIC, balance NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dl.target_date,
    COALESCE((SELECT SUM(m.calories_kcal) FROM meals m WHERE m.daily_log_id = dl.id), 0),
    COALESCE((SELECT SUM(e.burned_kcal)   FROM exercises e WHERE e.daily_log_id = dl.id), 0),
    (SELECT bm.basal_metabolism_kcal FROM body_metrics bm
     WHERE bm.user_id = dl.user_id AND bm.basal_metabolism_kcal IS NOT NULL
       AND bm.measured_at <= dl.day_start_at + INTERVAL '1 day'
     ORDER BY bm.measured_at DESC LIMIT 1),
    COALESCE((SELECT SUM(e2.burned_kcal) FROM exercises e2 WHERE e2.daily_log_id = dl.id), 0)
    + COALESCE((SELECT bm2.basal_metabolism_kcal FROM body_metrics bm2
                WHERE bm2.user_id = dl.user_id AND bm2.basal_metabolism_kcal IS NOT NULL
                  AND bm2.measured_at <= dl.day_start_at + INTERVAL '1 day'
                ORDER BY bm2.measured_at DESC LIMIT 1), 0),
    COALESCE((SELECT SUM(m2.calories_kcal) FROM meals m2 WHERE m2.daily_log_id = dl.id), 0)
    - (COALESCE((SELECT SUM(e3.burned_kcal) FROM exercises e3 WHERE e3.daily_log_id = dl.id), 0)
       + COALESCE((SELECT bm3.basal_metabolism_kcal FROM body_metrics bm3
                   WHERE bm3.user_id = dl.user_id AND bm3.basal_metabolism_kcal IS NOT NULL
                     AND bm3.measured_at <= dl.day_start_at + INTERVAL '1 day'
                   ORDER BY bm3.measured_at DESC LIMIT 1), 0))
  FROM daily_logs dl
  WHERE dl.user_id = auth.uid()
    AND dl.target_date BETWEEN p_start_date AND p_end_date
  ORDER BY dl.target_date ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_calorie_balance_trend(DATE, DATE) TO authenticated;


-- =========================================================
-- RPC v1: suggest_meal_items
-- =========================================================
CREATE OR REPLACE FUNCTION suggest_meal_items(p_query TEXT DEFAULT '', p_limit INT DEFAULT 10)
RETURNS TABLE(menu_name TEXT, avg_kcal NUMERIC, avg_protein NUMERIC,
              avg_fat NUMERIC, avg_carb NUMERIC, use_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT m.menu_name,
    ROUND(AVG(m.calories_kcal), 0),
    ROUND(AVG(m.protein_g), 1),
    ROUND(AVG(m.fat_g), 1),
    ROUND(AVG(m.carbs_g), 1),
    COUNT(*)
  FROM meals m
  WHERE m.user_id = auth.uid()
    AND m.menu_name IS NOT NULL
    AND (p_query = '' OR m.menu_name ILIKE '%' || p_query || '%')
  GROUP BY m.menu_name
  ORDER BY COUNT(*) DESC, m.menu_name ASC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION suggest_meal_items(TEXT, INT) TO authenticated;


-- =========================================================
-- RPC v1: get_latest_basal_metabolism
-- =========================================================
CREATE OR REPLACE FUNCTION get_latest_basal_metabolism(p_as_of TIMESTAMPTZ DEFAULT NOW())
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE v_result JSON;
BEGIN
  SELECT json_build_object('basal_metabolism', bm.basal_metabolism_kcal, 'measured_at', bm.measured_at)
  INTO v_result
  FROM body_metrics bm
  WHERE bm.user_id = auth.uid()
    AND bm.basal_metabolism_kcal IS NOT NULL
    AND bm.measured_at <= p_as_of
  ORDER BY bm.measured_at DESC LIMIT 1;
  RETURN COALESCE(v_result, json_build_object('basal_metabolism', NULL, 'measured_at', NULL));
END;
$$;

GRANT EXECUTE ON FUNCTION get_latest_basal_metabolism(TIMESTAMPTZ) TO authenticated;
