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
// 設計:
//   全バーの「左端（X=BAR_LEFT）」を共通0点として固定。
//   摂取バーが0→右へ伸びる。
//   基礎代謝は摂取バーの「左端(0)」から右へ積む（摂取の中に収まる）。
//   運動消費は基礎代謝の右端から続けて右へ積む。
//   BALANCE点は基礎代謝+運動消費の右端。
//   収支が正（余剰）なら右端がさらに摂取の内側にある→残量バー。
//   収支が負（黒字）なら基礎+運動が摂取を超える→はみ出しバー。
//
//  例: 摂取1850 基礎1549 運動250 収支+51
//  0                                         →
//  [━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━]  摂取 1850
//  [━━━━━━━━━━━━━━━━━━━━━━━━][━━━━━━]|  基礎1549 + 運動250 | BALANCE点
//                                      ↑収支点（摂取右端の手前 = +51kcal余り）
// =============================================
function buildWaterfallSvg(intakeKcal, basalKcal, burnedKcal) {
  const intake  = Math.round(intakeKcal ?? 0)
  const basal   = Math.round(basalKcal  ?? 0)
  const burned  = Math.round(burnedKcal ?? 0)
  const balance = intake - basal - burned  // 正=余剰(赤字), 負=黒字

  // --- レイアウト定数 ---
  const VW       = 260
  const ROW_H    = 18
  const BAR_H    = 12
  const GAP      = 5
  const LABEL_W  = 56   // 左ラベル幅
  const VAL_W    = 46   // 右数値幅
  const BAR_LEFT = LABEL_W          // バー描画開始X（共通0点）
  const BAR_MAX  = VW - LABEL_W - VAL_W  // バー最大幅 = 158

  // スケール: 摂取か（基礎+運動）の大きい方をBAR_MAX*0.9に収める
  const scaleBase = Math.max(intake, basal + burned, 1)
  const scale     = (BAR_MAX * 0.90) / scaleBase

  // 各バー幅（0点から右へ）
  const intakeW  = intake              * scale
  const basalW   = basal               * scale
  const burnedW  = burned              * scale
  const totalConsumedW = basalW + burnedW  // 基礎+運動の合計幅
  const balanceW = Math.abs(balance)   * scale

  // 各バーのX座標（すべて BAR_LEFT=0点から右へ）
  const intakeEndX  = BAR_LEFT + intakeW        // 摂取の右端
  const basalEndX   = BAR_LEFT + basalW         // 基礎代謝の右端
  const burnedEndX  = BAR_LEFT + totalConsumedW // 運動消費の右端 = BALANCE点
  const balanceX    = burnedEndX                // BALANCE基点

  const totalH = 4 * ROW_H + 3 * GAP

  const C = {
    intake:  '#4ade80',
    basal:   '#60a5fa',
    burned:  '#a78bfa',
    surplus: '#f87171',  // 正=余剰=赤
    deficit: '#34d399',  // 負=黒字=緑（摂取<消費）
    label:   '#94a3b8',
    value:   '#e2e8f0',
    muted:   '#64748b',
  }

  const ty   = (i) => i * (ROW_H + GAP)
  const barY = (i) => ty(i) + (ROW_H - BAR_H) / 2
  const midY = (i) => ty(i) + ROW_H / 2

  function label(i, text, color = C.label) {
    return `<text x="${BAR_LEFT - 4}" y="${midY(i)}" text-anchor="end" fill="${color}" font-size="9" font-family="'Noto Sans JP',sans-serif" dominant-baseline="middle">${text}</text>`
  }
  function value(i, val, color = C.value) {
    const sign = val > 0 ? '+' : ''
    return `<text x="${VW - 2}" y="${midY(i)}" text-anchor="end" fill="${color}" font-size="9" font-family="'DM Mono',monospace" dominant-baseline="middle">${sign}${val.toLocaleString()}</text>`
  }
  function bar(x, i, w, fill, opacity = 0.85, rx = 2) {
    return `<rect x="${x.toFixed(1)}" y="${barY(i).toFixed(1)}" width="${Math.max(w, 0).toFixed(1)}" height="${BAR_H}" rx="${rx}" fill="${fill}" fill-opacity="${opacity}"/>`
  }
  function vline(x, y1, y2, color, sw = 1.5, dash = '') {
    return `<line x1="${x.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  }

  // ---- 行0: 摂取（0→右へ） ----
  const r0 = label(0, '摂取', C.intake)
    + bar(BAR_LEFT, 0, intakeW, C.intake)
    + value(0, intake, C.intake)

  // ---- 行1: 基礎代謝（0→basalEndX） ----
  const r1 = label(1, '基礎代謝', C.basal)
    + bar(BAR_LEFT, 1, basalW, C.basal)
    + value(1, -basal, C.basal)

  // ---- 行2: 運動消費（basalEndX→burnedEndX、基礎の続き） ----
  const r2 = label(2, '運動消費', burned > 0 ? C.burned : C.muted)
    + (burned > 0
        ? bar(basalEndX, 2, burnedW, C.burned)
        : `<text x="${BAR_LEFT + 2}" y="${midY(2)}" fill="${C.muted}" font-size="8" dominant-baseline="middle">—</text>`)
    + value(2, -burned, burned > 0 ? C.burned : C.muted)

  // ---- 行3: BALANCE ----
  // balance>0: 摂取の中に余り（balanceX〜intakeEndX の間）
  // balance<0: 消費が摂取を超えた（intakeEndX〜balanceX の間）
  const balColor = balance >= 0 ? C.surplus : C.deficit
  const balBarX  = balance >= 0 ? balanceX : intakeEndX
  const balBarW  = balanceW

  const r3 = label(3, 'BALANCE', balColor)
    + (balBarW > 0.5
        ? bar(balBarX, 3, balBarW, balColor, 0.9)
        : vline(balanceX, barY(3), barY(3) + BAR_H, balColor, 2))
    + value(3, balance, balColor)

  // ---- ガイドライン ----
  // 摂取右端（基点0の対応点）縦破線
  const guideIntake = vline(intakeEndX, 0, totalH, '#334155', 0.8, '3,2')
  // BALANCE点縦線（強調）
  const guideBalance = vline(balanceX, barY(3), barY(3) + BAR_H, balColor, 2.5)

  return `<svg viewBox="0 0 ${VW} ${totalH}" xmlns="http://www.w3.org/2000/svg" width="100%" style="display:block;overflow:visible;margin-top:4px">
  ${guideIntake}
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
    window.refreshCharts?.(dateStr)
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
