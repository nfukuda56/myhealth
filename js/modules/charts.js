import { getBodyTrend, getCalorieBalanceTrend } from '../api.js'

// =============================================
// 定数
// =============================================
const COLORS = {
  weight:         { line: '#4ade80', fill: 'rgba(74,222,128,0.08)' },
  body_fat_pct:   { line: '#fbbf24', fill: 'rgba(251,191,36,0.08)' },
  fat_mass:       { line: '#f87171', fill: 'rgba(248,113,113,0.08)' },
  lean_body_mass: { line: '#60a5fa', fill: 'rgba(96,165,250,0.08)' },
  balance:        { line: '#a78bfa', fill: 'rgba(167,139,250,0.08)' },
}

const METRIC_LABEL = {
  weight:         '体重 (kg)',
  body_fat_pct:   '体脂肪率 (%)',
  fat_mass:       '体脂肪量 (kg)',
  lean_body_mass: '除脂肪体重 (kg)',
  balance:        'カロリー収支 (kcal)',
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
// データ取得
// =============================================
async function fetchData(endDate, periodDays) {
  const startDate = subtractDays(endDate, periodDays - 1)
  if (currentMetric === 'balance') {
    return await getCalorieBalanceTrend(startDate, endDate)
  } else {
    return await getBodyTrend(startDate, endDate)
  }
}

function extractValues(data) {
  if (currentMetric === 'balance') {
    return data.map(d => ({
      x: d.target_date,
      y: d.balance != null ? Math.round(Number(d.balance)) : null
    }))
  }
  return data.map(d => ({
    x: d.target_date,
    y: d[currentMetric] != null ? Number(d[currentMetric]) : null
  }))
}

// =============================================
// Chart.js 共通設定
// =============================================
function buildChartConfig(labels, values) {
  const color = COLORS[currentMetric]
  const isBalance = currentMetric === 'balance'

  // 収支グラフ: 正負で色分け
  const pointColors = isBalance
    ? values.map(v => v == null ? 'transparent' : v > 0 ? '#f87171' : '#4ade80')
    : color.line

  return {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: METRIC_LABEL[currentMetric],
        data: values,
        borderColor: isBalance ? '#a78bfa' : color.line,
        backgroundColor: color.fill,
        pointBackgroundColor: pointColors,
        pointBorderColor: 'transparent',
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        spanGaps: true,   // データ欠損日はスキップして線を継続
      }]
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
              if (ctx.parsed.y == null) return '— データなし'
              const v = ctx.parsed.y
              if (currentMetric === 'balance') {
                return ` ${v > 0 ? '+' : ''}${v} kcal`
              }
              if (currentMetric === 'body_fat_pct') return ` ${v} %`
              return ` ${v} kg`
            },
            labelColor: ctx => ({
              borderColor: 'transparent',
              backgroundColor: isBalance
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
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => {
              if (currentMetric === 'balance') return (v > 0 ? '+' : '') + v
              if (currentMetric === 'body_fat_pct') return v + '%'
              return v + 'kg'
            }
          },
          grid: { color: '#1e2130' },
          border: { color: '#2a2d3a' },
          // 収支グラフは0ラインを強調
          ...(isBalance ? {
            afterDataLimits(scale) {
              const abs = Math.max(Math.abs(scale.min), Math.abs(scale.max))
              scale.min = -abs
              scale.max = abs
            }
          } : {})
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

  // ローディング表示
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
    const data = await fetchData(endDate, currentPeriod)

    // 期間内の全日付ラベルを生成（データのない日はnull）
    const dateMap = new Map(data.map(d => [d.target_date, d]))
    const labels = []
    const values = []
    const start = subtractDays(endDate, currentPeriod - 1)

    let cur = start
    while (cur <= endDate) {
      labels.push(formatDateShort(cur))
      const row = dateMap.get(cur)
      if (row) {
        if (currentMetric === 'balance') {
          values.push(row.balance != null ? Math.round(Number(row.balance)) : null)
        } else {
          values.push(row[currentMetric] != null ? Number(row[currentMetric]) : null)
        }
      } else {
        values.push(null)
      }
      // 翌日へ
      const d = new Date(cur + 'T12:00:00+09:00')
      d.setDate(d.getDate() + 1)
      cur = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
    }

    // 既存チャートを破棄
    if (chartInstance) {
      chartInstance.destroy()
      chartInstance = null
    }

    const cfg = buildChartConfig(labels, values)
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
  // メトリクスタブ
  document.getElementById('chart-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-tab')
    if (!btn) return
    document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentMetric = btn.dataset.metric
    if (currentEndDate) renderChart(currentEndDate)
  })

  // 期間タブ
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

// DOM 準備後にタブを初期化
document.addEventListener('DOMContentLoaded', initTabs)
// DOMContentLoaded が既に発火済みの場合も考慮
if (document.readyState !== 'loading') initTabs()
