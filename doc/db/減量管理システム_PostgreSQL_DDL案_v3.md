# 減量管理システム PostgreSQL DDL案（v3）

> 改訂履歴：v3（2026-06-05）Supabase構成対応
> - user_id を UUID 型に変更（Supabase Auth `auth.uid()` 対応）
> - TIMESTAMP → TIMESTAMPTZ に変更（Supabase UTC管理対応）
> - RLS（Row Level Security）設定を追加
> - プロファイルテーブルを auth.users 参照に変更

---

## 事前設定

```sql
-- タイムゾーン確認（Supabase側はUTCで管理、表示はフロント側でJST変換）
-- SET timezone = 'UTC';  -- Supabaseデフォルトのため設定不要
```

---

## DDL本体

```sql
-- =========================================================
-- USER PROFILES
-- Supabase Auth（auth.users）と連携するプロファイルテーブル
-- =========================================================

CREATE TABLE user_profiles (
    id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    user_name           VARCHAR(100) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のプロファイルのみ操作可"
    ON user_profiles
    FOR ALL
    USING (auth.uid() = id);

CREATE INDEX idx_user_profiles_name
    ON user_profiles(user_name);



-- =========================================================
-- DAILY LOGS
-- 「その日」のコンテナ
-- =========================================================

CREATE TABLE daily_logs (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    target_date         DATE NOT NULL,
    day_start_at        TIMESTAMPTZ NOT NULL,
    memo                TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_daily_logs_user_date
        UNIQUE(user_id, target_date)
);

ALTER TABLE daily_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のdaily_logsのみ操作可"
    ON daily_logs
    FOR ALL
    USING (auth.uid() = user_id);

CREATE INDEX idx_daily_logs_user_date
    ON daily_logs(user_id, target_date);

CREATE INDEX idx_daily_logs_day_start
    ON daily_logs(day_start_at);



-- =========================================================
-- TAGS
-- system / user 共通
-- user_id NULL = system tag
-- user_id あり = user custom tag
-- =========================================================

CREATE TABLE tags (
    id                  BIGSERIAL PRIMARY KEY,

    user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    tag_name            VARCHAR(100) NOT NULL,
    category            VARCHAR(50),
    is_system           BOOLEAN NOT NULL DEFAULT FALSE,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

-- system tag は全ユーザーが参照可能
-- user tag は自分のみ参照・操作可能
CREATE POLICY "systemタグ参照可"
    ON tags
    FOR SELECT
    USING (is_system = TRUE);

CREATE POLICY "自分のuserタグのみ操作可"
    ON tags
    FOR ALL
    USING (auth.uid() = user_id);

CREATE INDEX idx_tags_name
    ON tags(tag_name);

CREATE INDEX idx_tags_user
    ON tags(user_id);



-- =========================================================
-- DAILY LOG TAGS
-- =========================================================

CREATE TABLE daily_log_tags (
    id                  BIGSERIAL PRIMARY KEY,

    daily_log_id        BIGINT NOT NULL,
    tag_id              BIGINT NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_daily_log_tags_log
        FOREIGN KEY (daily_log_id)
        REFERENCES daily_logs(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_daily_log_tags_tag
        FOREIGN KEY (tag_id)
        REFERENCES tags(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_daily_log_tags
        UNIQUE(daily_log_id, tag_id)
);

ALTER TABLE daily_log_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のdaily_log_tagsのみ操作可"
    ON daily_log_tags
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM daily_logs
            WHERE daily_logs.id = daily_log_tags.daily_log_id
              AND daily_logs.user_id = auth.uid()
        )
    );

CREATE INDEX idx_daily_log_tags_log
    ON daily_log_tags(daily_log_id);

CREATE INDEX idx_daily_log_tags_tag
    ON daily_log_tags(tag_id);



-- =========================================================
-- BODY METRICS
-- =========================================================

CREATE TABLE body_metrics (
    id                          BIGSERIAL PRIMARY KEY,

    daily_log_id                BIGINT NOT NULL,

    measured_at                 TIMESTAMPTZ NOT NULL,

    weight_kg                   NUMERIC(5,2),
    body_fat_pct                NUMERIC(5,2),

    basal_metabolism_kcal       INTEGER,

    source_type                 VARCHAR(50),

    memo                        TEXT,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_body_metrics_log
        FOREIGN KEY (daily_log_id)
        REFERENCES daily_logs(id)
        ON DELETE CASCADE
);

ALTER TABLE body_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のbody_metricsのみ操作可"
    ON body_metrics
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM daily_logs
            WHERE daily_logs.id = body_metrics.daily_log_id
              AND daily_logs.user_id = auth.uid()
        )
    );

CREATE INDEX idx_body_metrics_log
    ON body_metrics(daily_log_id);

CREATE INDEX idx_body_metrics_measured
    ON body_metrics(measured_at);



-- =========================================================
-- MEALS
-- 「食事イベント」
-- =========================================================

CREATE TABLE meals (
    id                  BIGSERIAL PRIMARY KEY,

    daily_log_id        BIGINT NOT NULL,

    measured_at         TIMESTAMPTZ NOT NULL,

    meal_type           VARCHAR(20) NOT NULL,
    -- 候補: breakfast / lunch / dinner / snack

    memo                TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_meals_log
        FOREIGN KEY (daily_log_id)
        REFERENCES daily_logs(id)
        ON DELETE CASCADE
);

ALTER TABLE meals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のmealsのみ操作可"
    ON meals
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM daily_logs
            WHERE daily_logs.id = meals.daily_log_id
              AND daily_logs.user_id = auth.uid()
        )
    );

CREATE INDEX idx_meals_log
    ON meals(daily_log_id);

CREATE INDEX idx_meals_measured
    ON meals(measured_at);

CREATE INDEX idx_meals_type
    ON meals(meal_type);



-- =========================================================
-- MEAL ITEMS
-- 「食べたもの」
-- =========================================================

CREATE TABLE meal_items (
    id                  BIGSERIAL PRIMARY KEY,

    meal_id             BIGINT NOT NULL,

    item_name           VARCHAR(200) NOT NULL,

    detail_text         TEXT,

    kcal                INTEGER,

    protein_g           NUMERIC(6,2),
    fat_g               NUMERIC(6,2),
    carb_g              NUMERIC(6,2),

    memo                TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_meal_items_meal
        FOREIGN KEY (meal_id)
        REFERENCES meals(id)
        ON DELETE CASCADE
);

ALTER TABLE meal_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のmeal_itemsのみ操作可"
    ON meal_items
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM meals
            JOIN daily_logs ON daily_logs.id = meals.daily_log_id
            WHERE meals.id = meal_items.meal_id
              AND daily_logs.user_id = auth.uid()
        )
    );

CREATE INDEX idx_meal_items_meal
    ON meal_items(meal_id);

CREATE INDEX idx_meal_items_name
    ON meal_items(item_name);



-- =========================================================
-- MEAL TAGS
-- =========================================================

CREATE TABLE meal_tags (
    id                  BIGSERIAL PRIMARY KEY,

    meal_id             BIGINT NOT NULL,
    tag_id              BIGINT NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_meal_tags_meal
        FOREIGN KEY (meal_id)
        REFERENCES meals(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_meal_tags_tag
        FOREIGN KEY (tag_id)
        REFERENCES tags(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_meal_tags
        UNIQUE(meal_id, tag_id)
);

ALTER TABLE meal_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のmeal_tagsのみ操作可"
    ON meal_tags
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM meals
            JOIN daily_logs ON daily_logs.id = meals.daily_log_id
            WHERE meals.id = meal_tags.meal_id
              AND daily_logs.user_id = auth.uid()
        )
    );

CREATE INDEX idx_meal_tags_meal
    ON meal_tags(meal_id);

CREATE INDEX idx_meal_tags_tag
    ON meal_tags(tag_id);



-- =========================================================
-- EXERCISES
-- =========================================================

CREATE TABLE exercises (
    id                  BIGSERIAL PRIMARY KEY,

    daily_log_id        BIGINT NOT NULL,

    measured_at         TIMESTAMPTZ NOT NULL,

    exercise_type       VARCHAR(100) NOT NULL,

    duration_min        INTEGER,

    burned_kcal         INTEGER,

    source              VARCHAR(100),

    memo                TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_exercises_log
        FOREIGN KEY (daily_log_id)
        REFERENCES daily_logs(id)
        ON DELETE CASCADE
);

ALTER TABLE exercises ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のexercisesのみ操作可"
    ON exercises
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM daily_logs
            WHERE daily_logs.id = exercises.daily_log_id
              AND daily_logs.user_id = auth.uid()
        )
    );

CREATE INDEX idx_exercises_log
    ON exercises(daily_log_id);

CREATE INDEX idx_exercises_measured
    ON exercises(measured_at);

CREATE INDEX idx_exercises_type
    ON exercises(exercise_type);



-- =========================================================
-- EXERCISE TAGS
-- =========================================================

CREATE TABLE exercise_tags (
    id                  BIGSERIAL PRIMARY KEY,

    exercise_id         BIGINT NOT NULL,
    tag_id              BIGINT NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_exercise_tags_exercise
        FOREIGN KEY (exercise_id)
        REFERENCES exercises(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_exercise_tags_tag
        FOREIGN KEY (tag_id)
        REFERENCES tags(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_exercise_tags
        UNIQUE(exercise_id, tag_id)
);

ALTER TABLE exercise_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "自分のexercise_tagsのみ操作可"
    ON exercise_tags
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM exercises
            JOIN daily_logs ON daily_logs.id = exercises.daily_log_id
            WHERE exercises.id = exercise_tags.exercise_id
              AND daily_logs.user_id = auth.uid()
        )
    );

CREATE INDEX idx_exercise_tags_exercise
    ON exercise_tags(exercise_id);

CREATE INDEX idx_exercise_tags_tag
    ON exercise_tags(tag_id);
```

---

## 設計ポイント

### 1. user_id を UUID 型に統一

Supabase Auth の `auth.uid()` が UUID を返すため、user_id はすべて UUID 型とする。

アプリ独自の users テーブルは廃止し、`user_profiles` テーブルで `auth.users` を参照する。

---

### 2. TIMESTAMP → TIMESTAMPTZ

Supabase（PostgreSQL）はUTCで管理する。

フロントエンド（supabase-js）受け取り時に Asia/Tokyo へ変換して表示する。

```javascript
// フロントエンド側変換例
const date = new Date(row.measured_at);
const jst = date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
```

---

### 3. Row Level Security（RLS）

全テーブルに RLS を有効化する。

GitHub Pages からは `anon key` を使用するため、RLS によるアクセス制御が必須。

`service_role key` はフロントエンドに含めない。

---

### 4. タグのRLS設計

system tag（is_system = TRUE）は全ユーザーが SELECT 可能。

user tag は自分のみ操作可能。

```sql
-- system tagは全ユーザーが参照可
CREATE POLICY "systemタグ参照可"
    ON tags FOR SELECT
    USING (is_system = TRUE);

-- user tagは自分のみ
CREATE POLICY "自分のuserタグのみ操作可"
    ON tags FOR ALL
    USING (auth.uid() = user_id);
```

---

### 5. ON DELETE CASCADE

親削除時に子も消える。

daily_logs 削除 → meals / exercises / body_metrics / daily_log_tags も削除。

---

### 6. NUMERIC型

PFCや体重は float を避ける。

例：84.35kg、P 24.5g などを正確保持。

---

### 7. UNIQUE制約

#### daily_logs

```sql
UNIQUE(user_id, target_date)
```

同一日重複防止。

---

#### tag relation

重複タグ付与防止。

---

### 8. measured_at INDEX

将来の時系列分析・60時間表示・移動平均計算に効く。

---

### 9. meal_type

現時点では VARCHAR。

候補：breakfast / lunch / dinner / snack

ENUM化は後でも可能。

---

### 10. 今後追加しやすいもの

* Supabase RPC関数（集計クエリ）
* AI画像解析連携
* Apple Health連携
* food_history（入力履歴サジェスト用）
* v_daily_summary VIEW
* daily_summary Materialized View
