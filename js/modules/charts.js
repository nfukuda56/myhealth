import { getBodyTrend, getCalorieBalanceTrend, getNutrientTrend } from '../api.js'
import {
  computeEnvelope,
  detectChangePoints,
  computePaceStats,
  evaluatePace
} from './envelope.js'

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
const ENV_COLOR = '#4a9eff'
const CP_COLOR  = '#e05050'
const LAG_DAYS  = 3
const BIN_SIZE  = { 30: 7, 90: 14, 180: 30 }

// =============================================
// 状態
// =============================================
let chartInstance        = null
let nutritionInstance    = null
let currentMetric        = 'weight'
let currentPeriod        = 30
let currentEndDate       = null
let currentDates         = []
let currentUseFirst      = false
let currentNutritionMode = 'kcal'

// 包絡線状態（プラグインから参照）
let _envelopeVals = []
let _keyPtIdxSet  = new Set()
let _changePts    = []
let _totalDates   = 0
let _cachedStats         = null
let trendAvgInstance     = null
let nutritionAvgInstance = null

// =============================================
// 包絡線オーバーレイプラグイン
// =============================================
const overlayPlugin = {
  id: 'envelopeOverlay',
  afterDraw(chart) {
    if (!_changePts.length) return
    const ctx    = chart.ctx
    const { top, bottom } = chart.chartArea
    const xScale = chart.scales.x

    ctx.save()

    // ラグウィンドウ（変化点 + LAG_DAYS 日を薄黄塗り）
    for (const cp of _changePts) {
      const x1 = xScale.getPixelForValue(cp.idx)
      const x2 = xScale.getPixelForValue(Math.min(cp.idx + LAG_DAYS, _totalDates - 1))
      ctx.fillStyle = 'rgba(224,180,80,0.08)'
      ctx.fillRect(x1, top, x2 - x1, bottom - top)
    }

    // 変化点の垂直点線
    ctx.setLineDash([4, 3])
    ctx.lineWidth   = 1.2
    ctx.strokeStyle = 'rgba(224,80,80,0.35)'
    for (const cp of _changePts) {
      const x = xScale.getPixelForValue(cp.idx)
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke()
    }
    ctx.setLineDash([])

    // 日付ラベル
    ctx.fillStyle  = CP_COLOR
    ctx.font       = 'bold 10px "DM Mono", monospace'
    ctx.textAlign  = 'left'
    for (const cp of _changePts) {
      const x = xScale.getPixelForValue(cp.idx)
      ctx.fillText(cp.date.slice(5).replace('-', '/'), x + 3, top + 14)
    }
    ctx.restore()
  }
}

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
async function fetchData(endDate, periodDays, useFirst) {
  const startDate = subtractDays(endDate, periodDays - 1)
  const [bodyData, balanceData, nutrientData] = await Promise.all([
    getBodyTrend(startDate, endDate, useFirst),
    getCalorieBalanceTrend(startDate, endDate),
    getNutrientTrend(startDate, endDate),
  ])
  return { bodyData, balanceData, nutrientData, startDate }
}

// =============================================
// ラベル配列生成（両グラフ共通）
// =============================================
function buildLabels(endDate, periodDays) {
  const labels = [], dates = []
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
// ビン集計ユーティリティ
// =============================================
function binMetric(dates, metricByDate, balanceByDate, periodDays) {
  const size = BIN_SIZE[periodDays]
  if (!size) return null
  const binLabels = [], binValues = [], binBalance = []
  // 選択日（末尾）を起点に逆算してビン分割
  for (let i = dates.length; i > 0; i -= size) {
    const slice = dates.slice(Math.max(0, i - size), i)
    const vals = slice.map(d => metricByDate.get(d)).filter(v => v != null)
    const bals = balanceByDate ? slice.map(d => balanceByDate.get(d)).filter(v => v != null) : []
    binLabels.unshift(formatDateShort(slice[slice.length - 1]))
    binValues.unshift(vals.length ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length * 10) / 10 : null)
    binBalance.unshift(bals.length ? Math.round(bals.reduce((a,b) => a+b, 0) / bals.length) : null)
  }
  return { binLabels, binValues, binBalance }
}

function binNutrient(dates, nutDateMap, periodDays) {
  const size = BIN_SIZE[periodDays]
  if (!size) return null
  const keys = ['protein_g','fat_g','carbs_g','protein_kcal','fat_kcal','carbs_kcal']
  const binLabels = [], binRows = []
  // 選択日（末尾）を起点に逆算してビン分割
  for (let i = dates.length; i > 0; i -= size) {
    const slice = dates.slice(Math.max(0, i - size), i)
    binLabels.unshift(formatDateShort(slice[slice.length - 1]))
    const rows = slice.map(d => nutDateMap.get(d)).filter(Boolean)
    if (!rows.length) { binRows.unshift(null); continue }
    const avgRow = {}
    for (const k of keys) {
      const vals = rows.map(r => Number(r[k])).filter(v => !isNaN(v) && v > 0)
      avgRow[k] = vals.length ? Math.round(vals.reduce((a,b) => a+b, 0) / vals.length) : 0
    }
    binRows.unshift(avgRow)
  }
  return { binLabels, binRows }
}

// =============================================
// 体組成グラフ設定
// =============================================
function buildTrendConfig(labels, metricValues, balanceValues, showEnvelope) {
  const color = COLORS[currentMetric]

  const barBgColors = balanceValues.map(v => {
    if (v == null) return 'transparent'
    return v > 0 ? 'rgba(248,113,113,0.6)' : 'rgba(74,222,128,0.6)'
  })

  const datasets = [
    {
      type: 'bar', label: '収支 (kcal)',
      data: balanceValues, backgroundColor: barBgColors,
      borderWidth: 0, yAxisID: 'yRight', order: 3,
    },
    {
      type: 'line', label: METRIC_LABEL[currentMetric],
      data: metricValues,
      borderColor: color.line, backgroundColor: color.fill,
      pointBackgroundColor: color.line, pointBorderColor: 'transparent',
      pointRadius: 3, pointHoverRadius: 5,
      borderWidth: 2, fill: true, tension: 0.3, spanGaps: true,
      yAxisID: 'y', order: 1,
    },
  ]

  if (showEnvelope && _envelopeVals.length) {
    datasets.push({
      type: 'line', label: '下限包絡線',
      data: _envelopeVals,
      borderColor: ENV_COLOR, backgroundColor: 'rgba(74,158,255,0.07)',
      borderWidth: 2.2, fill: 'start', tension: 0, spanGaps: true,
      pointRadius: ctx => _keyPtIdxSet.has(ctx.dataIndex) ? 3 : 0,
      pointBackgroundColor: 'rgba(74,158,255,0.5)',
      pointBorderColor: 'transparent',
      yAxisID: 'y', order: 2,
    })
  }

  return {
    type: 'line',
    plugins: [overlayPlugin],
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        envelopeOverlay: {},
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2a2d3a', borderWidth: 1,
          titleColor: '#64748b', bodyColor: '#e2e8f0', padding: 10,
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
              if (ctx.dataset.label === '下限包絡線') return ` 包絡線: ${v} kg`
              if (ctx.dataset.yAxisID === 'yRight') return ` 収支: ${v > 0 ? '+' : ''}${v} kcal`
              if (currentMetric === 'body_fat_pct') return ` ${v} %`
              return ` ${v} kg`
            },
            labelColor: ctx => ({
              borderColor: 'transparent',
              backgroundColor:
                ctx.dataset.label === '下限包絡線' ? ENV_COLOR :
                ctx.dataset.yAxisID === 'yRight'
                  ? (ctx.parsed.y > 0 ? '#f87171' : '#4ade80')
                  : color.line
            })
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 10 }, maxTicksLimit: 8, maxRotation: 0 },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' }
        },
        y: {
          position: 'left',
          afterFit(scale) { scale.width = 58 },
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 10 }, callback: v => { const r = Math.round(v * 10) / 10; return currentMetric === 'body_fat_pct' ? r + '%' : r + 'kg' } },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' },
        },
        yRight: {
          position: 'right',
          afterFit(scale) { scale.width = 52 },
          ticks: { color: '#a78bfa', font: { family: "'DM Mono', monospace", size: 10 }, callback: v => { const r = Math.round(v); return (r > 0 ? '+' : '') + r } },
          grid: { drawOnChartArea: false }, border: { color: '#2a2d3a' },
        }
      }
    }
  }
}

// =============================================
// 栄養グラフ
// =============================================
const intakeOverlayPlugin = {
  id: 'intakeOverlay',
  afterDatasetsDraw(chart) {
    const intakeData = chart.config.options._intakeData
    if (!intakeData) return
    const { ctx, scales } = chart
    const yAxis    = scales.y
    const firstMeta = chart.getDatasetMeta(0)
    if (!firstMeta?.data?.length) return
    ctx.save()
    firstMeta.data.forEach((bar, i) => {
      const val = intakeData[i]
      if (val == null || val === 0) return
      const w       = bar.width * 0.25
      const x       = bar.x - w / 2
      const y       = yAxis.getPixelForValue(val)
      const yBottom = yAxis.getPixelForValue(0)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.fillRect(x, y, w, yBottom - y)
    })
    ctx.restore()
  }
}

function buildNutritionConfig(labels, nutrientMap) {
  const isKcal = currentNutritionMode === 'kcal'

  const proteinData = labels.map((_, i) => { const row = nutrientMap.get(i); return row ? (isKcal ? Number(row.protein_kcal) : Number(row.protein_g)) : null })
  const fatData     = labels.map((_, i) => { const row = nutrientMap.get(i); return row ? (isKcal ? Number(row.fat_kcal)     : Number(row.fat_g))     : null })
  const carbsData   = labels.map((_, i) => { const row = nutrientMap.get(i); return row ? (isKcal ? Number(row.carbs_kcal)   : Number(row.carbs_g))   : null })
  const intakeData  = isKcal ? labels.map((_, i) => { const row = nutrientMap.get(i); return row ? Number(row.intake_kcal) : null }) : null

  return {
    type: 'bar',
    plugins: isKcal ? [intakeOverlayPlugin] : [],
    data: {
      labels,
      datasets: [
        { label: 'P', data: proteinData, backgroundColor: 'rgba(96,165,250,0.75)',  borderWidth: 0, stack: 'pfc', barPercentage: 0.85, categoryPercentage: 0.8 },
        { label: 'F', data: fatData,     backgroundColor: 'rgba(251,191,36,0.75)',  borderWidth: 0, stack: 'pfc', barPercentage: 0.85, categoryPercentage: 0.8 },
        { label: 'C', data: carbsData,   backgroundColor: 'rgba(251,146,60,0.75)',  borderWidth: 0, stack: 'pfc', barPercentage: 0.85, categoryPercentage: 0.8 },
      ]
    },
    options: {
      _intakeData: intakeData,
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2a2d3a', borderWidth: 1,
          titleColor: '#64748b', bodyColor: '#e2e8f0', padding: 10,
          callbacks: {
            title: ctx => {
              const dateStr = currentDates[ctx[0]?.dataIndex]
              if (!dateStr) return ''
              const d = new Date(dateStr + 'T12:00:00+09:00')
              const days = ['日','月','火','水','木','金','土']
              return `${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`
            },
            label: ctx => {
              if (ctx.parsed.y == null || ctx.parsed.y === 0) return null
              const macroLabels = ['P','F','C']
              const i   = ctx.datasetIndex
              const v   = ctx.parsed.y
              const row = nutrientMap.get(ctx.dataIndex)
              if (isKcal) {
                let gVal = null
                if (row) { if (i===0) gVal=row.protein_g; else if (i===1) gVal=row.fat_g; else gVal=row.carbs_g }
                return ` ${macroLabels[i]}: ${v} kcal${gVal != null ? ` (${gVal}g)` : ''}`
              }
              return ` ${macroLabels[i]}: ${v} g`
            },
            labelColor: ctx => {
              const colors = ['#60a5fa','#fbbf24','#fb923c']
              return { borderColor: 'transparent', backgroundColor: colors[ctx.datasetIndex] }
            },
            afterBody: ctx => {
              const row = nutrientMap.get(ctx[0]?.dataIndex)
              if (!row) return []
              if (isKcal) {
                const pfcTotal = (Number(row.protein_kcal)||0)+(Number(row.fat_kcal)||0)+(Number(row.carbs_kcal)||0)
                return ['─────────────', ` PFC換算: ${pfcTotal} kcal`, ` 摂取合計: ${Number(row.intake_kcal)||0} kcal`]
              }
              return ['─────────────', ` 合計: ${((Number(row.protein_g)||0)+(Number(row.fat_g)||0)+(Number(row.carbs_g)||0)).toFixed(1)} g`]
            },
          }
        }
      },
      layout: { padding: { right: 52 } },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 10 }, maxTicksLimit: 8, maxRotation: 0 },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' }, stacked: true,
        },
        y: {
          stacked: true,
          afterFit(scale) { scale.width = 58 },
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 10 }, callback: v => isKcal ? Math.round(v) + ' kcal' : (Math.round(v * 10) / 10) + ' g' },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' },
        }
      }
    }
  }
}

// =============================================
// 期間平均グラフ設定
// =============================================
function buildTrendAvgConfig(binLabels, binValues, binBalance, yMin, yMax, yRMin, yRMax) {
  const color = COLORS[currentMetric]
  const barBgColors = (binBalance || []).map(v =>
    v == null ? 'transparent' : v > 0 ? 'rgba(248,113,113,0.6)' : 'rgba(74,222,128,0.6)'
  )
  return {
    type: 'line',
    data: {
      labels: binLabels,
      datasets: [
        {
          type: 'bar', label: '収支 (kcal)',
          data: binBalance || [], backgroundColor: barBgColors,
          borderWidth: 0, yAxisID: 'yRight', order: 3,
        },
        {
          type: 'line', label: METRIC_LABEL[currentMetric],
          data: binValues,
          borderColor: color.line, backgroundColor: color.fill,
          pointBackgroundColor: color.line, pointBorderColor: 'transparent',
          pointRadius: 4, pointHoverRadius: 6,
          borderWidth: 2, fill: true, tension: 0.3, spanGaps: true,
          yAxisID: 'y', order: 1,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2a2d3a', borderWidth: 1,
          titleColor: '#64748b', bodyColor: '#e2e8f0', padding: 8,
          callbacks: {
            label: ctx => {
              if (ctx.parsed.y == null) return null
              if (ctx.dataset.yAxisID === 'yRight') return ` 収支: ${ctx.parsed.y > 0 ? '+' : ''}${ctx.parsed.y} kcal`
              return currentMetric === 'body_fat_pct' ? ` ${ctx.parsed.y} %` : ` ${ctx.parsed.y} kg`
            },
            labelColor: ctx => ({ borderColor: 'transparent',
              backgroundColor: ctx.dataset.yAxisID === 'yRight'
                ? (ctx.parsed.y > 0 ? '#f87171' : '#4ade80') : color.line })
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 9 }, maxRotation: 0 },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' }
        },
        y: {
          position: 'left',
          ...(yMin != null ? { min: yMin } : {}),
          ...(yMax != null ? { max: yMax } : {}),
          afterFit(scale) { scale.width = 46 },
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 9 },
            callback: v => { const r = Math.round(v * 10) / 10; return currentMetric === 'body_fat_pct' ? r + '%' : r + 'kg' } },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' }
        },
        yRight: {
          position: 'right',
          ...(yRMin != null ? { min: yRMin } : {}),
          ...(yRMax != null ? { max: yRMax } : {}),
          afterFit(scale) { scale.width = 46 },
          ticks: { color: '#a78bfa', font: { family: "'DM Mono', monospace", size: 9 },
            callback: v => { const r = Math.round(v); return (r > 0 ? '+' : '') + r } },
          grid: { drawOnChartArea: false }, border: { color: '#2a2d3a' }
        }
      }
    }
  }
}

function buildNutritionAvgConfig(binLabels, binRows) {
  const isKcal = currentNutritionMode === 'kcal'
  const p = binRows.map(r => r ? (isKcal ? r.protein_kcal : r.protein_g) : null)
  const f = binRows.map(r => r ? (isKcal ? r.fat_kcal     : r.fat_g    ) : null)
  const c = binRows.map(r => r ? (isKcal ? r.carbs_kcal   : r.carbs_g  ) : null)
  return {
    type: 'bar',
    data: {
      labels: binLabels,
      datasets: [
        { label: 'P', data: p, backgroundColor: 'rgba(96,165,250,0.75)',  borderWidth: 0, stack: 'pfc', barPercentage: 0.85, categoryPercentage: 0.8 },
        { label: 'F', data: f, backgroundColor: 'rgba(251,191,36,0.75)',  borderWidth: 0, stack: 'pfc', barPercentage: 0.85, categoryPercentage: 0.8 },
        { label: 'C', data: c, backgroundColor: 'rgba(251,146,60,0.75)',  borderWidth: 0, stack: 'pfc', barPercentage: 0.85, categoryPercentage: 0.8 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2a2d3a', borderWidth: 1,
          titleColor: '#64748b', bodyColor: '#e2e8f0', padding: 8,
          callbacks: {
            label: ctx => {
              if (ctx.parsed.y == null || ctx.parsed.y === 0) return null
              return ` ${'PFC'[ctx.datasetIndex]}: ${ctx.parsed.y} ${isKcal ? 'kcal' : 'g'}`
            },
            labelColor: ctx => ({ borderColor: 'transparent', backgroundColor: ['#60a5fa','#fbbf24','#fb923c'][ctx.datasetIndex] }),
          }
        }
      },
      layout: { padding: { right: 46 } },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 9 }, maxRotation: 0 },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' }, stacked: true,
        },
        y: {
          stacked: true,
          afterFit(scale) { scale.width = 46 },
          ticks: { color: '#64748b', font: { family: "'DM Mono', monospace", size: 9 },
            callback: v => isKcal ? Math.round(v) : (Math.round(v * 10) / 10) + 'g' },
          grid: { color: '#1e2130' }, border: { color: '#2a2d3a' },
        }
      }
    }
  }
}

// =============================================
// インフォバー
// =============================================
function _ensureInfobar() {
  return document.getElementById('envelope-infobar')
}

function renderInfobar(canvas, stats, cps) {
  const bar = _ensureInfobar()
  if (!bar) return
  if (!stats || stats.pacePerWeek == null) { bar.innerHTML = ''; return }
  const { label, color } = evaluatePace(stats.pacePerWeek)
  const pace = stats.pacePerWeek.toFixed(2)
  const est  = stats.estimatedWeight30d != null ? `${stats.estimatedWeight30d} kg` : '—'
  const rStr = stats.r != null ? `r = ${stats.r}` : '—'
  bar.innerHTML = `
    <span style="color:var(--text-muted)">週 <strong style="color:${color}">${pace > 0 ? '+' : ''}${pace} kg</strong></span>
    <span style="color:${color};font-weight:700">${label}</span>
    <span style="color:var(--text-muted)">30日後 <strong style="color:var(--text)">${est}</strong></span>
    ${cps.length ? `<span style="color:var(--text-muted)">変化点 ${cps.length}件</span>` : ''}
  `
}

// =============================================
// ペース評価パネル
// =============================================
function _gaugeSVG(pacePerWeek, color) {
  const cx = 80, cy = 65, r = 50
  const L  = Math.PI * r
  const zones = [
    [0, 0.05, '#e07030'], [0.05, 0.25, '#c0a020'],
    [0.25, 0.50, '#2a9050'], [0.50, 0.75, '#e07030'], [0.75, 1.00, '#e05050']
  ]
  const arcD = `M ${cx-r} ${cy} A ${r} ${r} 0 0 0 ${cx+r} ${cy}`
  const zonePaths = zones.map(([f1, f2, zc]) => {
    const s = f1*L, len = (f2-f1)*L
    return `<path d="${arcD}" fill="none" stroke="${zc}" stroke-width="10" stroke-linecap="butt" stroke-dasharray="${len.toFixed(2)} ${(L-len).toFixed(2)}" stroke-dashoffset="${(-s).toFixed(2)}"/>`
  }).join('')
  let nx = cx, ny = cy - r*0.75
  if (pacePerWeek != null) {
    const frac = Math.max(0, Math.min(1, -pacePerWeek/2))
    const ang  = (1-frac)*Math.PI
    nx = cx + r*0.75*Math.cos(ang)
    ny = cy - r*0.75*Math.sin(ang)
  }
  return `<svg viewBox="0 0 160 75" xmlns="http://www.w3.org/2000/svg" style="width:100%">
  <path d="${arcD}" fill="none" stroke="#2a2d3a" stroke-width="10"/>
  ${zonePaths}
  <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="4" fill="${color}"/>
  <text x="24" y="73" fill="#64748b" font-size="9" font-family="'DM Mono',monospace">0</text>
  <text x="73" y="12" fill="#64748b" font-size="9" font-family="'DM Mono',monospace">-1</text>
  <text x="127" y="73" fill="#64748b" font-size="9" font-family="'DM Mono',monospace">-2</text>
</svg>`
}

function renderPacePanel(stats, balanceData, allDates) {
  const el = document.getElementById('pace-content')
  if (!el) return
  if (!stats || stats.pacePerWeek == null) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:12px;font-family:var(--mono)">体重タブを<br>30日以上で表示すると<br>ペース評価が出ます</div>`
    return
  }
  const { label, color } = evaluatePace(stats.pacePerWeek)
  const pace  = stats.pacePerWeek, month = stats.pacePerMonth, est = stats.estimatedWeight30d
  let avgIntake = null, avgBurned = null, avgBalance = null
  if (balanceData && allDates?.length) {
    const last14start = subtractDays(allDates[allDates.length-1], 13)
    const d14 = balanceData.filter(d => d.target_date >= last14start)
    const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null
    avgIntake  = avg(d14.filter(d=>Number(d.intake_kcal)>0).map(d=>Number(d.intake_kcal)))
    avgBurned  = avg(d14.filter(d=>Number(d.burned_kcal)>0).map(d=>Number(d.burned_kcal)))
    avgBalance = avg(d14.filter(d=>Number(d.intake_kcal)>0).map(d=>Number(d.balance)))
  }
  const fmt  = v => v!=null ? (v>0?'+':'')+v.toFixed(2) : '—'
  const fmtk = v => v!=null ? `${v} kcal` : '—'
  const fmtb = v => v!=null ? (v>0?`+${v}`:`${v}`)+' kcal' : '—'
  const bColor = avgBalance!=null ? (avgBalance<0?'#4ade80':'#f87171') : 'var(--text-muted)'
  const sign = v => v != null ? (v > 0 ? '+' : '') + v : '—'
  el.innerHTML = `
    <div style="display:flex;height:100%;min-height:0;align-items:stretch">
      <!-- 左: 平均統計（ラベル上・値下） -->
      <div style="width:34%;display:flex;flex-direction:column;justify-content:center;gap:10px;padding:8px 4px 8px 8px;min-width:0">
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">平均摂取</div>
          <div style="font-family:var(--mono);font-size:18px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden">${avgIntake??'—'}<span style="font-size:11px;color:var(--text-muted);margin-left:2px">${avgIntake!=null?'kcal':''}</span></div>
        </div>
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">運動消費</div>
          <div style="font-family:var(--mono);font-size:18px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden">${avgBurned??'—'}<span style="font-size:11px;color:var(--text-muted);margin-left:2px">${avgBurned!=null?'kcal':''}</span></div>
        </div>
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">平均収支</div>
          <div style="font-family:var(--mono);font-size:18px;font-weight:500;color:${bColor};white-space:nowrap;overflow:hidden">${sign(avgBalance)}<span style="font-size:11px;color:var(--text-muted);margin-left:2px">${avgBalance!=null?'kcal':''}</span></div>
        </div>
      </div>
      <!-- 中央: ゲージ＋ラベル -->
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;border-left:1px solid var(--border);border-right:1px solid var(--border);padding:4px 2px;gap:4px">
        ${_gaugeSVG(pace, color)}
        <div style="font-family:var(--mono);font-size:14px;font-weight:600;color:${color}">${label}</div>
      </div>
      <!-- 右: 週・月・30日後（ラベル上・値下） -->
      <div style="width:26%;display:flex;flex-direction:column;justify-content:center;gap:10px;padding:8px 8px 8px 6px;min-width:0">
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">週</div>
          <div style="font-family:var(--mono);font-size:18px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden">${fmt(pace)}<span style="font-size:11px;color:var(--text-muted);margin-left:2px">kg</span></div>
        </div>
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">月</div>
          <div style="font-family:var(--mono);font-size:18px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden">${fmt(month)}<span style="font-size:11px;color:var(--text-muted);margin-left:2px">kg</span></div>
        </div>
        <div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">30日後</div>
          <div style="font-family:var(--mono);font-size:18px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden">${est??'—'}<span style="font-size:11px;color:var(--text-muted);margin-left:2px">${est!=null?'kg':''}</span></div>
        </div>
      </div>
    </div>
  `
}

// =============================================
// グラフ描画
// =============================================
async function renderCharts(endDate) {
  console.log('[charts] renderCharts', endDate, currentPeriod, currentMetric)

  const trendCanvas     = document.getElementById('trend-chart')
  const nutritionCanvas = document.getElementById('nutrition-chart')
  if (!trendCanvas) return

  function showLoader(canvas, cls) {
    const wrapper = canvas.parentElement
    let loader = wrapper.querySelector('.' + cls)
    if (!loader) {
      loader = document.createElement('div')
      loader.className = cls
      loader.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;color:var(--text-muted)'
      wrapper.appendChild(loader)
    }
    loader.textContent = '読み込み中...'
    loader.style.display = 'flex'
    return loader
  }

  const trendLoader     = showLoader(trendCanvas, 'chart-loader')
  const nutritionLoader = nutritionCanvas ? showLoader(nutritionCanvas, 'chart-loader-n') : null

  try {
    const showEnvelope = (currentMetric === 'weight' && currentPeriod > 7)
    const useFirst     = showEnvelope ? true : currentUseFirst

    const { bodyData, balanceData, nutrientData, startDate } =
      await fetchData(endDate, currentPeriod, useFirst)

    const { labels, dates } = buildLabels(endDate, currentPeriod)
    currentDates = dates

    // ── 体組成グラフ用データ ──
    const bodyMap    = new Map(bodyData.map(d => [d.target_date, d]))
    const balanceMap = new Map(balanceData.map(d => [d.target_date, d]))
    const metricValues  = dates.map(d => { const r=bodyMap.get(d); return r?.[currentMetric]!=null ? Number(r[currentMetric]) : null })
    const balanceValues = dates.map(d => { const r=balanceMap.get(d); return r?.balance!=null ? Math.round(Number(r.balance)) : null })

    // ── 包絡線処理 ──
    _envelopeVals = []
    _keyPtIdxSet  = new Set()
    _changePts    = []
    _totalDates   = dates.length

    if (showEnvelope) {
      const validCount = metricValues.filter(v => v!=null).length
      if (validCount >= 5) {
        const env    = computeEnvelope(dates, metricValues)
        const cps    = detectChangePoints(dates, env.values)
        const balMap = new Map(balanceData.map(d => [d.target_date, d.balance!=null ? Number(d.balance) : null]))
        const stats  = computePaceStats(dates, env.values, cps, balMap)
        _envelopeVals = env.values
        _keyPtIdxSet  = new Set(env.keyPoints.map(kp => kp.idx))
        _changePts    = cps
        _cachedStats  = { stats, balanceData, allDates: dates }
        renderInfobar(trendCanvas, stats, cps)
        renderPacePanel(stats, balanceData, dates)
      } else {
        renderInfobar(trendCanvas, null, [])
      }
    } else {
      const infobar = document.getElementById('envelope-infobar')
      if (infobar) infobar.innerHTML = ''
    }

    // ── Trend グラフ ──
    if (chartInstance) { chartInstance.destroy(); chartInstance = null }
    chartInstance = new Chart(trendCanvas, buildTrendConfig(labels, metricValues, balanceValues, showEnvelope))

    // ── Nutrition グラフ ──
    const nutDateMap = new Map(nutrientData.map(d => [d.target_date, d]))
    if (nutritionCanvas) {
      const nutrientMap = new Map()
      dates.forEach((cur, i) => { const row=nutDateMap.get(cur); if(row) nutrientMap.set(i, row) })
      if (nutritionInstance) { nutritionInstance.destroy(); nutritionInstance = null }
      nutritionInstance = new Chart(nutritionCanvas, buildNutritionConfig(labels, nutrientMap))
    }

    // ── 期間平均グラフ ──
    const trendAvgWrap     = document.getElementById('trend-avg-wrap')
    const nutritionAvgWrap = document.getElementById('nutrition-avg-wrap')
    const showAvg = currentPeriod in BIN_SIZE

    if (trendAvgWrap)     trendAvgWrap.style.display     = showAvg ? '' : 'none'
    if (nutritionAvgWrap) nutritionAvgWrap.style.display = showAvg ? '' : 'none'

    if (showAvg) {
      const metricByDate  = new Map(dates.map(d => [d, bodyMap.get(d)?.[currentMetric] != null ? Number(bodyMap.get(d)[currentMetric]) : null]))
      const balanceByDate = new Map(dates.map(d => [d, balanceMap.get(d)?.balance != null ? Math.round(Number(balanceMap.get(d).balance)) : null]))
      const trendBin = binMetric(dates, metricByDate, balanceByDate, currentPeriod)
      if (trendBin) {
        const trendAvgCanvas = document.getElementById('trend-avg-chart')
        if (trendAvgCanvas) {
          const yMin  = chartInstance?.scales?.y?.min
          const yMax  = chartInstance?.scales?.y?.max
          const yRMin = chartInstance?.scales?.yRight?.min
          const yRMax = chartInstance?.scales?.yRight?.max
          if (trendAvgInstance) { trendAvgInstance.destroy(); trendAvgInstance = null }
          trendAvgInstance = new Chart(trendAvgCanvas, buildTrendAvgConfig(trendBin.binLabels, trendBin.binValues, trendBin.binBalance, yMin, yMax, yRMin, yRMax))
        }
      }
      const nutBin = binNutrient(dates, nutDateMap, currentPeriod)
      if (nutBin) {
        const nutritionAvgCanvas = document.getElementById('nutrition-avg-chart')
        if (nutritionAvgCanvas) {
          if (nutritionAvgInstance) { nutritionAvgInstance.destroy(); nutritionAvgInstance = null }
          nutritionAvgInstance = new Chart(nutritionAvgCanvas, buildNutritionAvgConfig(nutBin.binLabels, nutBin.binRows))
        }
      }
    } else {
      if (trendAvgInstance)     { trendAvgInstance.destroy();     trendAvgInstance     = null }
      if (nutritionAvgInstance) { nutritionAvgInstance.destroy(); nutritionAvgInstance = null }
    }

  } catch (err) {
    console.error('[charts] error:', err)
    if (chartInstance)     { chartInstance.destroy();     chartInstance     = null }
    if (nutritionInstance) { nutritionInstance.destroy(); nutritionInstance = null }
    trendCanvas.parentElement.innerHTML =
      `<div style="margin:16px;color:#f87171;font-size:12px">グラフ取得エラー: ${err.message}</div>`
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
  document.getElementById('nutrition-mode-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-order-tab')
    if (!btn) return
    document.querySelectorAll('#nutrition-mode-tabs .chart-order-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentNutritionMode = btn.dataset.mode
    const legend = document.getElementById('nutrition-intake-legend')
    if (legend) legend.style.display = currentNutritionMode === 'kcal' ? 'flex' : 'none'
    if (currentEndDate) renderCharts(currentEndDate)
  })

  document.getElementById('order-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.chart-order-tab')
    if (!btn) return
    document.querySelectorAll('#order-tabs .chart-order-tab').forEach(b => b.classList.remove('active'))
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
  if (_cachedStats) {
    renderPacePanel(_cachedStats.stats, _cachedStats.balanceData, _cachedStats.allDates)
  }
}

document.addEventListener('DOMContentLoaded', initTabs)
if (document.readyState !== 'loading') initTabs()
