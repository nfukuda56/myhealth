import { supabase } from './supabase.js'

/**
 * 日次サマリー取得
 * @param {string} targetDate - YYYY-MM-DD
 */
export async function getDailySummary(targetDate) {
  const { data, error } = await supabase.rpc('get_daily_summary', {
    p_target_date: targetDate
  })
  if (error) throw error
  return data
}

/**
 * タイムライン取得
 * @param {string} targetDate - YYYY-MM-DD
 */
export async function getDailyTimeline(targetDate) {
  const { data, error } = await supabase.rpc('get_daily_timeline', {
    p_target_date: targetDate
  })
  if (error) throw error
  return data ?? []
}

/**
 * 体重・体脂肪推移取得
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 */
export async function getBodyTrend(startDate, endDate) {
  const { data, error } = await supabase.rpc('get_body_trend', {
    p_start_date: startDate,
    p_end_date: endDate
  })
  if (error) throw error
  return data ?? []
}

/**
 * カロリー収支推移取得
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 */
export async function getCalorieBalanceTrend(startDate, endDate) {
  const { data, error } = await supabase.rpc('get_calorie_balance_trend', {
    p_start_date: startDate,
    p_end_date: endDate
  })
  if (error) throw error
  return data ?? []
}

/**
 * 食事履歴サジェスト
 * @param {string} query
 * @param {number} limit
 */
export async function suggestMealItems(query = '', limit = 10) {
  const { data, error } = await supabase.rpc('suggest_meal_items', {
    p_query: query,
    p_limit: limit
  })
  if (error) throw error
  return data ?? []
}

/**
 * daily_log を upsert して id を返す（AM4:00 JST締め）
 * @param {string} targetDate - YYYY-MM-DD
 * @returns {number} log_id
 */
export async function ensureDailyLog(targetDate) {
  // AM4:00 JST = 前日 19:00 UTC
  const dayStartAt = new Date(`${targetDate}T04:00:00+09:00`).toISOString()
  const { data, error } = await supabase
    .from('daily_logs')
    .upsert(
      { target_date: targetDate, day_start_at: dayStartAt },
      { onConflict: 'user_id,target_date' }
    )
    .select('id')
    .single()
  if (error) throw error
  return data.id
}
