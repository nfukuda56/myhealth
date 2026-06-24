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

// =============================================
// 状態
// =============================================
let chartInstance      = null
let nutritionChartInstance = null
let currentMetric  = 'weight'
let currentPeriod  = 30
let currentEndDate = null
let _dragInitialized = false

// 包絡線・変化点（プラグインから参照）
let _envelopeVals  = []   // number|null[], aligned with chart labels
let _keyPtIdxSet   = new Set()
let _changePts     = []   // {date, idx, deltaSlope}[]
let _totalDates    = 0    // 選択期間のデータ点数

// ペースパネル用キャッシュ（最後に計算したもの）
let _cachedStats   = null

// =============================================
// Chart.js オーバーレイプラグイン
// =============================================
const overlayPlugin = {
  id: 'envelopeOverlay',
  afterDraw(chart) {
    if (!_changePts.length) return
    const ctx = chart.ctx
    const { top, bottom } = chart.chartArea
    const xScale = chart.scales.x

    ctx.save()

    // ラグウィンドウ（変化点の後 LAG_DAYS 日を薄黄で塗る）
    for (const cp of _changePts) {
      const x1 = xScale.getPixelForValue(cp.idx)
      const x2 = xScale.getPixelForValue(Math.min(cp.idx + LAG_DAYS, _totalDates - 1))
      ctx.fillStyle = 'rgba(224,180,80,0.08)'
      ctx.fillRect(x1, top, x2 - x1, bottom - top)
    }

    // 変化点の垂直点線 + 日付ラベル
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1.2
    ctx.strokeStyle = `rgba(${parseInt(CP_COLOR.slice(1,3),16)},${parseInt(CP_COLOR.slice(3,5),16)},${parseInt(CP_COLOR.slice(5,7),16)},0.35)`
    for (const cp of _changePts) {
      const x = xScale.getPixelForValue(cp.idx)
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, bottom)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // 日付テキスト
    ctx.fillStyle = CP_COLOR
    ctx.font = 'bold 10px "DM Mono", monospace'
    ctx.textAlign = 'left'
    for (const cp of _changePts) {
      const x = xScale.getPixelForValue(cp.idx)
      const label = cp.date.slice(5).replace('-', '/')
      ctx.fillText(label, x + 3, top + 14)
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

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00+09:00')
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
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
  const [bodyData, balanceData] = await Promise.all([
    getBodyTrend(startDate, endDate, true),   // p_use_first=true → 朝体重
    getCalorieBalanceTrend(startDate, endDate),
  ])
  return { bodyData, balanceData, startDate }
}

// =============================================
// Chart.js 設定ビルダー（Trend）
// =============================================
function buildChartConfig(labels, metricValues, balanceValues, showEnvelope) {
  const color = COLORS[currentMetric]

  const barBgColors = balanceValues.map(v => {
    if (v == null) return 'transparent'
    return v > 0 ? 'rgba(248,113,113,0.6)' : 'rgba(74,222,128,0.6)'
  })

  const datasets = [
    // 収支棒グラフ（背景）
    {
      type: 'bar',
      label: '収支 (kcal)',
      data: balanceValues,
      backgroundColor: barBgColors,
      borderWidth: 0,
      yAxisID: 'yRight',
      order: 3,
    },
    // 体組成折れ線（前景）
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

  // 包絡線データセット（体重タブ & 30日以上選択時のみ）
  if (showEnvelope && _envelopeVals.length > 0) {
    datasets.push({
      type: 'line',
      label: '下限包絡線',
      data: _envelopeVals,
      borderColor: ENV_COLOR,
      backgroundColor: 'rgba(74,158,255,0.07)',
      borderWidth: 2.2,
      fill: 'start',
      tension: 0,
      spanGaps: true,
      pointRadius: ctx => _keyPtIdxSet.has(ctx.dataIndex) ? 3 : 0,
      pointBackgroundColor: 'rgba(74,158,255,0.5)',
      pointBorderColor: 'transparent',
      yAxisID: 'y',
      order: 2,
    })
  }

  return {
    type: 'line',
    plugins: [overlayPlugin],
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        envelopeOverlay: {},
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
              const [m, d] = dateStr.split('/')
              const dt = new Date(`2025-${m.padStart(2,'0')}-${d.padStart(2,'0')}T12:00:00+09:00`)
              // approximate: parse from the actual date data
              const days = ['日','月','火','水','木','金','土']
              return `${m}月${d}日(${days[dt.getDay()]})`
            },
            label: ctx => {
              if (ctx.parsed.y == null) return null
              const v = ctx.parsed.y
              if (ctx.dataset.label === '下限包絡線') return ` 包絡線: ${v} kg`
              if (ctx.dataset.yAxisID === 'yRight')
                return ` 収支: ${v > 0 ? '+' : ''}${v} kcal`
              if (currentMetric === 'body_fat_pct') return ` ${v} %`
              return ` ${v} kg`
            },
            labelColor: ctx => ({
              borderColor: 'transparent',
              backgroundColor:
                ctx.dataset.label === '下限包絡線' ? ENV_COLOR :
                ctx.dataset.yAxisID === 'yRight'
                  ? (ctx.parsed.y > 0 ? '#f87171' : '#4ade80')
                  : COLORS[currentMetric].line
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
          grid:   { color: '#1e2130' },
          border: { color: '#2a2d3a' }
        },
        y: {
          position: 'left',
          ticks: {
            color: '#64748b',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => currentMetric === 'body_fat_pct' ? v + '%' : v + 'kg'
          },
          grid:   { color: '#1e2130' },
          border: { color: '#2a2d3a' },
        },
        yRight: {
          position: 'right',
          ticks: {
            color: '#a78bfa',
            font: { family: "'DM Mono', monospace", size: 10 },
            callback: v => (v > 0 ? '+' : '') + v
          },
          grid:   { drawOnChartArea: false },
          border: { color: '#2a2d3a' },
        }
      }
    }
  }
}

// =============================================
// インフォバー描画（グラフ下部）
// =============================================
function _ensureInfobar(canvas) {
  const wrap = canvas.closest('.card')
  if (!wrap) return null
  let bar = wrap.querySelector('#envelope-infobar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'envelope-infobar'
    bar.style.cssText = [
      'padding:8px 14px',
      'font-family:var(--mono)',
      'font-size:11px',
      'color:var(--text-muted)',
      'border-top:1px solid var(--border)',
      'display:flex',
      'gap:18px',
      'flex-wrap:wrap',
      'align-items:center',
      'min-height:32px',
    ].join(';')
    wrap.appendChild(bar)
  }
  return bar
}

function renderInfobar(canvas, stats, changePts) {
  const bar = _ensureInfobar(canvas)
  if (!bar) return

  if (!stats || stats.pacePerWeek == null) {
    bar.innerHTML = '<span style="color:var(--text-muted)">包絡線データ不足</span>'
    return
  }

  const { label, color } = evaluatePace(stats.pacePerWeek)
  const pace  = stats.pacePerWeek.toFixed(2)
  const est   = stats.estimatedWeight30d != null ? `${stats.estimatedWeight30d} kg` : '—'
  const rStr  = stats.r != null ? `r = ${stats.r}` : '相関データ不足'
  const cpNum = changePts.length

  bar.innerHTML = `
    <span>週ペース <strong style="color:${color}">${pace > 0 ? '+' : ''}${pace} kg</strong></span>
    <span style="color:${color};font-weight:600">${label}</span>
    <span>30日後推定 <strong style="color:var(--text)">${est}</strong></span>
    <span style="color:var(--text-muted)">${rStr}</span>
    ${cpNum > 0 ? `<span>変化点 ${cpNum}件</span>` : ''}
  `
}

function clearInfobar(canvas) {
  const bar = _ensureInfobar(canvas)
  if (bar) bar.innerHTML = ''
}

// =============================================
// ペース評価パネル描画
// =============================================
function _gaugeSVG(pacePerWeek, color) {
  // Semi-circle gauge: left(30,65)=0 kg/wk, right(130,65)=-2 kg/wk, top(80,15)=-1 kg/wk
  const cx = 80, cy = 65, r = 50
  const L  = Math.PI * r  // arc length ≈ 157.08

  // Zone definitions [fraction_start, fraction_end, color]
  const zones = [
    [0,    0.05, '#e07030'],  // 停滞気味 (>-0.1)
    [0.05, 0.25, '#c0a020'],  // やや緩め (-0.1~-0.5)
    [0.25, 0.50, '#2a9050'],  // 適正     (-0.5~-1.0)
    [0.50, 0.75, '#e07030'],  // やや速め (-1.0~-1.5)
    [0.75, 1.00, '#e05050'],  // 過速     (<-1.5)
  ]

  // Full semi-circle path (upper arc, CCW in SVG)
  const arcD = `M ${cx-r} ${cy} A ${r} ${r} 0 0 0 ${cx+r} ${cy}`

  const zonePaths = zones.map(([f1, f2, zc]) => {
    const s   = f1 * L
    const len = (f2 - f1) * L
    return `<path d="${arcD}" fill="none" stroke="${zc}" stroke-width="10"
      stroke-linecap="butt"
      stroke-dasharray="${len.toFixed(2)} ${(L - len).toFixed(2)}"
      stroke-dashoffset="${(-s).toFixed(2)}"/>`
  }).join('\n    ')

  // Needle
  let nx = cx, ny = cy - r * 0.75  // default: straight up (-1 kg/wk)
  if (pacePerWeek != null) {
    const frac   = Math.max(0, Math.min(1, -pacePerWeek / 2))
    const angRad = (1 - frac) * Math.PI  // 180° at f=0, 0° at f=1
    nx = cx + r * 0.75 * Math.cos(angRad)
    ny = cy - r * 0.75 * Math.sin(angRad)
  }

  return `<svg viewBox="0 0 160 75" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:160px">
  <!-- Background ring -->
  <path d="${arcD}" fill="none" stroke="#2a2d3a" stroke-width="10"/>
  <!-- Zone arcs -->
  ${zonePaths}
  <!-- Needle -->
  <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"
    stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="4" fill="${color}"/>
  <!-- Scale labels -->
  <text x="24" y="73" fill="#64748b" font-size="9" font-family="'DM Mono',monospace">0</text>
  <text x="73" y="12" fill="#64748b" font-size="9" font-family="'DM Mono',monospace">-1</text>
  <text x="127" y="73" fill="#64748b" font-size="9" font-family="'DM Mono',monospace">-2</text>
</svg>`
}

function renderPacePanel(stats, balanceData, allDates) {
  const el = document.getElementById('pace-content')
  if (!el) return

  if (!stats || stats.pacePerWeek == null) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:12px">
      30日以上の期間を選択すると<br>ペース評価が表示されます
    </div>`
    return
  }

  const { label, color } = evaluatePace(stats.pacePerWeek)
  const pace  = stats.pacePerWeek
  const month = stats.pacePerMonth
  const est   = stats.estimatedWeight30d

  // 直近14日の平均（balanceDataから）
  let avgIntake = null, avgBurned = null, avgBalance = null
  if (balanceData && allDates && allDates.length > 0) {
    const last14start = subtractDays(allDates[allDates.length - 1], 13)
    const d14 = balanceData.filter(d => d.target_date >= last14start)
    const intakeVals  = d14.filter(d => Number(d.intake_kcal) > 0).map(d => Number(d.intake_kcal))
    const burnedVals  = d14.filter(d => Number(d.burned_kcal) > 0).map(d => Number(d.burned_kcal))
    const balVals     = d14.filter(d => Number(d.intake_kcal) > 0).map(d => Number(d.balance))
    const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null
    avgIntake  = avg(intakeVals)
    avgBurned  = avg(burnedVals)
    avgBalance = avg(balVals)
  }

  const fmt  = v => v != null ? (v > 0 ? '+' : '') + v.toFixed(2) : '—'
  const fmtk = v => v != null ? `${v} kcal` : '—'
  const fmtb = v => v != null ? (v > 0 ? `+${v}` : `${v}`) + ' kcal' : '—'

  const bColor = avgBalance != null ? (avgBalance < 0 ? '#4ade80' : '#f87171') : 'var(--text-muted)'
  el.innerHTML = `
    <div style="display:flex;height:100%;min-height:0">
      <!-- 左: ゲージエリア -->
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px 4px;gap:3px">
        ${_gaugeSVG(pace, color)}
        <div style="font-family:var(--mono);font-size:12px;font-weight:600;color:${color}">${label}</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--text-muted);text-align:center">
          週 <span style="color:var(--text)">${fmt(pace)} kg</span><br>
          月 <span style="color:var(--text)">${fmt(month)} kg</span>
        </div>
        ${est != null ? `<div style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">30日後 <span style="color:var(--text)">${est} kg</span></div>` : ''}
      </div>
      <!-- 右: 統計テキスト -->
      <div style="width:44%;border-left:1px solid var(--border);display:flex;flex-direction:column;justify-content:center;gap:10px;padding:10px 10px;font-family:var(--mono);font-size:10px;color:var(--text-muted)">
        <div>平均摂取<br><span style="color:var(--text);font-size:12px">${fmtk(avgIntake)}</span></div>
        <div>運動消費<br><span style="color:var(--text);font-size:12px">${fmtk(avgBurned)}</span></div>
        <div>平均収支<br><span style="color:${bColor};font-size:12px">${fmtb(avgBalance)}</span></div>
      </div>
    </div>
  `
}

// =============================================
// Nutritionグラフ描画
// =============================================
async function renderNutritionChart(endDate) {
  const canvas = document.getElementById('nutrition-chart')
  if (!canvas) return

  const wrap = canvas.parentElement
  let loader = wrap.querySelector('.chart-loader')
  if (!loader) {
    loader = document.createElement('div')
    loader.className = 'chart-loader'
    loader.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;color:var(--text-muted)'
    wrap.appendChild(loader)
  }
  loader.textContent = '読み込み中...'
  loader.style.display = 'flex'

  try {
    const startDate = subtractDays(endDate, currentPeriod - 1)
    const nutrientData = await getNutrientTrend(startDate, endDate)
    const nutrientMap = new Map(nutrientData.map(d => [d.target_date, d]))

    const labels      = []
    const proteinVals = []
    const fatVals     = []
    const carbsVals   = []

    let cur = startDate
    while (cur <= endDate) {
      labels.push(formatDateShort(cur))
      const row = nutrientMap.get(cur)
      if (row && Number(row.intake_kcal) > 0) {
        proteinVals.push(Number(row.protein_kcal))
        fatVals.push(Number(row.fat_kcal))
        carbsVals.push(Number(row.carbs_kcal))
      } else {
        proteinVals.push(null)
        fatVals.push(null)
        carbsVals.push(null)
      }
      const d = new Date(cur + 'T12:00:00+09:00')
      d.setDate(d.getDate() + 1)
      cur = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
    }

    if (nutritionChartInstance) { nutritionChartInstance.destroy(); nutritionChartInstance = null }

    nutritionChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'タンパク質',
            data: proteinVals,
            backgroundColor: 'rgba(96,165,250,0.85)',
            stack: 'pfc',
            borderWidth: 0,
          },
          {
            label: '脂質',
            data: fatVals,
            backgroundColor: 'rgba(251,191,36,0.85)',
            stack: 'pfc',
            borderWidth: 0,
          },
          {
            label: '炭水化物',
            data: carbsVals,
            backgroundColor: 'rgba(251,146,60,0.85)',
            stack: 'pfc',
            borderWidth: 0,
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
                const lbl = ctx[0]?.label
                if (!lbl) return ''
                const [m, d] = lbl.split('/')
                return `${m}月${d}日`
              },
              label: ctx => {
                if (ctx.parsed.y == null) return null
                return ` ${ctx.dataset.label}: ${ctx.parsed.y} kcal`
              },
              footer: items => {
                const total = items.reduce((s, i) => s + (i.parsed.y ?? 0), 0)
                return `合計: ${Math.round(total)} kcal`
              }
            }
          }
        },
        scales: {
          x: {
            stacked: true,
            ticks: {
              color: '#64748b',
              font: { family: "'DM Mono', monospace", size: 10 },
              maxTicksLimit: 8,
              maxRotation: 0,
            },
            grid:   { color: '#1e2130' },
            border: { color: '#2a2d3a' }
          },
          y: {
            stacked: true,
            ticks: {
              color: '#64748b',
              font: { family: "'DM Mono', monospace", size: 10 },
              callback: v => v + ''
            },
            grid:   { color: '#1e2130' },
            border: { color: '#2a2d3a' },
          }
        }
      }
    })

  } catch (err) {
    console.error('[nutrition] error:', err)
    if (nutritionChartInstance) { nutritionChartInstance.destroy(); nutritionChartInstance = null }
  } finally {
    loader.style.display = 'none'
  }
}

// =============================================
// 両グラフ同時再描画
// =============================================
async function renderBothCharts(endDate) {
  await Promise.all([
    renderChart(endDate),
    renderNutritionChart(endDate),
  ])
  if (_cachedStats) {
    renderPacePanel(_cachedStats.stats, _cachedStats.balanceData, _cachedStats.allDates)
  }
}

// =============================================
// ドラッグ操作（日付移動）
// =============================================
function addDragBehavior(canvas) {
  let dragStartX = null
  let isDragging = false
  const DRAG_THRESHOLD = 8  // px

  function getClientX(e) {
    return e.touches ? e.touches[0].clientX : e.clientX
  }

  function getPxPerDay() {
    // chartAreaが取れるなら使う、なければcanvas幅で近似
    if (chartInstance?.chartArea) {
      return chartInstance.chartArea.width / Math.max(currentPeriod - 1, 1)
    }
    return canvas.offsetWidth / Math.max(currentPeriod, 1)
  }

  function onStart(e) {
    dragStartX = getClientX(e)
    isDragging = false
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onEnd)
  }

  function onMove(e) {
    if (dragStartX === null) return
    const dx = getClientX(e) - dragStartX
    if (!isDragging && Math.abs(dx) > DRAG_THRESHOLD) {
      isDragging = true
    }
    if (isDragging) {
      canvas.style.cursor = 'grabbing'
    }
  }

  function onEnd(e) {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup',   onEnd)
    if (dragStartX === null) return

    const endClientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX
    const dx = endClientX - dragStartX
    dragStartX = null
    canvas.style.cursor = 'grab'

    if (!isDragging) return
    isDragging = false

    // 左ドラッグ(dx<0) → 過去へ / 右ドラッグ(dx>0) → 未来へ
    const pxPerDay   = getPxPerDay()
    const deltaDays  = Math.round(dx / pxPerDay)
    if (deltaDays === 0) return

    const today      = todayJST()
    let newEnd       = addDays(currentEndDate, deltaDays)
    if (newEnd > today) newEnd = today
    if (newEnd === currentEndDate) return

    currentEndDate = newEnd
    renderBothCharts(newEnd)
  }

  // タッチ
  canvas.addEventListener('touchstart', onStart, { passive: true })
  canvas.addEventListener('touchmove',  e => {
    if (dragStartX !== null) {
      const dx = e.touches[0].clientX - dragStartX
      if (Math.abs(dx) > DRAG_THRESHOLD) {
        isDragging = true
        e.preventDefault()
        canvas.style.cursor = 'grabbing'
      }
    }
  }, { passive: false })
  canvas.addEventListener('touchend', onEnd)

  canvas.style.cursor = 'grab'
  canvas.addEventListener('mousedown', onStart)
}

function initDragBehavior() {
  if (_dragInitialized) return
  _dragInitialized = true
  const trendCanvas     = document.getElementById('trend-chart')
  const nutritionCanvas = document.getElementById('nutrition-chart')
  if (trendCanvas)     addDragBehavior(trendCanvas)
  if (nutritionCanvas) addDragBehavior(nutritionCanvas)
}

// =============================================
// グラフ描画（Trend）
// =============================================
async function renderChart(endDate) {
  console.log('[charts] renderChart', endDate, currentPeriod, currentMetric)
  const canvas = document.getElementById('trend-chart')
  if (!canvas) return

  const wrap   = canvas.parentElement
  let loader   = wrap.querySelector('.chart-loader')
  if (!loader) {
    loader = document.createElement('div')
    loader.className = 'chart-loader'
    loader.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;color:var(--text-muted)'
    wrap.appendChild(loader)
  }
  loader.textContent = '読み込み中...'
  loader.style.display = 'flex'

  try {
    const { bodyData, balanceData, startDate } = await fetchData(endDate, currentPeriod)

    const bodyMap    = new Map(bodyData.map(d => [d.target_date, d]))
    const balanceMap = new Map(balanceData.map(d => [d.target_date, d]))

    const labels        = []
    const metricValues  = []
    const balanceValues = []
    const allDateStrs   = []

    let cur = startDate
    while (cur <= endDate) {
      labels.push(formatDateShort(cur))
      allDateStrs.push(cur)

      const bodyRow = bodyMap.get(cur)
      metricValues.push(
        bodyRow?.[currentMetric] != null ? Number(bodyRow[currentMetric]) : null
      )

      const balRow = balanceMap.get(cur)
      balanceValues.push(
        balRow?.balance != null ? Math.round(Number(balRow.balance)) : null
      )

      const d = new Date(cur + 'T12:00:00+09:00')
      d.setDate(d.getDate() + 1)
      cur = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
    }

    // ── 包絡線処理（体重タブ & 30日以上のみ）──
    const showEnvelope = (currentMetric === 'weight' && currentPeriod > 7)
    _envelopeVals = []
    _keyPtIdxSet  = new Set()
    _changePts    = []
    _totalDates   = allDateStrs.length

    if (showEnvelope) {
      const validCount = metricValues.filter(v => v != null).length
      if (validCount < 5) {
        renderInfobar(canvas, null, [])
        _cachedStats = null
      } else {
        const env    = computeEnvelope(allDateStrs, metricValues)
        const cps    = detectChangePoints(allDateStrs, env.values)
        const balMap = new Map(
          balanceData.map(d => [d.target_date, d.balance != null ? Number(d.balance) : null])
        )
        const stats  = computePaceStats(allDateStrs, env.values, cps, balMap)

        _envelopeVals = env.values
        _keyPtIdxSet  = new Set(env.keyPoints.map(kp => kp.idx))
        _changePts    = cps
        _cachedStats  = { stats, balanceData, allDates: allDateStrs }

        renderInfobar(canvas, stats, cps)
        renderPacePanel(stats, balanceData, allDateStrs)
      }
    } else {
      clearInfobar(canvas)
      // Keep last cached pace panel (period=7 doesn't clear it)
    }

    // ── Chart.js 描画 ──
    if (chartInstance) { chartInstance.destroy(); chartInstance = null }
    chartInstance = new Chart(canvas, buildChartConfig(labels, metricValues, balanceValues, showEnvelope))

  } catch (err) {
    console.error('[charts] error:', err)
    if (chartInstance) { chartInstance.destroy(); chartInstance = null }
    canvas.parentElement.innerHTML =
      `<div style="margin:16px;color:#f87171;font-size:12px">グラフ取得エラー: ${err.message}</div>`
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
    if (currentEndDate) renderBothCharts(currentEndDate)
  })
}

// =============================================
// 外部インターフェース
// =============================================
window.refreshCharts = async (dateStr) => {
  currentEndDate = dateStr
  initDragBehavior()
  await renderBothCharts(dateStr)
}

document.addEventListener('DOMContentLoaded', initTabs)
if (document.readyState !== 'loading') initTabs()
