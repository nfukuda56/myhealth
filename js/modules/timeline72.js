import { supabase } from '../supabase.js'
import { DAY_BOUNDARY_HOUR } from '../config.js'

// =============================================
// 定数
// =============================================
const SLOT_HOURS   = 2
const WINDOW_HOURS = 72
const NUM_SLOTS    = WINDOW_HOURS / SLOT_HOURS  // 36

let chartInstance = null

// =============================================
// ウィンドウ計算
// =============================================
function getWindow(targetDate) {
  const hh = String(DAY_BOUNDARY_HOUR).padStart(2, '0')
  const d = new Date(targetDate + 'T12:00:00+09:00')
  d.setDate(d.getDate() + 1)
  const nextDate = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
  const windowEnd   = new Date(`${nextDate}T${hh}:00:00+09:00`)
  const windowStart = new Date(windowEnd.getTime() - WINDOW_HOURS * 3600 * 1000)
  return { windowStart, windowEnd }
}

// =============================================
// スロット生成
// =============================================
function buildSlots(windowStart) {
  return Array.from({ length: NUM_SLOTS }, (_, i) => ({
    slotStart: new Date(windowStart.getTime() + i * SLOT_HOURS * 3600 * 1000)
  }))
}

function slotLabel(slotStart) {
  const jst = new Date(slotStart.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  const h   = jst.getHours()
  const hh  = String(h).padStart(2, '0')
  if (h === DAY_BOUNDARY_HOUR || h === 0) {
    return `${jst.getMonth() + 1}/${jst.getDate()} ${hh}:00`
  }
  return `${hh}:00`
}

// =============================================
// データ取得
// =============================================
async function fetchData(windowStart, windowEnd) {
  const from = windowStart.toISOString()
  const to   = windowEnd.toISOString()

  const [mealsRes, exRes, configRes] = await Promise.all([
    supabase.from('meals')
      .select('measured_at,calories_kcal')
      .gte('measured_at', from)
      .lt('measured_at', to),
    supabase.from('exercises')
      .select('measured_at,burned_kcal')
      .gte('measured_at', from)
      .lt('measured_at', to),
    supabase.from('config')
      .select('default_basal_metabolism_kcal')
      .maybeSingle()
  ])

  if (mealsRes.error) throw mealsRes.error
  if (exRes.error)    throw exRes.error

  return {
    meals:       mealsRes.data ?? [],
    exercises:   exRes.data   ?? [],
    basalPerDay: Number(configRes.data?.default_basal_metabolism_kcal ?? 0)
  }
}

// =============================================
// 系列構築（収支のみ）
// =============================================
function buildSeries(slots, meals, exercises, basalPerDay) {
  const originMs   = slots[0].slotStart.getTime()
  const slotMs     = SLOT_HOURS * 3600 * 1000
  const basalPerSlot = basalPerDay / (24 / SLOT_HOURS)

  // スロットごとの摂取・運動消費を集計
  const intakeArr  = new Array(NUM_SLOTS).fill(0)
  const workoutArr = new Array(NUM_SLOTS).fill(0)

  for (const m of meals) {
    if (!m.calories_kcal) continue
    const idx = Math.floor((new Date(m.measured_at).getTime() - originMs) / slotMs)
    if (idx >= 0 && idx < NUM_SLOTS) intakeArr[idx] += Number(m.calories_kcal)
  }
  for (const e of exercises) {
    if (!e.burned_kcal) continue
    const idx = Math.floor((new Date(e.measured_at).getTime() - originMs) / slotMs)
    if (idx >= 0 && idx < NUM_SLOTS) workoutArr[idx] += Number(e.burned_kcal)
  }

  // 収支（摂取 − 基礎代謝 − 運動消費）
  let cumBalance = 0
  const balanceBars = []   // 2h 単位収支
  const balanceLine = []   // 累積収支

  for (let i = 0; i < NUM_SLOTS; i++) {
    const slotBalance = intakeArr[i] - basalPerSlot - workoutArr[i]
    cumBalance += slotBalance
    balanceBars.push(Math.round(slotBalance))
    balanceLine.push(Math.round(cumBalance))
  }

  return { balanceBars, balanceLine }
}

// =============================================
// Chart.js 設定
// =============================================
function buildConfig(labels, series) {
  const { balanceBars, balanceLine } = series

  // 棒グラフの色：プラス（過剰）=赤、マイナス（不足）=緑
  const barColors = balanceBars.map(v =>
    v >= 0 ? 'rgba(248,113,113,0.45)' : 'rgba(74,222,128,0.45)'
  )
  const barBorderColors = balanceBars.map(v =>
    v >= 0 ? 'rgba(248,113,113,0.80)' : 'rgba(74,222,128,0.80)'
  )

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        // ── 2h 単位収支 棒グラフ（背景）──
        {
          type: 'bar',
          label: '収支 (2h)',
          data: balanceBars,
          backgroundColor: barColors,
          borderColor:     barBorderColors,
          borderWidth: 1,
          yAxisID: 'y',
          order: 2,
          barPercentage: 0.55,
          categoryPercentage: 0.65,
        },
        // ── 累積収支 折れ線（前景）──
        {
          type: 'line',
          label: '累積収支',
          data: balanceLine,
          borderColor: '#e2e8f0',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          borderWidth: 2.5,
          yAxisID: 'y',
          order: 1,
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: false,
          position: 'top',
          labels: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            boxWidth: 10,
            padding: 10,
          }
        },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2d3a',
          borderWidth: 1,
          titleColor: '#94a3b8',
          bodyColor: '#e2e8f0',
          padding: 10,
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y
              if (v == null) return null
              const sign = v > 0 ? '+' : ''
              return ` ${ctx.dataset.label}: ${sign}${Math.round(v)} kcal`
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 9 },
            maxRotation: 45,
            minRotation: 0,
            autoSkip: false,
            callback: (_, idx) => idx % 3 === 0 ? labels[idx] : ''
          },
          grid: {
            color: ctx => labels[ctx.index]?.includes('/') ? '#2d3255' : '#1e2130'
          },
          border: { color: '#2a2d3a' }
        },
        y: {
          position: 'left',
          title: {
            display: true,
            text: '収支 kcal',
            color: '#475569',
            font: { size: 10, family: "'DM Mono', monospace" }
          },
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => (v > 0 ? '+' : '') + v.toLocaleString()
          },
          grid: {
            color: ctx => ctx.tick.value === 0 ? '#4a5280' : '#1e2130'
          },
          border: { color: '#2a2d3a' }
        }
      }
    }
  }
}

// =============================================
// 外部インターフェース
// =============================================
export async function renderTimeline72(targetDate) {
  const canvas = document.getElementById('timeline72-chart')
  if (!canvas) return

  const wrapper = canvas.parentElement
  let loader = wrapper.querySelector('.tl72-loader')
  if (!loader) {
    loader = document.createElement('div')
    loader.className = 'tl72-loader'
    loader.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:#64748b'
    wrapper.appendChild(loader)
  }
  loader.textContent = '読み込み中...'
  loader.style.display = 'flex'

  try {
    const { windowStart, windowEnd } = getWindow(targetDate)
    const slots  = buildSlots(windowStart)
    const labels = slots.map(s => slotLabel(s.slotStart))
    const { meals, exercises, basalPerDay } = await fetchData(windowStart, windowEnd)
    const series = buildSeries(slots, meals, exercises, basalPerDay)

    if (chartInstance) { chartInstance.destroy(); chartInstance = null }
    chartInstance = new Chart(canvas, buildConfig(labels, series))
  } catch (err) {
    console.error('[timeline72] error:', err)
  } finally {
    if (loader) loader.style.display = 'none'
  }
}

window.refreshTimeline72 = renderTimeline72
