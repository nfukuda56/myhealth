import { supabase } from '../supabase.js'

// =============================================
// Notion CSV パーサ
// =============================================
const MEAL_MAP = { '朝食':'breakfast','昼食':'lunch','夕食':'dinner','間食':'snack' }

function parseNotionDatetime(s) {
  s = (s || '').trim()
  const m = s.match(/(\d+)年(\d+)月(\d+)日(?:\s+(\d+):00\s*(?:\(JST\))?)?/)
  if (!m) return null
  const [,y,mo,d,h] = m
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${(h||'00').padStart(2,'0')}:00:00+09:00`
}

function parseCSVLine(line) {
  const cols = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQ = false
      else cur += c
    } else {
      if (c === '"') inQ = true
      else if (c === ',') { cols.push(cur); cur = '' }
      else cur += c
    }
  }
  cols.push(cur)
  return cols
}

function parseNotionCSV(text) {
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n')
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols = parseCSVLine(line)
    const measured_at = parseNotionDatetime(cols[0])
    if (!measured_at) continue
    const meal_type    = MEAL_MAP[cols[1]?.trim()] || 'snack'
    const menu_name    = cols[2]?.trim() || null
    const content      = cols[3]?.trim() || null
    const weight_g     = parseFloat(cols[4]) || null
    const calories_kcal= parseFloat(cols[5]) || null
    const protein_g    = parseFloat(cols[6]) || null
    const fat_g        = parseFloat(cols[7]) || null
    const carbs_g      = parseFloat(cols[8]) || null
    rows.push({ measured_at, meal_type, menu_name, content,
                weight_g, calories_kcal, protein_g, fat_g, carbs_g })
  }
  return rows
}

// =============================================
// 状態
// =============================================
let csvRows = []

// =============================================
// モーダル開閉
// =============================================
function openImportModal() {
  document.getElementById('import-modal').classList.add('show')
}
function closeImportModal() {
  document.getElementById('import-modal').classList.remove('show')
}

// =============================================
// CSV選択
// =============================================
function onCsvSelect(e) {
  const file = e.target.files[0]
  if (!file) return
  document.getElementById('import-file-name').textContent = file.name
  const reader = new FileReader()
  reader.onload = ev => {
    csvRows = parseNotionCSV(ev.target.result)
    updatePreview()
    document.getElementById('import-exec-btn').disabled = false
  }
  reader.readAsText(file, 'UTF-8')
}

function getCsvFiltered() {
  const from = document.getElementById('import-from').value
  const to   = document.getElementById('import-to').value
  return csvRows.filter(r => {
    const d = r.measured_at.slice(0,10)
    if (from && d < from) return false
    if (to   && d > to)   return false
    return true
  })
}

function updatePreview() {
  const f = getCsvFiltered()
  document.getElementById('import-preview').textContent =
    `取込予定: ${f.length} 件 / CSV全体: ${csvRows.length} 件`
}

// =============================================
// 取込実行
// =============================================
async function startImport() {
  const rows = getCsvFiltered()
  if (!rows.length) { alert('取込対象がありません'); return }

  const btn = document.getElementById('import-exec-btn')
  btn.disabled = true
  btn.textContent = '取込中...'

  const pw  = document.getElementById('import-progress-wrap')
  const pb  = document.getElementById('import-progress-bar')
  const log = document.getElementById('import-log')
  pw.style.display  = 'block'
  log.style.display = 'block'
  log.innerHTML = ''

  let inserted = 0, errors = 0
  const CHUNK = 50

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await supabase
      .from('meals')
      .upsert(chunk, { onConflict: 'measured_at,meal_type', ignoreDuplicates: true })

    const end = Math.min(i + CHUNK, rows.length)
    if (error) {
      errors += chunk.length
      appendLog(`✗ エラー [${i+1}〜${end}]: ${error.message}`, 'err')
    } else {
      inserted += chunk.length
      appendLog(`✓ ${i+1}〜${end} 件 OK`, 'ok')
    }
    pb.style.width = Math.round(end / rows.length * 100) + '%'
  }

  appendLog(`完了 — 取込: ${inserted}件 / エラー: ${errors}件`, inserted > 0 ? 'ok' : 'err')

  // ログイン中なのでバックフィルも実行
  const { data: bfData, error: bfErr } = await supabase.rpc('run_user_backfill')
  if (bfErr) appendLog(`[backfill] エラー: ${bfErr.message}`, 'warn')
  else appendLog(`[backfill] user_id/daily_log_id 付与完了: ${JSON.stringify(bfData)}`, 'info')

  btn.textContent = '取込実行'
  btn.disabled = false
}

function appendLog(msg, cls) {
  const el = document.getElementById('import-log')
  el.innerHTML += `<div class="log-${cls}">${msg}</div>`
  el.scrollTop = el.scrollHeight
}

// =============================================
// 初期化
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('import-open-btn')?.addEventListener('click', openImportModal)
  document.getElementById('import-close-btn')?.addEventListener('click', closeImportModal)
  document.getElementById('import-modal-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeImportModal()
  })
  document.getElementById('import-csv-file')?.addEventListener('change', onCsvSelect)
  document.getElementById('import-from')?.addEventListener('change', updatePreview)
  document.getElementById('import-to')?.addEventListener('change',   updatePreview)
  document.getElementById('import-clear-dates')?.addEventListener('click', () => {
    document.getElementById('import-from').value = ''
    document.getElementById('import-to').value   = ''
    updatePreview()
  })
  document.getElementById('import-exec-btn')?.addEventListener('click', startImport)
})
if (document.readyState !== 'loading') {
  // already loaded, run immediately
  document.getElementById('import-open-btn')?.addEventListener('click', openImportModal)
  document.getElementById('import-close-btn')?.addEventListener('click', closeImportModal)
  document.getElementById('import-modal-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeImportModal()
  })
  document.getElementById('import-csv-file')?.addEventListener('change', onCsvSelect)
  document.getElementById('import-from')?.addEventListener('change', updatePreview)
  document.getElementById('import-to')?.addEventListener('change',   updatePreview)
  document.getElementById('import-clear-dates')?.addEventListener('click', () => {
    document.getElementById('import-from').value = ''
    document.getElementById('import-to').value   = ''
    updatePreview()
  })
  document.getElementById('import-exec-btn')?.addEventListener('click', startImport)
}
