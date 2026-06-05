-- Fix: RETURNS TABLE の body_fat_pct と body_metrics.body_fat_pct の名前衝突
-- inner_bm エイリアスで明示修飾して解消
CREATE OR REPLACE FUNCTION get_body_trend(p_start_date DATE, p_end_date DATE)
RETURNS TABLE(target_date DATE, weight NUMERIC, body_fat_pct NUMERIC,
              fat_mass NUMERIC, lean_body_mass NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT dl.target_date, sub.w, sub.bfp,
    CASE WHEN sub.w IS NOT NULL AND sub.bfp IS NOT NULL
      THEN ROUND(sub.w * sub.bfp / 100, 2) ELSE NULL END,
    CASE WHEN sub.w IS NOT NULL AND sub.bfp IS NOT NULL
      THEN ROUND(sub.w - (sub.w * sub.bfp / 100), 2) ELSE NULL END
  FROM daily_logs dl
  JOIN LATERAL (
    SELECT inner_bm.weight_kg AS w, inner_bm.body_fat_pct AS bfp
    FROM body_metrics inner_bm
    WHERE inner_bm.daily_log_id = dl.id AND inner_bm.weight_kg IS NOT NULL
    ORDER BY inner_bm.measured_at DESC LIMIT 1
  ) sub ON true
  WHERE dl.user_id = auth.uid()
    AND dl.target_date BETWEEN p_start_date AND p_end_date
  ORDER BY dl.target_date ASC;
END;$$;
GRANT EXECUTE ON FUNCTION get_body_trend(DATE, DATE) TO authenticated;
