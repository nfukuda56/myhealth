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
// ウォーターフォールBALANCEグラフ（SVG横向き）
// =============================================
function buildWaterfallSvg(intakeKcal, basalKcal, burnedKcal) {
  const intake  = Math.round(intakeKcal  ?? 0)
  const basal   = Math.round(basalKcal   ?? 0)
  const burned  = Math.round(burnedKcal  ?? 0)
  const balance = intake - basal - burned
 
  // バーの最大値（スケール基準）
  const maxVal  = Math.max(intake, basal + burned, 100)
 
  // SVGサイズ
  const W       = 100   // viewBox width (%)
  const ROW_H   = 22    // 各行の高さ
  const LABEL_W = 62    // ラベル幅 (px相当 → viewBox単位)
  const BAR_MAX = W - LABEL_W - 2  // バー最大幅
  const GAP     = 3     // 行間
 
  // 値→幅変換
  const toW = v => Math.max((Math.abs(v) / maxVal) * BAR_MAX, v === 0 ? 0 : 1)
 
  // 色定義
  const COL_INTAKE  = '#4ade80'   // 緑（摂取）
  const COL_BASAL   = '#60a5fa'   // 青（基礎代謝）
  const COL_BURNED  = '#a78bfa'   // 紫（運動消費）
  const COL_POS     = '#f87171'   // 赤（収支プラス）
  const COL_NEG     = '#4ade80'   // 緑（収支マイナス）
 
  const rows = [
    { label: '摂取',     value: intake,  color: COL_INTAKE, anchor: 0 },
    { label: '基礎代謝', value: basal,   color: COL_BASAL,  anchor: 0 },
    { label: '運動消費', value: burned,  color: COL_BURNED, anchor: 0 },
    { label: 'BALANCE',  value: balance, color: balance > 0 ? COL_POS : COL_NEG, anchor: 0 },
  ]
 
  // ウォーターフォール用のX開始位置を計算
  // 摂取: 0から開始
  // 基礎代謝: 0から開始（消費側）
  // 運動消費: 基礎代謝の右から開始（消費側）
  // BALANCE: 収支
 
  const barStart = LABEL_W + 1
  const svgH     = rows.length * ROW_H + (rows.length - 1) * GAP
 
  // バーデータ計算（ウォーターフォール：0基準・横）
  const basalW   = toW(basal)
  const burnedW  = toW(burned)
  const intakeW  = toW(intake)
  const balanceW = toW(balance)
 
  function barRect(y, x, w, color, opacity = 1) {
    return `<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${ROW_H - 4}" rx="2" fill="${color}" fill-opacity="${opacity}"/>`
  }
 
  function valueLabel(y, x, w, val, color) {
    const sign = val > 0 ? '+' : ''
    return `<text x="${(x + w + 2).toFixed(2)}" y="${y + ROW_H - 8}" fill="${color}" font-size="8" font-family="'DM Mono',monospace">${sign}${val}</text>`
  }
 
  const svgRows = rows.map((row, i) => {
    const y = i * (ROW_H + GAP)
    let barSvg = ''
    let labelSvg = `<text x="${LABEL_W - 2}" y="${y + ROW_H - 8}" text-anchor="end" fill="#64748b" font-size="8" font-family="'Noto Sans JP',sans-serif">${row.label}</text>`
 
    if (i === 0) {
      // 摂取バー（緑・0から右へ）
      barSvg = barRect(y + 2, barStart, intakeW, COL_INTAKE, 0.85)
      barSvg += valueLabel(y, barStart, intakeW, intake, COL_INTAKE)
    } else if (i === 1) {
      // 基礎代謝バー（青・0から右へ）
      barSvg = barRect(y + 2, barStart, basalW, COL_BASAL, 0.85)
      barSvg += valueLabel(y, barStart, basalW, basal, COL_BASAL)
    } else if (i === 2) {
      // 運動消費バー（紫・基礎代謝の右から連続して）
      const x = barStart + basalW
      barSvg = barRect(y + 2, x, burnedW, COL_BURNED, 0.85)
      if (burned > 0) {
        barSvg += valueLabel(y, x, burnedW, burned, COL_BURNED)
      }
    } else {
      // BALANCE バー（正＝赤、負＝緑）
      const balColor = balance > 0 ? COL_POS : COL_NEG
      barSvg = barRect(y + 2, barStart, balanceW, balColor, 0.9)
      const sign = balance > 0 ? '+' : ''
      barSvg += `<text x="${(barStart + balanceW + 2).toFixed(2)}" y="${y + ROW_H - 8}" fill="${balColor}" font-size="9" font-weight="500" font-family="'DM Mono',monospace">${sign}${balance}</text>`
    }
 
    return labelSvg + barSvg
  })
 
  // 区切り線（基礎代謝+運動消費の右端に縦線）
  const dividerX = barStart + Math.min(basalW + burnedW, BAR_MAX)
  const divLine  = `<line x1="${dividerX.toFixed(2)}" y1="0" x2="${dividerX.toFixed(2)}" y2="${svgH}" stroke="#2a2d3a" stroke-width="0.5" stroke-dasharray="2,2"/>`
 
  // 0基準線
  const zeroLine = `<line x1="${barStart}" y1="0" x2="${barStart}" y2="${svgH}" stroke="#2a2d3a" stroke-width="0.5"/>`
 
  return `<svg viewBox="0 0 ${W} ${svgH}" xmlns="http://www.w3.org/2000/svg" width="100%" style="display:block;overflow:visible">
  <defs><style>text { dominant-baseline: auto; }</style></defs>
  ${zeroLine}
  ${divLine}
  ${svgRows.join('\n  ')}
</svg>`
}
 
// =============================================
// サマリー描画
// =============================================
async function renderSummary(dateStr) {
  const el = document.getElementById('summary-content')
  el.innerHTML = '<div class="loading">読み込み中...</div>'
  try {
    const s = await getDailySummary(dateStr)
 
    // 時間比例済みの基礎代謝を使用（今日 = basal_elapsed_kcal、過去 = basal_metabolism全量）
    const isToday       = dateStr === todayTargetDate()
    const basalDisplay  = isToday
      ? (s.basal_elapsed_kcal ?? s.basal_metabolism ?? 0)
      : (s.basal_metabolism   ?? 0)
    const basalFull     = s.basal_metabolism   ?? 0
    const burnedKcal    = s.total_burned_kcal  ?? 0
    const intakeKcal    = s.total_intake_kcal  ?? 0
    const balance       = intakeKcal - Math.round(basalDisplay) - burnedKcal
    const balanceClass  = balance > 0 ? 'positive' : balance < 0 ? 'negative' : 'neutral'
 
    // 今日の基礎代謝に「進行中」ラベルを追加
    const basalLabel    = isToday && s.basal_elapsed_kcal != null ? '基礎代謝（経過分）' : '基礎代謝'
 
    el.innerHTML = `
      <!-- 上段: 基礎代謝 + 運動消費 -->
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">${basalLabel}</div>
          <div class="summary-value">${basalDisplay != null ? Math.round(basalDisplay) : '—'}<span class="summary-unit">kcal</span></div>
          ${isToday && basalFull ? `<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);margin-top:2px">全量 ${Math.round(basalFull)}</div>` : ''}
        </div>
        <div class="summary-item">
          <div class="summary-label">運動消費</div>
          <div class="summary-value neutral">${Math.round(burnedKcal)}<span class="summary-unit">kcal</span></div>
        </div>
      </div>
 
      <!-- 下段: 摂取 + 収支 -->
      <div class="summary-grid" style="margin-top:8px">
        <div class="summary-item">
          <div class="summary-label">摂取</div>
          <div class="summary-value">${Math.round(intakeKcal)}<span class="summary-unit">kcal</span></div>
        </div>
        <div class="summary-item">
          <div class="summary-label">収支</div>
          <div class="summary-value ${balanceClass}" style="font-family:var(--mono)">
            ${balance > 0 ? '+' : ''}${Math.round(balance)}<span class="summary-unit">kcal</span>
          </div>
        </div>
      </div>
 
      <!-- ウォーターフォールBALANCEグラフ -->
      <div style="margin-top:14px;padding:10px 4px 6px">
        ${buildWaterfallSvg(intakeKcal, basalDisplay, burnedKcal)}
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
// 状態
// =============================================
let currentDate = todayTargetDate()
 
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
