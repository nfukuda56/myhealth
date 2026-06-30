#!/usr/bin/env python3
"""
Apple Health export.xml → Supabase 取込スクリプト v2（部分置換+RPC方式）
================================================
対象データ:
  - 体重          (HKQuantityTypeIdentifierBodyMass)          ← TANITA Record のみ
  - 体脂肪率      (HKQuantityTypeIdentifierBodyFatPercentage) ← TANITA Record のみ
  - ワークアウト  (HKWorkout)                                 ← Runkeeper のみ
      - 種別・時間・消費kcal・距離(km)

除外するデータ:
  - 基礎代謝（手入力運用のため除外）
  - iPhone / その他source由来のRecord
  - Nike Run Club のワークアウト
  - 5分未満のワークアウト

v2 変更点（部分置換+RPC方式）:
  - Supabase RPC import_apple_health を1回呼ぶだけ（単一トランザクション）
  - daily_logs は削除せず不足日のみ追加 → meals は完全保護
  - body_metrics / exercises は source='apple_health' のみ置換
  - 途中エラー時はDB側で自動ロールバック（データ消失なし）
  - body_metrics は計測時刻(measured_at)単位で保持（同日複数計測対応）

使い方:
  pip install requests pytz
  python import_apple_health.py [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run] [--scan]
  python import_apple_health.py --scan          # ソース一覧だけ確認（XMLを変更しない）
"""

import re
import argparse
import sys
from datetime import datetime, date, timedelta
from pathlib import Path
import requests

try:
    from zoneinfo import ZoneInfo
    JST = ZoneInfo("Asia/Tokyo")
    def to_jst(dt):
        return dt.astimezone(JST)
except ModuleNotFoundError:
    import pytz
    JST = pytz.timezone("Asia/Tokyo")
    def to_jst(dt):
        if dt.tzinfo is None:
            return JST.localize(dt)
        return dt.astimezone(JST)

# ── 設定 ────────────────────────────────────────────────────
SUPABASE_URL = "https://lvmgfolwipwgyhhzskvj.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2bWdmb2x3aXB3Z3loaHpza3ZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMzgxMjQsImV4cCI6MjA5NTkxNDEyNH0"
    ".jrnrNWLZDQg2mscPqI-UPg9JrQZhXFkJVELl1TG43Gk"
)
EXPORT_XML = Path("export.xml")
MIN_WORKOUT_DURATION_MIN = 5

# Record取込 sourceホワイトリスト（部分一致）TANITAのみ対象
RECORD_SOURCE_WHITELIST = [
    "TANITA Record",
]
def is_record_source(name):
    return any(w in name for w in RECORD_SOURCE_WHITELIST)

# ワークアウト対象sourceホワイトリスト（部分一致）
# 空リスト = 全ソース対象（ブラックリストのみで制御）
WORKOUT_SOURCE_WHITELIST = [
    "Runkeeper",
]

# ワークアウト除外sourceブラックリスト（部分一致）
# WORKOUT_SOURCE_WHITELIST が空の場合に有効
WORKOUT_SOURCE_BLACKLIST = [
    "Nike Run Club",
]

# ── Apple Health 型識別子 ────────────────────────────────────
HK_BODY_MASS    = "HKQuantityTypeIdentifierBodyMass"
HK_BODY_FAT     = "HKQuantityTypeIdentifierBodyFatPercentage"
HK_BASAL_ENERGY = "HKQuantityTypeIdentifierBasalEnergyBurned"
HK_DISTANCE     = "HKQuantityTypeIdentifierDistanceWalkingRunning"
HK_ACTIVE_KCAL  = "HKQuantityTypeIdentifierActiveEnergyBurned"

WORKOUT_TYPE_MAP = {
    "HKWorkoutActivityTypeRunning":                       "ランニング",
    "HKWorkoutActivityTypeWalking":                       "ウォーキング",
    "HKWorkoutActivityTypeCycling":                       "サイクリング",
    "HKWorkoutActivityTypeSwimming":                      "水泳",
    "HKWorkoutActivityTypeTraditionalStrengthTraining":   "筋トレ",
    "HKWorkoutActivityTypeFunctionalStrengthTraining":    "筋トレ",
    "HKWorkoutActivityTypeHighIntensityIntervalTraining": "HIIT",
    "HKWorkoutActivityTypeYoga":                          "ヨガ",
    "HKWorkoutActivityTypeStairs":                        "階段",
    "HKWorkoutActivityTypeElliptical":                    "エリプティカル",
    "HKWorkoutActivityTypeRowing":                        "ローイング",
    "HKWorkoutActivityTypePilates":                       "ピラティス",
    "HKWorkoutActivityTypeDance":                         "ダンス",
    "HKWorkoutActivityTypeHiking":                        "ハイキング",
    "HKWorkoutActivityTypeOther":                         "その他",
}


# ── ユーティリティ ───────────────────────────────────────────
def attr(text, name):
    """テキストから属性値を抽出"""
    m = re.search(r'\b' + name + r'="([^"]*)"', text)
    return m.group(1) if m else None

def parse_hk_datetime(s):
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S"):
        try:
            return to_jst(datetime.strptime(s, fmt))
        except ValueError:
            continue
    raise ValueError("日時パース失敗: " + s)

def to_target_date(dt):
    return (to_jst(dt) - timedelta(hours=4)).date()

def to_iso(dt):
    return to_jst(dt).isoformat()

def safe_float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default

def is_workout_source(name):
    """
    ホワイトリストが空の場合はブラックリスト方式で判定。
    ホワイトリストに値がある場合はホワイトリスト方式で判定。
    """
    if WORKOUT_SOURCE_WHITELIST:
        return any(w in name for w in WORKOUT_SOURCE_WHITELIST)
    else:
        return not any(b in name for b in WORKOUT_SOURCE_BLACKLIST)


# ── ソーススキャン ───────────────────────────────────────────
def scan_sources(xml_path):
    """
    export.xml に含まれる全ワークアウトのsourceName一覧をカウント付きで表示。
    現在のホワイトリスト/ブラックリスト設定での取込可否も表示する。
    """
    print("🔍 ワークアウトソースをスキャン中: %s" % xml_path)
    source_counts = {}   # sourceName -> count
    type_by_source = {}  # sourceName -> set of workoutActivityType

    in_workout  = False
    workout_buf = []

    with open(str(xml_path), encoding='utf-8') as f:
        for line in f:
            if '<Workout ' in line:
                in_workout  = True
                workout_buf = [line]
                if '</Workout>' in line:
                    _scan_workout_block(workout_buf, source_counts, type_by_source)
                    in_workout  = False
                    workout_buf = []
                continue
            if in_workout:
                workout_buf.append(line)
                if '</Workout>' in line:
                    _scan_workout_block(workout_buf, source_counts, type_by_source)
                    in_workout  = False
                    workout_buf = []

    if not source_counts:
        print("⚠️  ワークアウトデータが見つかりませんでした")
        return

    print("\n📋 ワークアウト sourceName 一覧（件数順）:")
    print("  %6s  %-40s  %s  %s" % ("件数", "sourceName", "取込", "ワークアウト種別"))
    print("  " + "-"*90)

    for src, cnt in sorted(source_counts.items(), key=lambda x: -x[1]):
        will_import = "✅" if is_workout_source(src) else "❌"
        types = ", ".join(sorted(type_by_source.get(src, set())))
        print("  %6d  %-40s  %s   %s" % (cnt, src, will_import, types))

    print()
    if WORKOUT_SOURCE_WHITELIST:
        print("  現在の設定: ホワイトリスト方式  %s" % WORKOUT_SOURCE_WHITELIST)
    else:
        print("  現在の設定: ブラックリスト方式  除外=%s" % WORKOUT_SOURCE_BLACKLIST)
    print("  （WORKOUT_SOURCE_WHITELIST / WORKOUT_SOURCE_BLACKLIST で変更可）")


def _scan_workout_block(buf, source_counts, type_by_source):
    block = ''.join(buf)
    src   = attr(block, 'sourceName') or '(unknown)'
    wtype = attr(block, 'workoutActivityType') or 'Unknown'
    etype = WORKOUT_TYPE_MAP.get(wtype, wtype.replace('HKWorkoutActivityType', ''))
    source_counts[src] = source_counts.get(src, 0) + 1
    type_by_source.setdefault(src, set()).add(etype)


# ── XML パース（正規表現ベース・ブロック処理）───────────────
def parse_export(xml_path, date_from=None, date_to=None):
    print("📂 %s を読み込み中..." % xml_path)

    bm_by_time    = {}  # measured_at(ISO) -> {weight_kg, body_fat_pct}  ※同日複数計測対応
    exercises     = []
    record_count  = 0

    in_workout  = False
    workout_buf = []

    with open(str(xml_path), encoding='utf-8') as f:
        for line in f:

            # ── Workout ブロック収集 ──────────────────────────
            if '<Workout ' in line:
                in_workout  = True
                workout_buf = [line]
                if '</Workout>' in line:
                    _process_workout_block(workout_buf, exercises, date_from, date_to)
                    in_workout  = False
                    workout_buf = []
                continue

            if in_workout:
                workout_buf.append(line)
                if '</Workout>' in line:
                    _process_workout_block(workout_buf, exercises, date_from, date_to)
                    in_workout  = False
                    workout_buf = []
                continue

            # ── Record（1行完結）────────────────────────────
            if '<Record ' not in line:
                continue

            rtype       = attr(line, 'type')
            source_name = attr(line, 'sourceName') or ''
            raw_start   = attr(line, 'startDate') or attr(line, 'creationDate')
            if not rtype or not raw_start:
                continue

            # TANITAホワイトリスト外のRecordは除外
            if not is_record_source(source_name):
                continue

            try:
                dt = parse_hk_datetime(raw_start)
            except Exception:
                continue

            td = to_target_date(dt)
            if date_from and td < date_from: continue
            if date_to   and td > date_to:   continue

            if rtype == HK_BODY_MASS:
                val  = safe_float(attr(line, 'value'))
                unit = attr(line, 'unit') or 'kg'
                if unit == 'lb':
                    val = round(val * 0.453592, 2)
                rec = bm_by_time.setdefault(to_iso(dt), {})
                rec['weight_kg'] = round(val, 2)

            elif rtype == HK_BODY_FAT:
                val = round(safe_float(attr(line, 'value')) * 100, 2)
                rec = bm_by_time.setdefault(to_iso(dt), {})
                rec['body_fat_pct'] = val

            record_count += 1
            if record_count % 100000 == 0:
                print("  ... %d レコード処理済み" % record_count)

    # body_metrics 行リスト生成（TANITAデータのみ・計測時刻単位）
    body_metrics = []
    for measured_at in sorted(bm_by_time.keys()):
        rec = bm_by_time[measured_at]
        body_metrics.append({
            'measured_at':  measured_at,
            'weight_kg':    rec.get('weight_kg'),
            'body_fat_pct': rec.get('body_fat_pct'),
            'source':       'apple_health',
        })

    # 運動種別サマリー
    etype_count = {}
    for e in exercises:
        etype_count[e['exercise_type']] = etype_count.get(e['exercise_type'], 0) + 1

    print("✅ パース完了:")
    print("   body_metrics %d件 (体重%d / 体脂肪率%d)" % (
        len(body_metrics),
        sum(1 for r in body_metrics if r.get('weight_kg')),
        sum(1 for r in body_metrics if r.get('body_fat_pct')),
    ))
    print("   exercises %d件:" % len(exercises))
    for k, v in sorted(etype_count.items(), key=lambda x: -x[1]):
        print("     %4d件  %s" % (v, k))

    return body_metrics, exercises


def _process_workout_block(buf, exercises, date_from, date_to):
    """Workoutブロック（複数行リスト）を正規表現でパース"""
    block = ''.join(buf)

    source_name = attr(block, 'sourceName') or ''

    # ホワイトリスト/ブラックリスト判定
    if not is_workout_source(source_name):
        return

    raw_start = attr(block, 'startDate')
    if not raw_start:
        return

    try:
        dt_start = parse_hk_datetime(raw_start)
    except Exception:
        return

    td = to_target_date(dt_start)
    if date_from and td < date_from: return
    if date_to   and td > date_to:   return

    duration_val  = safe_float(attr(block, 'duration'))
    duration_unit = attr(block, 'durationUnit') or 'min'
    if duration_unit == 'min':
        duration_min = int(round(duration_val))
    else:
        duration_min = int(round(duration_val / 60))
    if duration_min < MIN_WORKOUT_DURATION_MIN:
        return

    wtype = attr(block, 'workoutActivityType') or 'HKWorkoutActivityTypeOther'
    etype = WORKOUT_TYPE_MAP.get(wtype, wtype.replace('HKWorkoutActivityType', ''))

    # WorkoutStatistics を正規表現で全取得（複数行にまたがる場合も対応）
    burned      = None
    distance_km = None
    for stat in re.finditer(r'<WorkoutStatistics\s.*?/>', block, re.DOTALL):
        stat_block = stat.group(0)
        stat_type  = attr(stat_block, 'type') or ''
        if stat_type == HK_ACTIVE_KCAL:
            burned = int(round(safe_float(attr(stat_block, 'sum'))))
        elif stat_type == HK_DISTANCE:
            distance_km = round(safe_float(attr(stat_block, 'sum')), 3)

    exercises.append({
        'measured_at':   to_iso(dt_start),
        'exercise_type': etype,
        'duration_min':  duration_min or None,
        'burned_kcal':   burned,
        'distance_km':   distance_km,
        'source':        'apple_health',
        'source_type':   source_name,
        'note':          None,
    })


# ── RPC呼び出し（部分置換・単一トランザクション）──────────────
def call_import_rpc(body_metrics, exercises, dry_run):
    """
    Supabase RPC import_apple_health を呼び出す。
    DB側で以下を1トランザクションで実行:
      ① daily_logs 不足日のみ追加（既存・mealsは無傷）
      ② source='apple_health' の body_metrics / exercises を削除
      ③ 新データINSERT（daily_log_id解決込み）
    エラー時は全ロールバック。
    """
    if dry_run:
        print("  [DRY-RUN] RPC import_apple_health:")
        print("    body_metrics %d件 / exercises %d件" % (len(body_metrics), len(exercises)))
        dates = set()
        for r in body_metrics + exercises:
            dates.add(to_target_date(parse_hk_datetime(r['measured_at'])))
        print("    対象 target_date: %d日分 (%s 〜 %s)" % (
            len(dates), min(dates), max(dates)))
        return None

    resp = requests.post(
        SUPABASE_URL + "/rest/v1/rpc/import_apple_health",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
        },
        json={
            "p_body_metrics": body_metrics,
            "p_exercises":    exercises,
        },
        timeout=120,
    )
    if not resp.ok:
        print("  ❌ RPC エラー: " + resp.text[:500])
        return None
    return resp.json()


# ── メイン ───────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Apple Health → Supabase 取込")
    parser.add_argument("--xml",     default=str(EXPORT_XML))
    parser.add_argument("--from",    dest="date_from", default=None)
    parser.add_argument("--to",      dest="date_to",   default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--scan",    action="store_true",
                        help="XMLに含まれるワークアウトのsourceName一覧を表示して終了")
    args = parser.parse_args()

    xml_path  = Path(args.xml)

    if not xml_path.exists():
        print("❌ ファイルが見つかりません: " + str(xml_path)); sys.exit(1)

    # --scan: ソース一覧を表示して終了（--dry-run と組み合わせ可能だが単独でも動作）
    if args.scan:
        scan_sources(xml_path)
        sys.exit(0)

    date_from = date.fromisoformat(args.date_from) if args.date_from else None
    date_to   = date.fromisoformat(args.date_to)   if args.date_to   else None

    if args.dry_run:
        print("🔍 DRY-RUNモード\n")
    if date_from or date_to:
        print("📅 フィルター: %s 〜 %s\n" % (date_from or "開始なし", date_to or "終了なし"))
    else:
        print("📅 フィルター: なし（全件取込）\n")

    body_metrics, exercises = parse_export(xml_path, date_from, date_to)
    if not body_metrics and not exercises:
        print("⚠️  取込対象なし"); sys.exit(0)

    print("\n📥 RPC import_apple_health を実行中（部分置換・単一トランザクション）...")
    result = call_import_rpc(body_metrics, exercises, args.dry_run)

    print("\n" + "="*50)
    if args.dry_run:
        print("✅ DRY-RUN 完了（書き込みなし）")
    elif result:
        print("✅ 取込完了")
        print("   daily_logs 新規追加      : %d件" % result.get('new_daily_logs', 0))
        print("   body_metrics 置換        : 削除%d件 → 挿入%d件" % (
            result.get('deleted_body_metrics', 0),
            result.get('inserted_body_metrics', 0)))
        print("   exercises 置換           : 削除%d件 → 挿入%d件" % (
            result.get('deleted_exercises', 0),
            result.get('inserted_exercises', 0)))
        print("   meals daily_log_id 補完  : %d件" % result.get('backfilled_meal_logs', 0))
        print("   ※ meals の内容・手入力データは無変更")
    else:
        print("❌ 取込失敗（DBはロールバック済み・データ無傷）")
        sys.exit(1)
    print("="*50)

if __name__ == "__main__":
    main()
