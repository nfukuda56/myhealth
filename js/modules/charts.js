import { getBodyTrend, getCalorieBalanceTrend, getNutrientTrend } from '../api.js'

// =============================================
// 定数
// =============================================
const COLORS = {
  weight:         { line: '#4ade80', fill: 'rgba(74,222,128,0.08)' },
  body_fat_pct:   { line: '#fbbf24', fill: 'rgba(251,191,36,0.08)' },
  fat_mass:       { line: '#f87171', fill: 'rgba(248,113,113,0.08)' },
  lean_body_mass: { line: '#60a5fa', fill: 'rgba(96,165,250,0.08)' },
}

const METRIC_LABEL = {
  weight:         '体重 (kg)',
  body_fat_pct:   '体脂肪率 (%)',
  fat_mass:       '体脂肪量 (kg)',
  lean_body_mass: '除脂肪体重 (kg)',
}

// =============================================
// 状態
// =============================================
let chartInstance     = null
let nutritionInstance = null
let currentMetric     = 'weight'
let currentPeriod     = 30
let currentEndDate    = null
let currentDates      = []   // 完全日付文字列 (YYYY-MM-DD) の配列
let currentUseFirst   = false // 最初の測定値を使うか

// =============================================
// 日付ユーティリティ
// =============================================
function subtractDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00+09:00')
  d.setDate(d.getDate() - n)
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+09:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// =============================================
// データ取得（体組成 + 収支 + 栄養素 を並行取得）
// =============================================
async function fetchData(endDate, periodDays) {
  const startDate = subtractDays(endDate, periodDays - 1)
  const [bodyData, balanceData, nutrientData] = await Promise.all([
    getBodyTrend(startDate, endDate, currentUseFirst),
    getCalorieBalanceTrend(startDate, endDate),
    getNutrientTrend(startDate, endDate),
  ])
  return { bodyData, balanceData, nutrientData }
}

// =============================================
// ラベル配列を生成（両グラフ共通）
// =============================================
function buildLabels(endDate, periodDays) {
  const labels = []
  const dates  = []
  let cur = subtractDays(endDate, periodDays - 1)
  while (cur <= endDate) {
    labels.push(formatDateShort(cur))
    dates.push(cur)
    const d = new Date(cur + 'T12:00:00+09:00')
    d.setDate(d.getDate() + 1)
    cur = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
  }
  return { labels, dates }
}

// =============================================
// 体組成グラフ設定
// =============================================
function buildTrendConfig(labels, metricValues, balanceValues) {
  const color = COLORS[currentMetric]

  const barBgColors = balanceValues.map(v => {
    if (v == null) return 'transparent'
    return v > 0 ? 'rgba(248,113,113,0.6)' : 'rgba(74,222,128,0.6)'
  })

  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: '収支 (kcal)',
          data: balanceValues,
          backgroundColor: barBgColors,
          borderWidth: 0,
          yAxisID: 'yRight',
          order: 2,
        },
        {
          type: 'line',
          label: METRIC_LABEL[currentMetric],
          data: metricValues,
          borderColor: color.line,
          backgroundColor: color.fill,
          pointBackgroundColor: color.line,
          pointBorderColor: 'transparent',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          spanGaps: true,
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
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2d3a',
          borderWidth: 1,
          titleColor: '#64748b',
          bodyColor: '#e2e8f0',
          padding: 10,
          callbacks: {
            title: ctx => {
              const idx     = ctx[0]?.dataIndex
              const dateStr = currentDates[idx]
              if (!dateStr) return ''
              const d = new Date(dateStr + 'T12:00:00+09:00')
              const days = ['日','月','火','水','木','金','土']
              return `${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`
            },
            label: ctx => {
              if (ctx.parsed.y == null) return null
              const v = ctx.parsed.y
              if (ctx.dataset.yAxisID === 'yRight') {
                return ` 収支: ${v > 0 ? '+' : ''}${v} kcal`
              }
              if (currentMetric === 'body_fat_pct') return ` ${v} %`
              return ` ${v} kg`
            },
            labelColor: ctx => ({
              borderColor: 'transparent',
              backgroundColor: ctx.dataset.yAxisID === 'yRight'
                ? (ctx.parsed.y > 0 ? '#f87171' : '#4ade80')
                : color.line
            })
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            maxTicksLimit: 8,
            maxRotation: 0,
          },
          grid: { color: '#1e2130' },
          border: { color: '#2a2d3a' }
        },
        y: {
          position: 'left',
          afterFit(scale) { scale.width = 58 },
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => currentMetric === 'body_fat_pct' ? v + '%' : v + 'kg'
          },
          grid: { color: '#1e2130' },
          border: { color: '#2a2d3a' },
        },
        yRight: {
          position: 'right',
          afterFit(scale) { scale.width = 52 },
          ticks: {
            color: '#a78bfa',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => (v > 0 ? '+' : '') + v
          },
          grid: { drawOnChartArea: false },
          border: { color: '#2a2d3a' },
        }
      }
    }
  }
}

// =============================================
// 栄養グラフ設定（PFC stacked bar、Y軸 = kcal）
// =============================================
function buildNutritionConfig(labels, nutrientMap) {
  const proteinKcal = labels.map((_, i) => {
    const row = nutrientMap.get(i)
    return row ? Number(row.protein_kcal) : null
  })
  const fatKcal = labels.map((_, i) => {
    const row = nutrientMap.get(i)
    return row ? Number(row.fat_kcal) : null
  })
  const carbsKcal = labels.map((_, i) => {
    const row = nutrientMap.get(i)
    return row ? Number(row.carbs_kcal) : null
  })

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'たんぱく質',
          data: proteinKcal,
          backgroundColor: 'rgba(96,165,250,0.75)',
          borderWidth: 0,
          stack: 'pfc',
        },
        {
          label: '脂質',
          data: fatKcal,
          backgroundColor: 'rgba(251,191,36,0.75)',
          borderWidth: 0,
          stack: 'pfc',
        },
        {
          label: '炭水化物',
          data: carbsKcal,
          backgroundColor: 'rgba(251,146,60,0.75)',
          borderWidth: 0,
          stack: 'pfc',
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2d3a',
          borderWidth: 1,
          titleColor: '#64748b',
          bodyColor: '#e2e8f0',
          padding: 10,
          callbacks: {
            title: ctx => {
              const idx     = ctx[0]?.dataIndex
              const dateStr = currentDates[idx]
              if (!dateStr) return ''
              const d = new Date(dateStr + 'T12:00:00+09:00')
              const days = ['日','月','火','水','木','金','土']
              return `${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`
            },
            label: ctx => {
              if (ctx.parsed.y == null || ctx.parsed.y === 0) return null
              const labels = ['P','F','C']
              const idx = ctx.datasetIndex
              const g = ctx.raw
              // grams for display
              const row = nutrientMap.get(ctx.dataIndex)
              let gVal = null
              if (row) {
                if (idx === 0) gVal = row.protein_g
                else if (idx === 1) gVal = row.fat_g
                else gVal = row.carbs_g
              }
              const gStr = gVal != null ? ` (${gVal}g)` : ''
              return ` ${labels[idx]}: ${g} kcal${gStr}`
            },
            labelColor: ctx => {
              const colors = ['#60a5fa','#fbbf24','#fb923c']
              return { borderColor: 'transparent', backgroundColor: colors[ctx.datasetIndex] }
            },
            afterBody: ctx => {
              const idx = ctx[0]?.dataIndex
              const row = nutrientMap.get(idx)
              if (!row) return []
              const total = (Number(row.protein_kcal) || 0) +
                            (Number(row.fat_kcal) || 0) +
                            (Number(row.carbs_kcal) || 0)
              return [`─────────────`, ` 合計: ${total} kcal`]
            }
          }
        }
      },
      layout: { padding: { right: 52 } },
      scales: {
        x: {
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            maxTicksLimit: 8,
            maxRotation: 0,
          },
          grid: { color: '#1e2130' },
          border: { color: '#2a2d3a' },
          stacked: true,
        },
        y: {
          stacked: true,
          afterFit(scale) { scale.width = 58 },
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => v + ' kcal',
          },
          grid: { color: '#1e2130' },
          border: { color: '#2a2d3a' },
        }
      }
    }
  }
}

// =============================================
// グラフ描画
// =============================================
async function renderCharts(endDate) {
  console.log('[charts] renderCharts called, endDate=', endDate)

  const trendCanvas     = document.getElementById('trend-chart')
  const nutritionCanvas = document.getElementById('nutrition-chart')
  if (!trendCanvas) { console.log('[charts] trend-chart not found'); return }

  // ローダー表示
  function showLoader(canvas) {
    const wrapper = canvas.parentElement
    let loader = wrapper.querySelector('.chart-loader')
    if (!loader) {
      loader = document.createElement('div')
      loader.className = 'chart-loader loading'
      loader.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center'
      wrapper.appendChild(loader)
    }
    loader.textContent = '読み込み中...'
    loader.style.display = 'flex'
    return loader
  }

  const trendLoader     = showLoader(trendCanvas)
  const nutritionLoader = nutritionCanvas ? showLoader(nutritionCanvas) : null

  try {
    const { bodyData, balanceData, nutrientData } = await fetchData(endDate, currentPeriod)
    const { labels, dates } = buildLabels(endDate, currentPeriod)
    currentDates = dates

    // ── 体組成グラフ用データ ──
    const bodyMap    = new Map(bodyData.map(d => [d.target_date, d]))
    const balanceMap = new Map(balanceData.map(d => [d.target_date, d]))
    const metricValues  = []
    const balanceValues = []
    dates.forEach(cur => {
      const bodyRow = bodyMap.get(cur)
      metricValues.push(
        bodyRow?.[currentMetric] != null ? Number(bodyRow[currentMetric]) : null
      )
      const balRow = balanceMap.get(cur)
      balanceValues.push(
        balRow?.balance != null ? Math.round(Number(balRow.balance)) : null
      )
    })

    if (chartInstance) { chartInstance.destroy(); chartInstance = null }
    chartInstance = new Chart(trendCanvas, buildTrendConfig(labels, metricValues, balanceValues))

    // ── 栄養グラフ用データ ──
    if (nutritionCanvas) {
      // nutrientMap: index → row
      const nutDateMap = new Map(nutrientData.map(d => [d.target_date, d]))
      const nutrientMap = new Map()
      dates.forEach((cur, i) => {
        const row = nutDateMap.get(cur)
        if (row) nutrientMap.set(i, row)
      })

      if (nutritionInstance) { nutritionInstance.destroy(); nutritionInstance = null }
      nutritionInstance = new Chart(nutritionCanvas, buildNutritionConfig(labels, nutrientMap))
    }

  } catch (err) {
    console.error('Chart error:', err)
    if (chartInstance) { chartInstance.destroy(); chartInstance = null }
    if (nutritionInstance) { nutritionInstance.destroy(); nutritionInstance = null }
    trendCanvas.parentElement.innerHTML =
      `<div style="margin:16px;color:#f87171">グラフ取得エラー: ${err.message}</div>`
    return
  } finally {
    trendLoader.style.display = 'none'
    if (nutritionLoader) nutritionLoader.style.display = 'none'
  }
}

// =============================================
// タブ切替
// =============================================
function initTabs() {
  document.getElementById('order-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-order-tab')
    if (!btn) return
    document.querySelectorAll('.chart-order-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentUseFirst = btn.dataset.first === 'true'
    if (currentEndDate) renderCharts(currentEndDate)
  })

  document.getElementById('chart-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-tab')
    if (!btn) return
    document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentMetric = btn.dataset.metric
    if (currentEndDate) renderCharts(currentEndDate)
  })

  document.getElementById('period-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-period-tab')
    if (!btn) return
    document.querySelectorAll('.chart-period-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentPeriod = Number(btn.dataset.days)
    if (currentEndDate) renderCharts(currentEndDate)
  })
}

// =============================================
// 外部インターフェース
// =============================================
window.refreshCharts = async (dateStr) => {
  currentEndDate = dateStr
  await renderCharts(dateStr)
}

document.addEventListener('DOMContentLoaded', initTabs)
if (document.readyState !== 'loading') initTabs()
