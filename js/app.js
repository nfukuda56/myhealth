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
// 設計: 右端(BAR_RIGHT)を固定基点として全バーを左方向へ伸ばす
//
//  例: 摂取1850 基礎1549 運動250 収支+51
//                               ←基点(右端)
//  摂取:    |←━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━|  +1850
//  基礎代謝:|        ←━━━━━━━━━━━━━━━━━━━━━━━━|  -1549
//  運動消費:| ←━━━━━━                           |  - 250
//  BALANCE: |←                                  |  +  51
// =============================================
function buildWaterfallSvg(intakeKcal, basalKcal, burnedKcal) {
  const intake  = Math.round(intakeKcal ?? 0)
  const basal   = Math.round(basalKcal  ?? 0)
  const burned  = Math.round(burnedKcal ?? 0)
  const balance = intake - basal - burned  // 正=余剰, 負=黒字

  const VW        = 260
  const ROW_H     = 18
  const BAR_H     = 12
  const GAP       = 5
  const LABEL_W   = 56
  const VAL_W     = 46
  const BAR_RIGHT = VW - VAL_W   // = 214  固定基点（全バーの右端）
  const BAR_MAX   = VW - LABEL_W - VAL_W  // = 158

  const scaleBase = Math.max(intake, basal + burned, 1)
  const scale     = (BAR_MAX * 0.90) / scaleBase

  const intakeW  = intake  * scale
  const basalW   = basal   * scale
  const burnedW  = burned  * scale
  const balanceW = Math.abs(balance) * scale

  // 各バーの左端X（右端固定 − 幅 = 左端）
  const intakeX  = BAR_RIGHT - intakeW          // 摂取バー左端
  const basalX   = BAR_RIGHT - basalW           // 基礎代謝バー左端
  const burnedX  = basalX    - burnedW          // 運動消費バー左端（基礎左端からさらに左）
  // BALANCEバー座標
  // 余剰(+): burnedX(消費合計左端) 〜 intakeX(摂取左端)  → x=burnedX, w=intakeX-burnedX
  // 黒字(-): burnedX(消費合計左端) 〜 intakeX(摂取左端)  → 同じ。burnedXがintakeXより左
  // どちらも x=burnedX, w=|intakeX-burnedX| で統一
  const balBarX  = Math.min(burnedX, intakeX)

  const totalH = 4 * ROW_H + 3 * GAP

  const C = {
    intake:  '#4ade80',
    basal:   '#60a5fa',
    burned:  '#a78bfa',
    surplus: '#f87171',
    deficit: '#34d399',
    label:   '#94a3b8',
    value:   '#e2e8f0',
    muted:   '#64748b',
  }

  const ty   = (i) => i * (ROW_H + GAP)
  const barY = (i) => ty(i) + (ROW_H - BAR_H) / 2
  const midY = (i) => ty(i) + ROW_H / 2

  function lbl(i, text, color = C.label) {
    return `<text x="${LABEL_W - 4}" y="${midY(i)}" text-anchor="end" fill="${color}" font-size="9" font-family="'Noto Sans JP',sans-serif" dominant-baseline="middle">${text}</text>`
  }
  function val(i, v, color = C.value) {
    const sign = v > 0 ? '+' : ''
    return `<text x="${VW - 2}" y="${midY(i)}" text-anchor="end" fill="${color}" font-size="9" font-family="'DM Mono',monospace" dominant-baseline="middle">${sign}${v.toLocaleString()}</text>`
  }
  function bar(x, i, w, fill, opacity = 0.85) {
    return `<rect x="${x.toFixed(1)}" y="${barY(i).toFixed(1)}" width="${Math.max(w, 0).toFixed(1)}" height="${BAR_H}" rx="2" fill="${fill}" fill-opacity="${opacity}"/>`
  }
  function vline(x, y1, y2, color, sw = 1.5, dash = '') {
    return `<line x1="${x.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  }

  // ---- 行0: 摂取（右端←左へ intakeW） ----
  const r0 = lbl(0, '摂取', C.intake)
    + bar(intakeX, 0, intakeW, C.intake)
    + val(0, intake, C.intake)

  // ---- 行1: 基礎代謝（右端←左へ basalW） ----
  const r1 = lbl(1, '基礎代謝', C.basal)
    + bar(basalX, 1, basalW, C.basal)
    + val(1, -basal, C.basal)

  // ---- 行2: 運動消費（基礎左端←左へ burnedW） ----
  const r2 = lbl(2, '運動消費', burned > 0 ? C.burned : C.muted)
    + (burned > 0
        ? bar(burnedX, 2, burnedW, C.burned)
        : `<text x="${BAR_RIGHT - 4}" y="${midY(2)}" text-anchor="end" fill="${C.muted}" font-size="8" dominant-baseline="middle">—</text>`)
    + val(2, -burned, burned > 0 ? C.burned : C.muted)

  // ---- 行3: BALANCE ----
  const balColor  = balance >= 0 ? C.surplus : C.deficit
  const balActualW = Math.abs(intakeX - burnedX)  // 摂取左端〜消費合計左端の実距離
  const r3 = lbl(3, 'BALANCE', balColor)
    + (balActualW > 0.5
        ? bar(balBarX, 3, balActualW, balColor, 0.9)
        : vline(burnedX, barY(3), barY(3) + BAR_H, balColor, 2))
    + val(3, balance, balColor)

  // ---- ガイドライン ----
  // 摂取左端（0基点）縦破線：全行に渡って表示
  const guideZero    = vline(intakeX, 0, totalH, '#334155', 0.8, '3,2')
  // 収支点縦線（BALANCE行のみ強調）
  const guideBalance = vline(burnedX, barY(3), barY(3) + BAR_H, balColor, 2.5)

  return `<svg viewBox="0 0 ${VW} ${totalH}" xmlns="http://www.w3.org/2000/svg" width="100%" style="display:block;overflow:visible;margin-top:4px">
  ${guideZero}
  ${r0}
  ${r1}
  ${r2}
  ${r3}
  ${guideBalance}
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
    window.refreshCharts?.(dateStr),
    window.refreshTimeline72?.(dateStr)
  ])
}

let currentDate = todayTargetDate()

async function init() {
  const session = await requireAuth()
  if (!session) return

  supabase.rpc('run_user_backfill').then(({ data, error }) => {
    if (error) console.warn('[backfill] error:', error.message)
    else if (Object.values(data).some(v => v > 0)) console.log('[backfill] updated:', data)
  })

  document.getElementById('signout-btn').addEventListener('click', signOut)
  document.getElementById('prev-btn').addEventListener('click', () => loadDate(addDays(currentDate, -1)))
  document.getElementById('next-btn').addEventListener('click', () => loadDate(addDays(currentDate, 1)))
  document.getElementById('today-btn').addEventListener('click', () => loadDate(todayTargetDate()))

  await loadDate(currentDate)
}

init()
