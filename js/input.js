import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = 'https://lvmgfolwipwgyhhzskvj.supabase.co'
const SUPABASE_KEY = 'sb_publishable_q1QSXYVIMPtuf5D7pYmcnw_oijyIXYx'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── ユーティリティ ──────────────────────────────

function toLocalDatetimeValue(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localToUTC(localStr) {
  return new Date(localStr).toISOString()
}

function formatDate(date) {
  const days = ['日','月','火','水','木','金','土']
  const today = new Date()
  const isToday = date.toDateString() === today.toDateString()
  const m = date.getMonth() + 1
  const d = date.getDate()
  const w = days[date.getDay()]
  return `${m}月${d}日（${w}）${isToday ? ' 今日' : ''}`
}

let toastTimer = null
function showToast(msg) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800)
}

// ── 日付ナビ ───────────────────────────────────

let currentDate = new Date()
currentDate.setHours(0, 0, 0, 0)
let currentUserId = null

function updateDateDisplay() {
  document.getElementById('date-display').textContent = formatDate(currentDate)
  // 食事日時のデフォルトも現在日時に合わせる（日付変更時は0時に設定）
  const now = new Date()
  const isSameDay = now.toDateString() === currentDate.toDateString()
  const ref = isSameDay ? now : new Date(currentDate)
  document.getElementById('meal-datetime').value = toLocalDatetimeValue(ref)
}

document.getElementById('prev-day').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() - 1)
  updateDateDisplay()
})
document.getElementById('next-day').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 1)
  updateDateDisplay()
})

// ── タブ切り替え ───────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active')
    if (btn.dataset.tab === 'bmr') loadBmrHistory()
  })
})

// ── 認証 ──────────────────────────────────────

async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session) {
    currentUserId = session.user.id
    showMain()
  } else {
    document.getElementById('auth-screen').style.display = 'flex'
  }
}

function showMain() {
  document.getElementById('auth-screen').style.display = 'none'
  document.getElementById('main-screen').style.display = 'block'
  updateDateDisplay()
  initMealForm()
  document.getElementById('bmr-datetime').value = toLocalDatetimeValue()
}

document.getElementById('signin-btn').addEventListener('click', async () => {
  const email = document.getElementById('email-input').value.trim()
  const password = document.getElementById('password-input').value
  const errEl = document.getElementById('auth-error')
  const btn = document.getElementById('signin-btn')
  errEl.textContent = ''
  btn.disabled = true
  btn.innerHTML = '<div class="spinner"></div>'
  const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password })
  btn.disabled = false
  btn.textContent = 'サインイン'
  if (error) {
    errEl.textContent = 'メールアドレスまたはパスワードが正しくありません'
  } else {
    currentUserId = signInData.session.user.id
    showMain()
  }
})

document.getElementById('password-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('signin-btn').click()
})

document.getElementById('signout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut()
  document.getElementById('main-screen').style.display = 'none'
  document.getElementById('auth-screen').style.display = 'flex'
})

// ── 食事区分 ──────────────────────────────────

let selectedMealType = 'breakfast'
document.getElementById('meal-type-row').addEventListener('click', e => {
  const btn = e.target.closest('.meal-type-btn')
  if (!btn) return
  document.querySelectorAll('.meal-type-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  selectedMealType = btn.dataset.type
})

// ── タグ ──────────────────────────────────────

const selectedTags = new Set()
document.getElementById('tags-row').addEventListener('click', e => {
  const btn = e.target.closest('.tag-btn')
  if (!btn) return
  const tag = btn.dataset.tag
  if (selectedTags.has(tag)) {
    selectedTags.delete(tag)
    btn.classList.remove('active')
  } else {
    selectedTags.add(tag)
    btn.classList.add('active')
  }
})

// ── 品目カード ────────────────────────────────

let itemCardCount = 0
let suggestCache = {}

function createItemCard() {
  const id = ++itemCardCount
  const card = document.createElement('div')
  card.className = 'item-card'
  card.dataset.id = id
  card.innerHTML = `
    <div class="item-name-row">
      <input class="item-name-input" type="text" placeholder="品目名" autocomplete="off" data-suggest-id="${id}">
      <button class="item-delete-btn" data-delete="${id}" title="削除">×</button>
      <div class="suggest-dropdown" id="suggest-${id}"></div>
    </div>
    <div class="pfc-row">
      <div class="pfc-cell">
        <div class="pfc-label">kcal</div>
        <input class="pfc-input" type="number" inputmode="decimal" placeholder="—" data-field="kcal">
      </div>
      <div class="pfc-cell">
        <div class="pfc-label">P</div>
        <input class="pfc-input" type="number" inputmode="decimal" placeholder="—" data-field="p">
      </div>
      <div class="pfc-cell">
        <div class="pfc-label">F</div>
        <input class="pfc-input" type="number" inputmode="decimal" placeholder="—" data-field="f">
      </div>
      <div class="pfc-cell">
        <div class="pfc-label">C</div>
        <input class="pfc-input" type="number" inputmode="decimal" placeholder="—" data-field="c">
      </div>
    </div>
    <input class="item-memo-input" type="text" placeholder="品目メモ（任意）">
  `

  // 品目名入力 → サジェスト
  const nameInput = card.querySelector('.item-name-input')
  const dropdown = card.querySelector('.suggest-dropdown')
  let suggestTimer = null
  let closeTimer = null

  nameInput.addEventListener('input', async () => {
    const q = nameInput.value.trim()
    if (q.length === 0) { dropdown.style.display = 'none'; return }
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(() => fetchSuggest(q, id, card, dropdown), 180)
  })
  nameInput.addEventListener('blur', () => {
    closeTimer = setTimeout(() => { dropdown.style.display = 'none' }, 200)
  })
  nameInput.addEventListener('focus', () => {
    if (closeTimer) clearTimeout(closeTimer)
  })

  // PFC変更 → サマリー更新
  card.querySelectorAll('.pfc-input').forEach(inp => {
    inp.addEventListener('input', updateSummary)
  })

  // 削除ボタン
  card.querySelector('.item-delete-btn').addEventListener('click', () => {
    const list = document.getElementById('item-list')
    if (list.children.length <= 1) { showToast('⚠️ 品目は1件以上必要です'); return }
    card.remove()
    updateSummary()
  })

  return card
}

async function fetchSuggest(query, cardId, card, dropdown) {
  try {
    const { data, error } = await supabase.rpc('suggest_meal_items', { p_query: query, p_limit: 6 })
    if (error || !data || data.length === 0) { dropdown.style.display = 'none'; return }
    dropdown.innerHTML = data.map(item => `
      <div class="suggest-item" data-name="${escHtml(item.menu_name)}"
           data-kcal="${item.avg_kcal ?? ''}"
           data-p="${item.avg_protein ?? ''}"
           data-f="${item.avg_fat ?? ''}"
           data-c="${item.avg_carbs ?? ''}">
        <span class="suggest-name">${escHtml(item.menu_name)}</span>
        <span class="suggest-meta">
          <span class="suggest-badge">${item.use_count}回</span>
          ${item.avg_kcal ? Math.round(item.avg_kcal) + ' kcal' : ''}
        </span>
      </div>
    `).join('')
    dropdown.querySelectorAll('.suggest-item').forEach(si => {
      si.addEventListener('mousedown', e => {
        e.preventDefault()
        const nameInput = card.querySelector('.item-name-input')
        nameInput.value = si.dataset.name
        const fill = (field, val) => {
          if (!val) return
          const inp = card.querySelector(`.pfc-input[data-field="${field}"]`)
          if (inp) inp.value = parseFloat(val).toFixed(1)
        }
        fill('kcal', si.dataset.kcal)
        fill('p', si.dataset.p)
        fill('f', si.dataset.f)
        fill('c', si.dataset.c)
        dropdown.style.display = 'none'
        updateSummary()
      })
    })
    dropdown.style.display = 'block'
  } catch(e) {
    dropdown.style.display = 'none'
  }
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function initMealForm() {
  const list = document.getElementById('item-list')
  list.innerHTML = ''
  itemCardCount = 0
  list.appendChild(createItemCard())
  updateSummary()
}

document.getElementById('add-item-btn').addEventListener('click', () => {
  document.getElementById('item-list').appendChild(createItemCard())
})

function updateSummary() {
  const cards = document.querySelectorAll('.item-card')
  let kcal = 0, p = 0, f = 0, c = 0, hasAny = false
  cards.forEach(card => {
    const v = f => { const i = card.querySelector(`.pfc-input[data-field="${f}"]`); return i ? parseFloat(i.value) || 0 : 0 }
    const k = v('kcal'), pp = v('p'), ff = v('f'), cc = v('c')
    if (k || pp || ff || cc) hasAny = true
    kcal += k; p += pp; f += ff; c += cc
  })
  const sum = document.getElementById('meal-summary')
  if (!hasAny) { sum.style.display = 'none'; return }
  sum.style.display = 'block'
  document.getElementById('sum-kcal').textContent = Math.round(kcal)
  document.getElementById('sum-p').textContent = p.toFixed(1) + 'g'
  document.getElementById('sum-f').textContent = f.toFixed(1) + 'g'
  document.getElementById('sum-c').textContent = c.toFixed(1) + 'g'
}

// ── daily_log 確保ヘルパー ─────────────────────
// measured_at (UTC ISO文字列) から JST AM4:00境界で target_date を算出し、
// daily_logs を UPSERT して id を返す。

async function ensureDailyLog(measuredAtISO) {
  const jstMs = new Date(measuredAtISO).getTime() + 9 * 60 * 60 * 1000
  const td = new Date(jstMs - 4 * 60 * 60 * 1000)
  const targetDate = td.toISOString().slice(0, 10)          // YYYY-MM-DD
  const dayStartAt = targetDate + 'T04:00:00+09:00'

  const { data, error } = await supabase
    .from('daily_logs')
    .upsert(
      { user_id: currentUserId, target_date: targetDate, day_start_at: dayStartAt },
      { onConflict: 'user_id,target_date' }
    )
    .select('id')
    .single()

  if (error) throw new Error('daily_log 作成失敗: ' + error.message)
  return data.id
}

// ── 食事保存 ──────────────────────────────────

document.getElementById('meal-save-btn').addEventListener('click', async () => {
  const cards = document.querySelectorAll('.item-card')
  const items = []
  let valid = true

  cards.forEach(card => {
    const name = card.querySelector('.item-name-input').value.trim()
    if (!name) { valid = false; card.querySelector('.item-name-input').focus(); return }
    const n = f => { const i = card.querySelector(`.pfc-input[data-field="${f}"]`); return i && i.value !== '' ? parseFloat(i.value) : null }
    items.push({
      menu_name: name,
      calories_kcal: n('kcal'),
      protein_g: n('p'),
      fat_g: n('f'),
      carbs_g: n('c'),
      content: card.querySelector('.item-memo-input').value.trim() || null,
    })
  })

  if (!valid) { showToast('⚠️ 品目名を入力してください'); return }
  if (items.length === 0) { showToast('⚠️ 品目は1件以上必要です'); return }

  const dtVal = document.getElementById('meal-datetime').value
  if (!dtVal) { showToast('⚠️ 食事日時を入力してください'); return }

  const memo = document.getElementById('meal-memo').value.trim()
  const tags = [...selectedTags]
  const memoWithTags = tags.length > 0 ? (memo ? memo + ' ' : '') + tags.join(' ') : (memo || null)

  const measuredAt = localToUTC(dtVal)

  const btn = document.getElementById('meal-save-btn')
  btn.disabled = true
  btn.innerHTML = '<div class="spinner"></div> 保存中...'

  // daily_logs を確保して daily_log_id を取得
  let dailyLogId
  try {
    dailyLogId = await ensureDailyLog(measuredAt)
  } catch (e) {
    showToast('❌ ' + e.message)
    btn.disabled = false
    btn.textContent = 'この食事を保存'
    return
  }

  const rows = items.map(item => ({
    ...item,
    meal_type: selectedMealType,
    measured_at: measuredAt,
    memo: memoWithTags,
    input_source: 'manual',
    daily_log_id: dailyLogId,
  }))

  const { error } = await supabase.from('meals').insert(rows)

  btn.disabled = false
  btn.textContent = 'この食事を保存'

  if (error) {
    showToast('❌ 保存に失敗しました: ' + error.message)
    return
  }

  showToast('✓ ' + items.length + '品目を保存しました')

  // フォームリセット
  document.getElementById('meal-datetime').value = toLocalDatetimeValue()
  document.querySelectorAll('.meal-type-btn').forEach(b => b.classList.remove('active'))
  document.querySelector('.meal-type-btn[data-type="breakfast"]').classList.add('active')
  selectedMealType = 'breakfast'
  document.getElementById('meal-memo').value = ''
  selectedTags.clear()
  document.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active'))
  initMealForm()
})

// ── 基礎代謝履歴 ──────────────────────────────

async function loadBmrHistory() {
  const listEl = document.getElementById('bmr-history-list')
  listEl.innerHTML = '<div class="empty-msg">読み込み中...</div>'
  const { data, error } = await supabase
    .from('body_metrics')
    .select('id, measured_at, basal_metabolism_kcal, device_name, memo, source')
    .eq('source', 'manual')
    .not('basal_metabolism_kcal', 'is', null)
    .order('measured_at', { ascending: false })
    .limit(20)

  if (error || !data) {
    listEl.innerHTML = '<div class="empty-msg">読み込みエラー</div>'
    return
  }
  if (data.length === 0) {
    listEl.innerHTML = '<div class="empty-msg">まだ記録がありません</div>'
    return
  }

  listEl.innerHTML = ''
  data.forEach((row, idx) => {
    const dt = new Date(row.measured_at)
    const days = ['日','月','火','水','木','金','土']
    const label = `${dt.getMonth()+1}/${dt.getDate()}（${days[dt.getDay()]}） ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`
    const card = document.createElement('div')
    card.className = 'bmr-history-card'
    card.innerHTML = `
      <div class="bmr-card-left">
        <div class="bmr-card-datetime">
          ${label}${idx === 0 ? '<span class="applied-badge">適用中</span>' : ''}
        </div>
        <div class="bmr-card-value">${row.basal_metabolism_kcal} kcal/日</div>
        ${row.device_name ? `<div class="bmr-card-device">${escHtml(row.device_name)}</div>` : ''}
      </div>
      <button class="bmr-delete-btn" data-id="${row.id}">削除</button>
    `
    card.querySelector('.bmr-delete-btn').addEventListener('click', () => deleteBmr(row.id))
    listEl.appendChild(card)
  })
}

async function deleteBmr(id) {
  if (!confirm('この記録を削除しますか？')) return
  const { error } = await supabase.rpc('delete_body_metric', { p_id: id })
  if (error) { showToast('❌ 削除に失敗しました'); return }
  showToast('✓ 削除しました')
  loadBmrHistory()
}

// ── 基礎代謝保存 ──────────────────────────────

document.getElementById('bmr-save-btn').addEventListener('click', async () => {
  const dtVal = document.getElementById('bmr-datetime').value
  const valStr = document.getElementById('bmr-value').value
  const errEl = document.getElementById('bmr-value-error')
  errEl.textContent = ''

  if (!dtVal) { showToast('⚠️ 計測日時を入力してください'); return }
  const val = parseInt(valStr, 10)
  if (!valStr || isNaN(val) || val < 800 || val > 4000) {
    errEl.textContent = '800〜4000 の範囲で入力してください'
    document.getElementById('bmr-value').focus()
    return
  }

  const device = document.getElementById('bmr-device').value.trim() || null
  const memo = document.getElementById('bmr-memo').value.trim() || null

  const btn = document.getElementById('bmr-save-btn')
  btn.disabled = true
  btn.innerHTML = '<div class="spinner"></div> 保存中...'

  const { error } = await supabase.from('body_metrics').insert({
    measured_at: localToUTC(dtVal),
    basal_metabolism_kcal: val,
    device_name: device,
    memo: memo,
    source: 'manual',
  })

  btn.disabled = false
  btn.textContent = '基礎代謝を記録'

  if (error) { showToast('❌ 保存に失敗しました: ' + error.message); return }

  showToast('✓ 基礎代謝を記録しました')
  document.getElementById('bmr-datetime').value = toLocalDatetimeValue()
  document.getElementById('bmr-value').value = ''
  document.getElementById('bmr-device').value = ''
  document.getElementById('bmr-memo').value = ''
  loadBmrHistory()
})

// ── 計測機器サジェスト ────────────────────────

const deviceInput = document.getElementById('bmr-device')
const deviceDropdown = document.getElementById('device-suggest')
let deviceSuggestTimer = null
let deviceCloseTimer = null

deviceInput.addEventListener('input', async () => {
  const q = deviceInput.value.trim()
  if (q.length === 0) { deviceDropdown.style.display = 'none'; return }
  if (deviceSuggestTimer) clearTimeout(deviceSuggestTimer)
  deviceSuggestTimer = setTimeout(async () => {
    const { data } = await supabase.rpc('suggest_device_names', { p_query: q })
    if (!data || data.length === 0) { deviceDropdown.style.display = 'none'; return }
    deviceDropdown.innerHTML = data.slice(0, 5).map(d =>
      `<div class="device-suggest-item">${escHtml(d.device_name ?? d)}</div>`
    ).join('')
    deviceDropdown.querySelectorAll('.device-suggest-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault()
        deviceInput.value = item.textContent.trim()
        deviceDropdown.style.display = 'none'
      })
    })
    deviceDropdown.style.display = 'block'
  }, 180)
})
deviceInput.addEventListener('blur', () => {
  deviceCloseTimer = setTimeout(() => { deviceDropdown.style.display = 'none' }, 200)
})
deviceInput.addEventListener('focus', () => {
  if (deviceCloseTimer) clearTimeout(deviceCloseTimer)
})

// ── 初期化 ────────────────────────────────────

initAuth()
