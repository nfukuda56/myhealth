-- get_daily_summary: 基礎代謝フォールバック (body_metrics → config) 対応
CREATE OR REPLACE FUNCTION get_daily_summary(p_target_date DATE)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id UUID; v_log_id BIGINT; v_day_start TIMESTAMPTZ;
  v_basal NUMERIC; v_elapsed_ratio NUMERIC; v_basal_elapsed NUMERIC;
  v_intake NUMERIC; v_burned NUMERIC; v_total_burned NUMERIC;
BEGIN
  v_user_id := auth.uid();
  SELECT id, day_start_at INTO v_log_id, v_day_start
  FROM daily_logs WHERE user_id = v_user_id AND target_date = p_target_date;
  IF v_log_id IS NULL THEN
    RETURN json_build_object('target_date',p_target_date,'total_intake_kcal',0,
      'total_burned_kcal',0,'basal_metabolism',NULL,'basal_elapsed_kcal',NULL,
      'estimated_total_burned',0,'estimated_balance',0,'latest_weight',NULL,'latest_body_fat_pct',NULL);
  END IF;
  SELECT COALESCE(
    (SELECT basal_metabolism_kcal FROM body_metrics
     WHERE user_id=v_user_id AND basal_metabolism_kcal IS NOT NULL
       AND measured_at <= v_day_start + INTERVAL '1 day'
     ORDER BY measured_at DESC LIMIT 1),
    (SELECT default_basal_metabolism_kcal FROM config WHERE user_id=v_user_id LIMIT 1)
  ) INTO v_basal;
  IF p_target_date = CURRENT_DATE AND v_day_start IS NOT NULL THEN
    v_elapsed_ratio := LEAST(EXTRACT(EPOCH FROM (NOW()-v_day_start))/86400.0,1.0);
  ELSE v_elapsed_ratio := 1.0; END IF;
  v_basal_elapsed := CASE WHEN v_basal IS NOT NULL THEN ROUND(v_basal*v_elapsed_ratio) ELSE NULL END;
  SELECT COALESCE(SUM(calories_kcal),0) INTO v_intake FROM meals WHERE daily_log_id=v_log_id;
  SELECT COALESCE(SUM(burned_kcal),0) INTO v_burned FROM exercises WHERE daily_log_id=v_log_id;
  v_total_burned := COALESCE(v_basal_elapsed,0)+v_burned;
  RETURN json_build_object(
    'target_date',p_target_date,'total_intake_kcal',v_intake,'total_burned_kcal',v_burned,
    'basal_metabolism',v_basal,'basal_elapsed_kcal',v_basal_elapsed,
    'estimated_total_burned',v_total_burned,'estimated_balance',v_intake-v_total_burned,
    'latest_weight',(SELECT weight_kg FROM body_metrics WHERE daily_log_id=v_log_id ORDER BY measured_at DESC LIMIT 1),
    'latest_body_fat_pct',(SELECT body_fat_pct FROM body_metrics WHERE daily_log_id=v_log_id ORDER BY measured_at DESC LIMIT 1));
END;$$;
GRANT EXECUTE ON FUNCTION get_daily_summary(DATE) TO authenticated;
