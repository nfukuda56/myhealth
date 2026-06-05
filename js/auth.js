import { supabase } from './supabase.js'

/** 現在のセッションを取得 */
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

/** メール＋パスワードでサインイン */
export async function signIn(email, password) {
  return await supabase.auth.signInWithPassword({ email, password })
}

/** サインアウト */
export async function signOut() {
  await supabase.auth.signOut()
  window.location.href = './login.html'
}

/**
 * 認証必須ガード
 * 未ログイン時は login.html へリダイレクト
 * @returns {Session|null}
 */
export async function requireAuth() {
  const session = await getSession()
  if (!session) {
    window.location.href = './login.html'
    return null
  }
  return session
}
