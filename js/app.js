import { requireAuth, signOut } from './auth.js'
import { getDailySummary, getDailyTimeline } from './api.js'
import { DAY_BOUNDARY_HOUR } from './config.js'
import { supabase } from './supabase.js'

// =============================================
// 日付ユーティリティ
// =============================================

/** Date を YYYY-MM-DD 文字列に変換（JST基準） */
export function toDateStr(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

/** YYYY-MM-DD を「M月D日(曜日)」に変換 */
export function formatDateJa(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+09:00')
  const days = ['日','月','火','水','木','金','土']
  return `${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`
}

/** 今日の target_date を返す（AM4:00 JST締め） */
export function todayTargetDate() {
  const now = new Date()
  const jstHour = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).getHours()
  if (jstHour < DAY_BOUNDARY_HOUR) {
    // 深夜0〜3時は前日扱い
    now.setDate(now.getDate() - 1)
  }
  return toDateStr(now)
}

/** YYYY-MM-DD に n 日加算 */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00+09:00')
  d.setDate(d.getDate() + n)
  return toDateStr(d)
}

/** UTC TIMESTAMPTZ を JST HH:MM に変換 */
export function toJstTime(utcStr) {
  const d = new Date(utcStr)
  return d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
}

// =============================================
// 状態
// =============================================
let currentDate = todayTargetDate()

// =============================================
// サマリー描画
// =============================================
async function renderSummary(dateStr) {
  const el = document.getElementById('summary-content')
  el.innerHTML = '<div class="loading">読み込み中...</div>'
  try {
    const s = await getDailySummary(dateStr)
    const balance = s.estimated_balance ?? 0
    const balanceClass = balance > 0 ? 'positive' : balance < 0 ? 'negative' : 'neutral'

    el.innerHTML = `
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">摂取</div>
          <div class="summary-value">${Math.round(s.total_intake_kcal ?? 0)}<span class="summary-unit">kcal</span></div>
        </div>
        <div class="summary-item">
          <div class="summary-label">運動消費</div>
          <div class="summary-value neutral">${Math.round(s.total_burned_kcal ?? 0)}<span class="summary-unit">kcal</span></div>
        </div>
        <div class="summary-item">
          <div class="summary-label">基礎代謝</div>
          <div class="summary-value">${s.basal_metabolism ? Math.round(s.basal_metabolism) : '—'}<span class="summary-unit">kcal</span></div>
        </div>
        <div class="summary-item">
          <div class="summary-label">推定総消費</div>
          <div class="summary-value">${Math.round(s.estimated_total_burned ?? 0)}<span class="summary-unit">kcal</span></div>
        </div>
        <div class="summary-balance">
          <span style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">推定収支</span>
          <span class="summary-value ${balanceClass}" style="font-size:22px">
            ${balance > 0 ? '+' : ''}${Math.round(balance)}<span class="summary-unit">kcal</span>
          </span>
        </div>
      </div>
      ${s.latest_weight ? `
      <div class="metrics-row" style="margin-top:12px">
        <div class="metric-item">
          <div class="metric-value">${s.latest_weight}<span style="font-size:13px;color:var(--text-muted)"> kg</span></div>
          <div class="metric-label">体重</div>
        </div>
        ${s.latest_body_fat_pct ? `
        <div class="metric-item">
          <div class="metric-value">${s.latest_body_fat_pct}<span style="font-size:13px;color:var(--text-muted)"> %</span></div>
          <div class="metric-label">体脂肪率</div>
        </div>` : ''}
      </div>` : ''}
    `
  } catch (err) {
    el.innerHTML = `<div class="error-msg">取得エラー: ${err.message}</div>`
  }
}

// =============================================
// タイムライン描画
// =============================================
async function renderTimeline(dateStr) {
  const el = document.getElementById('timeline-content')
  el.innerHTML = '<div class="loading">読み込み中...</div>'
  try {
    const events = await getDailyTimeline(dateStr)
    if (!events.length) {
      el.innerHTML = '<div class="empty-msg">この日の記録はありません</div>'
      return
    }
    el.innerHTML = `
      <div class="timeline">
        ${events.map(ev => `
          <div class="timeline-item">
            <span class="timeline-time">${toJstTime(ev.event_time)}</span>
            <span class="timeline-dot ${ev.event_type}"></span>
            <span class="timeline-text">${ev.summary}</span>
          </div>
        `).join('')}
      </div>
    `
  } catch (err) {
    el.innerHTML = `<div class="error-msg">取得エラー: ${err.message}</div>`
  }
}

// =============================================
// 日付ナビゲーション
// =============================================
function updateDateDisplay() {
  document.getElementById('date-display').textContent = formatDateJa(currentDate)
  const isToday = currentDate === todayTargetDate()
  document.getElementById('today-btn').style.opacity = isToday ? '0.4' : '1'
}

async function loadDate(dateStr) {
  currentDate = dateStr
  updateDateDisplay()
  await Promise.all([
    renderSummary(dateStr),
    renderTimeline(dateStr),
    window.refreshCharts?.(dateStr)
  ])
}

// =============================================
// 初期化
// =============================================
async function init() {
  const session = await requireAuth()
  if (!session) return

  // ログイン後: user_id / daily_log_id バックフィルをサイレント実行
  supabase.rpc('run_user_backfill').then(({ data, error }) => {
    if (error) console.warn('[backfill] error:', error.message)
    else if (Object.values(data).some(v => v > 0)) console.log('[backfill] updated:', data)
  })

  // サインアウトボタン
  document.getElementById('signout-btn').addEventListener('click', signOut)

  // 日付ナビ
  document.getElementById('prev-btn').addEventListener('click',
    () => loadDate(addDays(currentDate, -1)))
  document.getElementById('next-btn').addEventListener('click',
    () => loadDate(addDays(currentDate, 1)))
  document.getElementById('today-btn').addEventListener('click',
    () => loadDate(todayTargetDate()))

  // 初回ロード
  await loadDate(currentDate)
}

init()
