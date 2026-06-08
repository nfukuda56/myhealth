import { requireAuth, signOut } from './auth.js'
import { getDailySummary, getDailyTimeline } from './api.js'
import { DAY_BOUNDARY_HOUR } from './config.js'
import { supabase } from './supabase.js'

// =============================================
// 日付ユーティリティ
// =============================================

export function toDateStr(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

export function formatDateJa(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+09:00')
  const days = ['日','月','火','水','木','金','土']
  return `${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`
}

export function todayTargetDate() {
  const now = new Date()
  const jstHour = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).getHours()
  if (jstHour < DAY_BOUNDARY_HOUR) {
    now.setDate(now.getDate() - 1)
  }
  return toDateStr(now)
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00+09:00')
  d.setDate(d.getDate() + n)
  return toDateStr(d)
}

export function toJstTime(utcStr) {
  const d = new Date(utcStr)
  return d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
}

// =============================================
// ウォーターフォール BALANCE グラフ（SVG 横向き）
//
// レイアウト:
//   摂取     [━━━━━━━━━━━━━━━━] 1850 kcal
//            ←基礎代謝━━━━━━━━ -1549
//            ←運動消費━━━━      - 250
//   BALANCE                ■   -  51 kcal  (負=緑/正=赤)
//
// 摂取バーの右端を「0点」として、
// 基礎代謝・運動消費を左方向へ積み上げ、
// 残った端点が収支（BALANCE）を示す。
// =============================================
function buildWaterfallSvg(intakeKcal, basalKcal, burnedKcal) {
  const intake  = Math.round(intakeKcal ?? 0)
  const basal   = Math.round(basalKcal  ?? 0)
  const burned  = Math.round(burnedKcal ?? 0)
  const balance = intake - basal - burned   // 負=黒字、正=赤字

  // --- レイアウト定数 (viewBox 単位) ---
  const VW       = 260   // viewBox 幅
  const ROW_H    = 18    // 1行の高さ
  const BAR_H    = 12    // バー高さ
  const GAP      = 5     // 行間
  const LABEL_W  = 56    // 左ラベル幅
  const VAL_W    = 46    // 右数値幅
  const BAR_AREA = VW - LABEL_W - VAL_W  // バー描画幅

  // スケール: 摂取が BAR_AREA の 75% を占めるよう基準設定
  // ただし basal+burned が intake を超える場合は全体に合わせる
  const scaleBase = Math.max(intake, basal + burned, 1)
  const scale     = (BAR_AREA * 0.85) / scaleBase  // px/kcal

  const intakeW  = Math.max(intake  * scale, 1)
  const basalW   = Math.max(basal   * scale, 1)
  const burnedW  = burned > 0 ? Math.max(burned * scale, 1) : 0
  const balanceW = Math.abs(balance) * scale

  // 摂取バー右端 = BAR基点（ここから左に消費を積む）
  const barOrigin = LABEL_W + intakeW

  // 色
  const C = {
    intake:  '#4ade80',   // 緑
    basal:   '#60a5fa',   // 青
    burned:  '#a78bfa',   // 紫
    surplus: '#f87171',   // 赤（収支プラス＝食い過ぎ）
    deficit: '#4ade80',   // 緑（収支マイナス＝黒字）
    label:   '#94a3b8',
    value:   '#e2e8f0',
    muted:   '#64748b',
  }

  const rows = [
    { key: 'intake' },
    { key: 'basal'  },
    { key: 'burned' },
    { key: 'balance'},
  ]
  const totalH = rows.length * ROW_H + (rows.length - 1) * GAP

  // ヘルパー
  const ty    = (i) => i * (ROW_H + GAP)                         // 行のY座標
  const barY  = (i) => ty(i) + (ROW_H - BAR_H) / 2              // バーのY座標
  const midY  = (i) => ty(i) + ROW_H / 2                         // テキスト中央Y

  // 各行SVG
  function rowLabel(i, text, color = C.label) {
    return `<text x="${LABEL_W - 4}" y="${midY(i)}" text-anchor="end" fill="${color}" font-size="9" font-family="'Noto Sans JP',sans-serif" dominant-baseline="middle">${text}</text>`
  }
  function rowValue(i, val, color = C.value) {
    const sign = val > 0 ? '+' : val < 0 ? '' : ''
    return `<text x="${VW - 2}" y="${midY(i)}" text-anchor="end" fill="${color}" font-size="9" font-family="'DM Mono',monospace" dominant-baseline="middle">${sign}${val.toLocaleString()}</text>`
  }
  function rect(x, y, w, h, fill, opacity = 1, rx = 2) {
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(w,0).toFixed(1)}" height="${h}" rx="${rx}" fill="${fill}" fill-opacity="${opacity}"/>`
  }

  // ---- 行0: 摂取 ----
  const r0 = rowLabel(0, '摂取', C.intake)
    + rect(LABEL_W, barY(0), intakeW, BAR_H, C.intake, 0.8)
    + rowValue(0, intake, C.intake)

  // ---- 行1: 基礎代謝（摂取右端から左へ） ----
  const basalX = barOrigin - basalW
  const r1 = rowLabel(1, '基礎代謝', C.basal)
    + rect(basalX, barY(1), basalW, BAR_H, C.basal, 0.8)
    + rowValue(1, -basal, C.basal)

  // ---- 行2: 運動消費（基礎代謝の左端からさらに左へ） ----
  const burnedX = basalX - burnedW
  const r2 = rowLabel(2, '運動消費', burned > 0 ? C.burned : C.muted)
    + (burned > 0
      ? rect(burnedX, barY(2), burnedW, BAR_H, C.burned, 0.8)
      : `<text x="${LABEL_W + 2}" y="${midY(2)}" fill="${C.muted}" font-size="8" dominant-baseline="middle">—</text>`)
    + rowValue(2, -burned, burned > 0 ? C.burned : C.muted)

  // ---- 行3: BALANCE（収支点を示す縦線＋値） ----
  // 収支点 X = barOrigin - basalW - burnedW = burnedX
  const balanceX = burnedX
  const balColor = balance > 0 ? C.surplus : C.deficit
  // 収支バー：balanceXから右（余剰）または左（黒字）方向へ
  const balBarX = balance >= 0 ? balanceX : balanceX - balanceW
  const r3 = rowLabel(3, 'BALANCE', balColor)
    + (balanceW > 0.5
        ? rect(balBarX, barY(3), balanceW, BAR_H, balColor, 0.9)
        : `<line x1="${balanceX.toFixed(1)}" y1="${barY(3)}" x2="${balanceX.toFixed(1)}" y2="${(barY(3)+BAR_H).toFixed(1)}" stroke="${balColor}" stroke-width="1.5"/>`)
    + rowValue(3, balance, balColor)

  // ---- ガイドライン ----
  // 摂取右端（0点）の縦破線
  const guideLine = `<line x1="${barOrigin.toFixed(1)}" y1="0" x2="${barOrigin.toFixed(1)}" y2="${totalH}" stroke="#2a2d3a" stroke-width="0.8" stroke-dasharray="3,2"/>`
  // 収支点の縦線
  const balLine   = `<line x1="${balanceX.toFixed(1)}" y1="${barY(3)}" x2="${balanceX.toFixed(1)}" y2="${(barY(3)+BAR_H).toFixed(1)}" stroke="${balColor}" stroke-width="2"/>`

  return `<svg viewBox="0 0 ${VW} ${totalH}" xmlns="http://www.w3.org/2000/svg" width="100%" style="display:block;overflow:visible;margin-top:4px">
  ${guideLine}
  ${r0}
  ${r1}
  ${r2}
  ${r3}
  ${balLine}
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

    // 今日は basal_elapsed_kcal（時間比例済み）、過去日は basal_metabolism（全量）
    const isToday      = dateStr === todayTargetDate()
    const basalDisplay = isToday
      ? (s.basal_elapsed_kcal ?? s.basal_metabolism ?? 0)
      : (s.basal_metabolism   ?? 0)
    const basalFull    = s.basal_metabolism  ?? 0
    const burned       = s.total_burned_kcal ?? 0
    const intake       = s.total_intake_kcal ?? 0
    const balance      = intake - Math.round(basalDisplay) - burned
    const balClass     = balance > 0 ? 'positive' : balance < 0 ? 'negative' : 'neutral'
    const basalLabel   = isToday && s.basal_elapsed_kcal != null ? '基礎代謝（経過分）' : '基礎代謝'

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
          <div class="summary-value neutral">${Math.round(burned)}<span class="summary-unit">kcal</span></div>
        </div>
      </div>

      <!-- 下段: 摂取 + 収支 -->
      <div class="summary-grid" style="margin-top:8px">
        <div class="summary-item">
          <div class="summary-label">摂取</div>
          <div class="summary-value">${Math.round(intake)}<span class="summary-unit">kcal</span></div>
        </div>
        <div class="summary-item">
          <div class="summary-label">収支</div>
          <div class="summary-value ${balClass}" style="font-family:var(--mono)">
            ${balance > 0 ? '+' : ''}${Math.round(balance)}<span class="summary-unit">kcal</span>
          </div>
        </div>
      </div>

      <!-- ウォーターフォール BALANCE グラフ -->
      <div style="margin-top:14px;padding:2px 0 6px">
        ${buildWaterfallSvg(intake, basalDisplay, burned)}
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

  supabase.rpc('run_user_backfill').then(({ data, error }) => {
    if (error) console.warn('[backfill] error:', error.message)
    else if (Object.values(data).some(v => v > 0)) console.log('[backfill] updated:', data)
  })

  document.getElementById('signout-btn').addEventListener('click', signOut)

  document.getElementById('prev-btn').addEventListener('click',
    () => loadDate(addDays(currentDate, -1)))
  document.getElementById('next-btn').addEventListener('click',
    () => loadDate(addDays(currentDate, 1)))
  document.getElementById('today-btn').addEventListener('click',
    () => loadDate(todayTargetDate()))

  await loadDate(currentDate)
}

init()
