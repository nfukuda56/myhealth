# 減量管理システム API設計（v1）

> 作成：2026-06-05  
> 技術基盤：GitHub Pages + Supabase（PostgreSQL / Auth / RLS）

---

## 1. 概要

### 1.1 API種別

| 種別 | 用途 | エンドポイント |
|------|------|---------------|
| Supabase Auto REST API | テーブル単位のCRUD | `{SUPABASE_URL}/rest/v1/{table}` |
| Supabase RPC | 集計・複合クエリ | `{SUPABASE_URL}/rest/v1/rpc/{function}` |

### 1.2 共通リクエストヘッダ

\`\`\`http
apikey: {SUPABASE_ANON_KEY}
Authorization: Bearer {USER_ACCESS_TOKEN}
Content-Type: application/json
\`\`\`

> USER_ACCESS_TOKEN は Supabase Auth ログイン後に取得する JWT。
> RLS により auth.uid() と一致する行のみアクセス可能。

### 1.3 日時の扱い

- DB は TIMESTAMPTZ（UTC）で管理
- フロントエンドは Asia/Tokyo に変換して表示
- API リクエスト時は ISO 8601（UTC）形式で送信

---

## 2. Auto REST API — テーブル別CRUD

### 2.1 daily_logs

日次コンテナ。1ユーザー1日1レコード（UNIQUE制約）。

**GET — 日付指定取得**
```
GET /rest/v1/daily_logs?target_date=eq.2026-06-05&select=*
```

**GET — 期間取得**
```
GET /rest/v1/daily_logs?target_date=gte.2026-05-01&target_date=lte.2026-05-31&select=*&order=target_date.asc
```

**POST — 作成（日付切替時に自動生成）**
```json
POST /rest/v1/daily_logs
{
  "target_date": "2026-06-05",
  "day_start_at": "2026-06-04T19:00:00Z"
}
```
> day_start_at = target_date の AM 4:00 JST（UTC換算: 前日19:00Z）

---

### 2.2 body_metrics

身体計測。同日複数登録可。

**POST — 計測値登録**
```json
POST /rest/v1/body_metrics
{
  "user_id": "{uuid}",
  "daily_log_id": 123,
  "measured_at": "2026-06-05T22:00:00Z",
  "weight": 83.5,
  "body_fat_pct": 22.1,
  "basal_metabolism": 1820
}
```
> body_fat_pct・basal_metabolism は NULL 許容

---

### 2.3 meals + meal_items

食事イベント。

**GET — 日次取得（meal_items 結合）**
```
GET /rest/v1/meals?daily_log_id=eq.{log_id}&select=*,meal_items(*)&order=measured_at.asc
```

**POST — 食事登録**
```json
POST /rest/v1/meals
{
  "user_id": "{uuid}",
  "daily_log_id": 123,
  "meal_type": "breakfast",
  "measured_at": "2026-06-05T22:00:00Z",
  "memo": "会食"
}
```
> meal_type: breakfast / lunch / dinner / snack

**POST — 品目登録**
```json
POST /rest/v1/meal_items
{
  "meal_id": 456,
  "item_name": "牛丼",
  "kcal": 680,
  "protein_g": 25.0,
  "fat_g": 18.0,
  "carb_g": 95.0
}
```
> PFC・kcal は NULL 許容

---

### 2.4 exercises

**POST — 運動登録**
```json
POST /rest/v1/exercises
{
  "user_id": "{uuid}",
  "daily_log_id": 123,
  "exercise_type": "ウォーキング",
  "duration_min": 45,
  "burned_kcal": 180,
  "measured_at": "2026-06-05T10:00:00Z",
  "data_source": "Apple Health"
}
```

---

### 2.5 tags / タグ付与

**GET — 利用可能タグ一覧（system + 自分のuserタグ）**
```
GET /rest/v1/tags?or=(is_system.eq.true,user_id.eq.{uuid})&order=is_system.desc,tag_name.asc
```

**POST — daily_log へのタグ付与**
```json
POST /rest/v1/daily_log_tags
{ "daily_log_id": 123, "tag_id": 5 }
```
> meal_tags・exercise_tags も同構造

---

## 3. RPC（Supabase PostgreSQL関数）

### 3.1 get_daily_summary — 日次サマリー

日次メイン画面の中核。

**呼び出し**
```json
POST /rest/v1/rpc/get_daily_summary
{ "p_target_date": "2026-06-05" }
```

**返却値**
```json
{
  "target_date": "2026-06-05",
  "total_intake_kcal": 1850,
  "total_burned_kcal": 320,
  "basal_metabolism": 1820,
  "basal_elapsed_kcal": 910,
  "estimated_total_burned": 2140,
  "estimated_balance": -290,
  "latest_weight": 83.5,
  "latest_body_fat_pct": 22.1
}
```

> basal_elapsed_kcal：基礎代謝 × (現在時刻 - day_start_at) / 24h  
> estimated_balance：total_intake_kcal − estimated_total_burned

**DB関数スケルトン**
```sql
CREATE OR REPLACE FUNCTION get_daily_summary(p_target_date DATE)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_log_id BIGINT;
BEGIN
  SELECT id INTO v_log_id FROM daily_logs
  WHERE user_id = auth.uid() AND target_date = p_target_date;

  IF v_log_id IS NULL THEN
    RETURN json_build_object('target_date', p_target_date, 'total_intake_kcal', 0);
  END IF;

  RETURN (
    SELECT json_build_object(
      'target_date',         p_target_date,
      'total_intake_kcal',   COALESCE((SELECT SUM(mi.kcal) FROM meals m JOIN meal_items mi ON mi.meal_id=m.id WHERE m.daily_log_id=v_log_id), 0),
      'total_burned_kcal',   COALESCE((SELECT SUM(burned_kcal) FROM exercises WHERE daily_log_id=v_log_id), 0),
      'basal_metabolism',    (SELECT basal_metabolism FROM body_metrics WHERE user_id=auth.uid() AND basal_metabolism IS NOT NULL ORDER BY measured_at DESC LIMIT 1),
      'latest_weight',       (SELECT weight FROM body_metrics WHERE daily_log_id=v_log_id ORDER BY measured_at DESC LIMIT 1),
      'latest_body_fat_pct', (SELECT body_fat_pct FROM body_metrics WHERE daily_log_id=v_log_id ORDER BY measured_at DESC LIMIT 1)
    )
  );
END;
$$;
```

---

### 3.2 get_daily_timeline — タイムライン

**呼び出し**
```json
POST /rest/v1/rpc/get_daily_timeline
{ "p_target_date": "2026-06-05" }
```

**返却値**
```json
[
  { "event_time": "2026-06-04T22:20:00Z", "event_type": "body_metric", "summary": "体重 83.5kg / 体脂肪 22.1%", "id": 1 },
  { "event_time": "2026-06-04T22:40:00Z", "event_type": "meal",        "summary": "朝食 680kcal",               "id": 5 },
  { "event_time": "2026-06-05T01:00:00Z", "event_type": "exercise",    "summary": "ウォーキング 45分 180kcal",  "id": 3 }
]
```

**DB関数スケルトン**
```sql
CREATE OR REPLACE FUNCTION get_daily_timeline(p_target_date DATE)
RETURNS TABLE(event_time TIMESTAMPTZ, event_type TEXT, summary TEXT, id BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_log_id BIGINT;
BEGIN
  SELECT dl.id INTO v_log_id FROM daily_logs dl
  WHERE dl.user_id = auth.uid() AND dl.target_date = p_target_date;

  RETURN QUERY
    SELECT bm.measured_at, 'body_metric'::TEXT,
           CONCAT('体重 ', bm.weight, 'kg / 体脂肪 ', bm.body_fat_pct, '%'), bm.id
    FROM body_metrics bm WHERE bm.daily_log_id = v_log_id
  UNION ALL
    SELECT m.measured_at, 'meal'::TEXT,
           CONCAT(m.meal_type, ' ',
             COALESCE((SELECT SUM(kcal) FROM meal_items WHERE meal_id=m.id)::TEXT, '?'), 'kcal'), m.id
    FROM meals m WHERE m.daily_log_id = v_log_id
  UNION ALL
    SELECT e.measured_at, 'exercise'::TEXT,
           CONCAT(e.exercise_type, ' ', e.duration_min, '分 ',
             COALESCE(e.burned_kcal::TEXT, '?'), 'kcal'), e.id
    FROM exercises e WHERE e.daily_log_id = v_log_id
  ORDER BY event_time ASC;
END;
$$;
```

---

### 3.3 get_body_trend — 体重・体脂肪推移

**呼び出し**
```json
POST /rest/v1/rpc/get_body_trend
{ "p_start_date": "2026-05-01", "p_end_date": "2026-06-05" }
```

**返却値**
```json
[
  {
    "target_date": "2026-05-01",
    "weight": 85.2,
    "body_fat_pct": 23.5,
    "fat_mass": 20.02,
    "lean_body_mass": 65.18,
    "tags": ["飲酒"]
  }
]
```

> fat_mass = weight × body_fat_pct / 100  
> lean_body_mass = weight − fat_mass  
> 同日複数計測時は最終計測値を採用

**DB関数スケルトン**
```sql
CREATE OR REPLACE FUNCTION get_body_trend(p_start_date DATE, p_end_date DATE)
RETURNS TABLE(target_date DATE, weight NUMERIC, body_fat_pct NUMERIC,
              fat_mass NUMERIC, lean_body_mass NUMERIC, tags TEXT[])
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    dl.target_date, bm.weight, bm.body_fat_pct,
    ROUND(bm.weight * bm.body_fat_pct / 100, 2),
    ROUND(bm.weight - (bm.weight * bm.body_fat_pct / 100), 2),
    ARRAY(SELECT t.tag_name FROM daily_log_tags dlt
          JOIN tags t ON t.id = dlt.tag_id WHERE dlt.daily_log_id = dl.id)
  FROM daily_logs dl
  JOIN LATERAL (
    SELECT weight, body_fat_pct FROM body_metrics
    WHERE daily_log_id = dl.id AND weight IS NOT NULL
    ORDER BY measured_at DESC LIMIT 1
  ) bm ON true
  WHERE dl.user_id = auth.uid()
    AND dl.target_date BETWEEN p_start_date AND p_end_date
  ORDER BY dl.target_date ASC;
END;
$$;
```

---

### 3.4 get_calorie_balance_trend — カロリー収支推移

**呼び出し**
```json
POST /rest/v1/rpc/get_calorie_balance_trend
{ "p_start_date": "2026-05-01", "p_end_date": "2026-06-05" }
```

**返却値**
```json
[
  {
    "target_date": "2026-05-01",
    "intake_kcal": 2100,
    "burned_kcal": 320,
    "basal_metabolism": 1820,
    "estimated_total_burned": 2140,
    "balance": -40
  }
]
```

---

### 3.5 suggest_meal_items — 食事履歴サジェスト

**呼び出し**
```json
POST /rest/v1/rpc/suggest_meal_items
{ "p_query": "牛", "p_limit": 10 }
```

**返却値**
```json
[
  { "item_name": "牛丼", "avg_kcal": 680, "avg_protein_g": 25.0, "avg_fat_g": 18.0, "avg_carb_g": 95.0, "use_count": 12 },
  { "item_name": "牛乳", "avg_kcal": 130, "avg_protein_g": 6.8,  "avg_fat_g": 7.8,  "avg_carb_g": 9.7,  "use_count": 5  }
]
```

---

### 3.6 get_latest_basal_metabolism — 最新基礎代謝取得

**呼び出し**
```json
POST /rest/v1/rpc/get_latest_basal_metabolism
{ "p_as_of": "2026-06-05T12:00:00Z" }
```

**返却値**
```json
{ "basal_metabolism": 1820, "measured_at": "2026-06-01T22:00:00Z" }
```

---

## 4. 認証フロー

```javascript
// サインアップ
const { data, error } = await supabase.auth.signUp({ email, password })

// ログイン
const { data, error } = await supabase.auth.signInWithPassword({ email, password })
// data.session.access_token をリクエストヘッダに使用

// セッション取得（ページロード時）
const { data: { session } } = await supabase.auth.getSession()
```

---

## 5. daily_log 自動生成

フロントエンドは日付切替時に upsert で daily_log を確保する。

```javascript
async function ensureDailyLog(targetDate) {
  // AM4:00 JST = 前日 19:00 UTC
  const dayStartAt = new Date(`${targetDate}T04:00:00+09:00`).toISOString()
  const { data } = await supabase
    .from('daily_logs')
    .upsert(
      { target_date: targetDate, day_start_at: dayStartAt },
      { onConflict: 'user_id,target_date' }
    )
    .select('id').single()
  return data.id
}
```

---

## 6. エラーハンドリング方針

| HTTPステータス | 意味 | 対応 |
|--------------|------|------|
| 200 / 201 | 成功 | — |
| 400 | リクエスト不正 | バリデーションエラー表示 |
| 401 | 認証切れ | 再ログイン促す |
| 403 | RLS違反 | 権限エラー |
| 409 | UNIQUE制約違反 | 重複登録回避 |
| 500 | サーバーエラー | リトライ |

---

## 7. RPC実装優先順位

| 優先度 | 関数 | 理由 |
|--------|------|------|
| ★★★ | get_daily_summary | メイン画面の中核 |
| ★★★ | get_daily_timeline | 日次画面に必須 |
| ★★☆ | get_body_trend | グラフ表示に必須 |
| ★★☆ | get_calorie_balance_trend | グラフ表示に必須 |
| ★☆☆ | suggest_meal_items | UX向上・後回し可 |
| ★☆☆ | get_latest_basal_metabolism | サマリー補助 |

---

## 8. 今後の拡張予定

- タグ集計API（タグ別カロリー傾向）
- 移動平均API（7日/14日/30日）
- Apple Health 自動取込（Edge Function）
- Notion 食事取込（Edge Function）
