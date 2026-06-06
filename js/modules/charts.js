import { getBodyTrend, getCalorieBalanceTrend } from '../api.js'

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
let chartInstance = null
let currentMetric = 'weight'
let currentPeriod = 30
let currentEndDate = null

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
// データ取得（体組成 + 収支 を並行取得）
// =============================================
async function fetchData(endDate, periodDays) {
  const startDate = subtractDays(endDate, periodDays - 1)
  const [bodyData, balanceData] = await Promise.all([
    getBodyTrend(startDate, endDate),
    getCalorieBalanceTrend(startDate, endDate),
  ])
  return { bodyData, balanceData }
}

// =============================================
// Chart.js 設定（混合: 折れ線 + 棒グラフ）
// =============================================
function buildChartConfig(labels, metricValues, balanceValues) {
  const color = COLORS[currentMetric]

  // 収支バーの色: 正 = 赤(カロリー余剰)、負 = 緑(カロリー不足)
  const barColors = balanceValues.map(v =>
    v == null ? 'transparent' : v > 0 ? 'rgba(248,113,113,0.65)' : 'rgba(74,222,128,0.65)'
  )
  const barBorderColors = balanceValues.map(v =>
    v == null ? 'transparent' : v > 0 ? '#f87171' : '#4ade80'
  )

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        // 収支バー（奥に描画されるよう order を大きく）
        {
          type: 'bar',
          label: 'カロリー収支 (kcal)',
          data: balanceValues,
          backgroundColor: barColors,
          borderColor: barBorderColors,
          borderWidth: 1,
          yAxisID: 'y2',
          order: 2,
        },
        // 体組成指標ライン（手前）
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
          yAxisID: 'y1',
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
              const dateStr = ctx[0]?.label
              if (!dateStr) return ''
              const d = new Date(dateStr + 'T12:00:00+09:00')
              const days = ['日','月','火','水','木','金','土']
              return `${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`
            },
            label: ctx => {
              if (ctx.parsed.y == null) return null
              const v = ctx.parsed.y
              if (ctx.dataset.yAxisID === 'y2') {
                return ` 収支: ${v > 0 ? '+' : ''}${v} kcal`
              }
              if (currentMetric === 'body_fat_pct') return ` ${v} %`
              return ` ${v} kg`
            },
            labelColor: ctx => ({
              borderColor: 'transparent',
              backgroundColor: ctx.dataset.yAxisID === 'y2'
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
        // 左軸: 体組成指標
        y1: {
          position: 'left',
          ticks: {
            color: color.line,
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => {
              if (currentMetric === 'body_fat_pct') return v + '%'
              return v + 'kg'
            }
          },
          grid: { color: '#1e2130' },
          border: { color: '#2a2d3a' },
        },
        // 右軸: カロリー収支（0を中心に対称）
        y2: {
          position: 'right',
          ticks: {
            color: '#a78bfa',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => (v > 0 ? '+' : '') + v
          },
          grid: { drawOnChartArea: false },
          border: { color: '#2a2d3a' },
          afterDataLimits(scale) {
            const abs = Math.max(Math.abs(scale.min), Math.abs(scale.max), 1)
            scale.min = -abs
            scale.max = abs
          }
        }
      }
    }
  }
}

// =============================================
// グラフ描画
// =============================================
async function renderChart(endDate) {
  const canvas = document.getElementById('trend-chart')
  if (!canvas) return

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

  try {
    const { bodyData, balanceData } = await fetchData(endDate, currentPeriod)

    const bodyMap    = new Map(bodyData.map(d => [d.target_date, d]))
    const balanceMap = new Map(balanceData.map(d => [d.target_date, d]))
    const labels        = []
    const metricValues  = []
    const balanceValues = []
    const start = subtractDays(endDate, currentPeriod - 1)

    let cur = start
    while (cur <= endDate) {
      labels.push(formatDateShort(cur))

      const bodyRow = bodyMap.get(cur)
      metricValues.push(
        bodyRow && bodyRow[currentMetric] != null ? Number(bodyRow[currentMetric]) : null
      )

      const balRow = balanceMap.get(cur)
      balanceValues.push(
        balRow && balRow.balance != null ? Math.round(Number(balRow.balance)) : null
      )

      const d = new Date(cur + 'T12:00:00+09:00')
      d.setDate(d.getDate() + 1)
      cur = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
    }

    if (chartInstance) {
      chartInstance.destroy()
      chartInstance = null
    }

    const cfg = buildChartConfig(labels, metricValues, balanceValues)
    chartInstance = new Chart(canvas, cfg)

  } catch (err) {
    console.error('Chart error:', err)
    if (chartInstance) { chartInstance.destroy(); chartInstance = null }
    canvas.parentElement.innerHTML =
      `<div class="error-msg" style="margin:16px">グラフ取得エラー: ${err.message}</div>`
    return
  } finally {
    loader.style.display = 'none'
  }
}

// =============================================
// タブ切替
// =============================================
function initTabs() {
  document.getElementById('chart-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-tab')
    if (!btn) return
    document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentMetric = btn.dataset.metric
    if (currentEndDate) renderChart(currentEndDate)
  })

  document.getElementById('period-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-period-tab')
    if (!btn) return
    document.querySelectorAll('.chart-period-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentPeriod = Number(btn.dataset.days)
    if (currentEndDate) renderChart(currentEndDate)
  })
}

// =============================================
// 外部インターフェース
// app.js から window.refreshCharts(dateStr) で呼び出す
// =============================================
window.refreshCharts = async (dateStr) => {
  currentEndDate = dateStr
  await renderChart(dateStr)
}

document.addEventListener('DOMContentLoaded', initTabs)
if (document.readyState !== 'load