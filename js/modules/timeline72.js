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
/**
 * target_date の終端（翌日 AM4:00 JST）を windowEnd とし
 * そこから 72h 遡った windowStart を返す
 */
function getWindow(targetDate) {
  const hh = String(DAY_BOUNDARY_HOUR).padStart(2, '0')
  // target_date + 1 day
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
  return Array.from({ length: NUM_SLOTS }, (_, i) => {
    const slotStart = new Date(windowStart.getTime() + i * SLOT_HOURS * 3600 * 1000)
    return { slotStart }
  })
}

/**
 * スロットラベル。日付境界（DAY_BOUNDARY_HOUR or 0h）は "M/D HH:00"、他は "HH:00"
 */
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
// 系列構築
// =============================================
function buildSeries(slots, meals, exercises, basalPerDay) {
  const originMs = slots[0].slotStart.getTime()
  const slotMs   = SLOT_HOURS * 3600 * 1000

  const intakeBars  = new Array(NUM_SLOTS).fill(0)
  const workoutBars = new Array(NUM_SLOTS).fill(0)

  for (const m of meals) {
    if (!m.calories_kcal) continue
    const idx = Math.floor((new Date(m.measured_at).getTime() - originMs) / slotMs)
    if (idx >= 0 && idx < NUM_SLOTS) intakeBars[idx] += Number(m.calories_kcal)
  }
  for (const e of exercises) {
    if (!e.burned_kcal) continue
    const idx = Math.floor((new Date(e.measured_at).getTime() - originMs) / slotMs)
    if (idx >= 0 && idx < NUM_SLOTS) workoutBars[idx] += Number(e.burned_kcal)
  }

  const basalPerSlot = basalPerDay / (24 / SLOT_HOURS)
  let cumIntake = 0, cumEx = 0
  const intakeLine = [], consumptionLine = [], basalLine = []

  for (let i = 0; i < NUM_SLOTS; i++) {
    cumIntake += intakeBars[i]
    cumEx     += workoutBars[i]
    const cumBasal = basalPerSlot * (i + 1)
    intakeLine.push(Math.round(cumIntake))
    consumptionLine.push(Math.round(cumBasal + cumEx))
    basalLine.push(Math.round(cumBasal))
  }

  return {
    intakeBars:  intakeBars.map(v  => v  > 0 ? Math.round(v)  : null),
    workoutBars: workoutBars.map(v => v  > 0 ? Math.round(v)  : null),
    intakeLine, consumptionLine, basalLine, basalPerDay
  }
}

// =============================================
// Chart.js 設定
// =============================================
function buildConfig(labels, series) {
  const { intakeBars, workoutBars, intakeLine, consumptionLine, basalLine, basalPerDay } = series

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        // ── 棒グラフ（右軸・2h 単位）──
        {
          type: 'bar', label: '摂取 (2h)',
          data: intakeBars,
          backgroundColor: 'rgba(74,222,128,0.22)',
          borderColor:     'rgba(74,222,128,0.50)',
          borderWidth: 1,
          yAxisID: 'yR', order: 4,
          barPercentage: 0.40, categoryPercentage: 0.55,
        },
        {
          type: 'bar', label: '運動消費 (2h)',
          data: workoutBars,
          backgroundColor: 'rgba(251,146,60,0.22)',
          borderColor:     'rgba(251,146,60,0.50)',
          borderWidth: 1,
          yAxisID: 'yR', order: 4,
          barPercentage: 0.40, categoryPercentage: 0.55,
        },
        // ── 折れ線（左軸・累積）──
        {
          type: 'line', label: '摂取累積',
          data: intakeLine,
          borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.07)',
          fill: true, tension: 0.35,
          pointRadius: 0, pointHoverRadius: 4,
          borderWidth: 2, yAxisID: 'y', order: 1,
        },
        {
          type: 'line', label: '推定総消費累積',
          data: consumptionLine,
          borderColor: '#f87171', backgroundColor: 'transparent',
          fill: false, tension: 0.35,
          pointRadius: 0, pointHoverRadius: 4,
          borderWidth: 2, yAxisID: 'y', order: 1,
        },
        {
          type: 'line', label: '基礎代謝（累積）',
          data: basalLine,
          borderColor: '#a78bfa', backgroundColor: 'transparent',
          fill: false, tension: 0,
          pointRadius: 0, pointHoverRadius: 3,
          borderWidth: 1.5, borderDash: [5, 4],
          yAxisID: 'y', order: 2,
          hidden: basalPerDay === 0,
        },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2a2d3a', borderWidth: 1,
          titleColor: '#94a3b8', bodyColor: '#e2e8f0', padding: 10,
          callbacks: {
            label: ctx => {
              if (ctx.parsed.y == null) return null
              return ` ${ctx.dataset.label}: ${Math.round(ctx.parsed.y)} kcal`
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 9 },
            maxRotation: 45, minRotation: 0,
            autoSkip: false,
            // 6時間ごと（3スロットごと）にラベル表示
            callback: (_, idx) => idx % 3 === 0 ? labels[idx] : ''
          },
          grid: {
            color: ctx => labels[ctx.index]?.includes('/') ? '#2d3255' : '#1e2130'
          },
          border: { color: '#2a2d3a' }
        },
        y: {
          position: 'left',
          title: { display: true, text: '累積 kcal', color: '#475569', font: { size: 9, family: "'DM Mono', monospace" } },
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => v.toLocaleString()
          },
          grid: { color: '#1e2130' },
          border: { color: '#2a2d3a' }
        },
        yR: {
          position: 'right',
          title: { display: true, text: '2h kcal', color: '#475569', font: { size: 9, family: "'DM Mono', monospace" } },
          ticks: {
            color: '#94a3b8',
            font: { family: "'DM Mono', monospace", size: 9 },
            callback: v => v.toLocaleString()
          },
          grid: { drawOnChartArea: false },
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
