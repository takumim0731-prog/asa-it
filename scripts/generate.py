"""
毎朝のカードを作るスクリプト

流れ:
  1. 複数サイトのRSSから最近の記事を集める
  2. Claudeに「3本選んで、要約・工場目線・ベンダーへの質問・クイズを作って」と頼む
  3. 結果を data/YYYY-MM-DD.json に保存し、日付一覧 data/index.json を更新する

使い方（プロジェクトのフォルダで実行）:
  python scripts/generate.py            ← 本番（APIを呼ぶ。数十円かかる）
  python scripts/generate.py --dry-run  ← 記事集めだけ確認（APIは呼ばない。無料）
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windowsの証明書ストアを使ってHTTPS通信する（SSLエラー対策）
import truststore
truststore.inject_into_ssl()

import anthropic
import feedparser
from dotenv import load_dotenv

# ===== 設定（ここを変えれば挙動が変わる） =====

MODEL = "claude-opus-5-5"   # 安くしたいときは "claude-haiku-5-5" に変える
# 出題分野と1日の枚数は config.json で決める（設定画面から変更できる）
MAX_CARDS = 5               # 1日の枚数の上限（出力が長くなりすぎないように）
HOURS_BACK = 72             # 何時間前までの記事を候補にするか（週末も候補が集まるよう長め）
MAX_PER_SOURCE = 10         # 1サイトあたりの候補数の上限（費用を抑えるため）
DEDUP_DAYS = 7              # 過去何日分のカードと記事がかぶらないようにするか

FEEDS = {
    "MONOist": "https://rss.itmedia.co.jp/rss/2.0/monoist.xml",
    "ITmedia NEWS": "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml",
    "ITmedia エンタープライズ": "https://rss.itmedia.co.jp/rss/2.0/enterprise.xml",
    "@IT": "https://rss.itmedia.co.jp/rss/2.0/ait.xml",
    "Publickey": "https://www.publickey1.jp/atom.xml",
    "IPA": "https://www.ipa.go.jp/security/alert-rss.rdf",
    "JPCERT/CC": "https://www.jpcert.or.jp/rss/jpcert.rdf",
}

ROOT = Path(__file__).resolve().parent.parent   # プロジェクトのフォルダ
DATA_DIR = ROOT / "data"
JST = timezone(timedelta(hours=9))              # 日本時間

# 全分野と、その中身の説明（設定画面と共通のファイル。説明はClaudeが分類に迷わないためにプロンプトへ入れる）
CATEGORY_GUIDE: dict[str, str] = json.loads((ROOT / "categories.json").read_text(encoding="utf-8"))


def load_config() -> tuple[list[str], int]:
    """config.json から「出題分野」と「1日の枚数」を読む。
    ファイルがない・中身がおかしいときは、全分野・3枚にする（毎朝の自動実行を止めないため）"""
    try:
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        config = {}

    categories = [c for c in config.get("categories", []) if c in CATEGORY_GUIDE]
    if not categories:
        categories = list(CATEGORY_GUIDE)

    try:
        count = int(config.get("cards_per_day", 3))
    except (TypeError, ValueError):
        count = 3
    count = min(max(count, 1), MAX_CARDS)   # 1〜MAX_CARDS の範囲に収める
    return categories, count


# ===== 1. 記事を集める =====

def strip_html(text: str) -> str:
    """RSSの説明文に混ざっているHTMLタグを取り除く"""
    return re.sub(r"<[^>]+>", "", text or "").strip()


def recent_used_urls(today: str) -> set[str]:
    """過去数日のカードで使った記事のURLを集める（同じ記事を繰り返さないため）
    今日のファイルは上書きされるので対象外にする（同じ日に作り直したとき、同じ記事も選べるように）"""
    used = set()
    past = [p for p in sorted(DATA_DIR.glob("????-??-??.json")) if p.stem != today]
    for path in past[-DEDUP_DAYS:]:
        day = json.loads(path.read_text(encoding="utf-8"))
        used.update(card["url"] for card in day["cards"])
    return used


def collect_articles(today: str) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS_BACK)
    used = recent_used_urls(today)
    articles = []

    for source, url in FEEDS.items():
        feed = feedparser.parse(url)
        if not feed.entries:
            print(f"  ⚠ {source}: 取得できませんでした（{feed.get('bozo_exception')}）")
            continue

        count = 0
        for entry in feed.entries:
            # 公開日時が取れる記事は、古すぎるものを除外する
            published = entry.get("published_parsed") or entry.get("updated_parsed")
            if published and datetime(*published[:6], tzinfo=timezone.utc) < cutoff:
                continue
            if entry.get("link") in used:
                continue

            articles.append({
                "id": len(articles),   # Claudeに番号で選んでもらうための通し番号
                "source": source,
                "title": entry.get("title", ""),
                "url": entry.get("link", ""),
                "description": strip_html(entry.get("summary", ""))[:300],
            })
            count += 1
            if count >= MAX_PER_SOURCE:
                break
        print(f"  {source}: {count}件")

    return articles


# ===== 2. Claudeにカードを作ってもらう =====

SYSTEM_PROMPT = """\
あなたは、製造業（セラミックスメーカー）の社内IT部門で働く若手社員のための、ITニュース解説者です。

読み手のプロフィール:
- IT歴2年目。基本情報技術者を取得済みで、応用情報技術者レベルの知識を身につけたい（試験を受けるわけではない）
- 業務は工場向けシステム（生産管理、MES、設備連携）の要件定義・基本設計とベンダーコントロールが中心で、自分でコードは書かない
- インフラ、AI、クラウド、セキュリティ、開発手法、業界動向など、技術全般に苦手意識があり、上司やベンダーの話についていけないことがある

カードの作り方:
- summary: 記事の要点を3文程度で。記事の情報にないことを事実として書かない。専門用語には短い補足を付ける
- factory_view: このニュースが工場の社内ITにどう関係するか。具体的な場面を挙げ、背景となる技術の仕組みもやさしく説明する
- vendor_question: 打ち合わせでそのまま使える質問を1つ。理由も一言添える
- quiz: 応用情報技術者レベルの知識を確かめる4択問題。ニュースの内容そのものではなく、背景となる技術・用語・考え方を問う。
  計算が必要な問題（稼働率、容量、伝送時間、費用などを数値で求めるもの）は出さず、用語の意味・仕組み・使い分け・適切な対応を問う。
  正解以外の選択肢も、もっともらしいものにする。explanationでは正解の理由と、他の選択肢がなぜ違うかを説明する
- 文体は親しみやすい「です・ます」調。上から目線にならないように
"""


def card_schema(categories: list[str]) -> dict:
    """Claudeに返してほしいJSONの形（構造化出力）。この形以外は返ってこない。
    category は設定で選ばれた分野の中からしか選べないようにする"""
    return {
        "type": "object",
        "properties": {
            "cards": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "article_id": {"type": "integer"},
                        "category": {"type": "string", "enum": categories},
                        "headline": {"type": "string"},
                        "summary": {"type": "string"},
                        "factory_view": {"type": "string"},
                        "vendor_question": {"type": "string"},
                        "quiz": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "choices": {"type": "array", "items": {"type": "string"}},
                                "answer_index": {"type": "integer"},
                                "explanation": {"type": "string"},
                            },
                            "required": ["question", "choices", "answer_index", "explanation"],
                            "additionalProperties": False,
                        },
                    },
                    "required": ["article_id", "category", "headline", "summary",
                                 "factory_view", "vendor_question", "quiz"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["cards"],
        "additionalProperties": False,
    }


def make_cards(articles: list[dict], categories: list[str], count: int) -> list[dict]:
    client = anthropic.Anthropic()   # APIキーは環境変数 ANTHROPIC_API_KEY から読まれる

    candidates = "\n".join(
        f"[{a['id']}] ({a['source']}) {a['title']}\n    {a['description']}" for a in articles
    )
    category_list = "\n".join(f"- {name}: {CATEGORY_GUIDE[name]}" for name in categories)
    user_prompt = f"""\
以下は今日のITニュース候補です。この中から{count}本を選び、カードを作ってください。

選び方:
- 読み手が上司やベンダーとの会話についていけるようになることを最優先にする
- 読み手が選んだ分野（下記）に当てはまるニュースだけを選ぶ。複数の分野があるときは、なるべくばらけさせる
- 工場・製造業のITに関係するものを優先する
- 単なる新製品の宣伝や、ITとの関係が薄いニュースは避ける
- quizのchoicesは必ず4つにし、answer_indexは0〜3で指定する

読み手が選んだ分野（categoryはこの中から選ぶ）:
{category_list}

候補:
{candidates}
"""

    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
        output_config={
            "effort": "medium",
            "format": {"type": "json_schema", "schema": card_schema(categories)},
        },
        # 万一、安全上の理由で断られたときに、自動で別のモデルが引き継ぐ設定
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )

    if response.stop_reason == "refusal":
        sys.exit("Claudeが回答を断りました。候補記事を変えて再実行してください。")
    if response.stop_reason == "max_tokens":
        sys.exit("出力が長すぎて途中で切れました。max_tokensを増やしてください。")

    text = next(block.text for block in response.content if block.type == "text")
    raw_cards = json.loads(text)["cards"]

    # 費用の目安を表示（料金表: Opus 5.5 は入力$4・出力$20 / 100万トークン）
    usage = response.usage
    print(f"  使用トークン: 入力 {usage.input_tokens:,} / 出力 {usage.output_tokens:,}")

    # article_id を使って、URLやタイトルは元の記事データから正確に埋める
    by_id = {a["id"]: a for a in articles}
    cards = []
    for c in raw_cards:
        article = by_id.get(c.pop("article_id"))
        if article is None or len(c["quiz"]["choices"]) != 4 or not 0 <= c["quiz"]["answer_index"] <= 3:
            print("  ⚠ 形式がおかしいカードを1枚スキップしました")
            continue
        cards.append({
            "source": article["source"],
            "title": article["title"],
            "url": article["url"],
            **c,
        })
    return cards


# ===== 3. 保存する =====

def save(cards: list[dict], today: str) -> Path:
    DATA_DIR.mkdir(exist_ok=True)
    path = DATA_DIR / f"{today}.json"
    data = {"date": today, "model": MODEL, "cards": cards}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # 画面側が「どの日のデータがあるか」を知るための一覧（新しい順）
    dates = sorted((p.stem for p in DATA_DIR.glob("????-??-??.json")), reverse=True)
    (DATA_DIR / "index.json").write_text(
        json.dumps({"dates": dates}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path


def main():
    load_dotenv(ROOT / ".env")   # .env ファイルがあれば、そこからAPIキーを読む
    dry_run = "--dry-run" in sys.argv
    today = datetime.now(JST).strftime("%Y-%m-%d")
    categories, count = load_config()
    print(f"設定: {count}枚 / 分野 {'・'.join(categories)}")

    print("① 記事を集めています…")
    articles = collect_articles(today)
    print(f"  → 候補は合計 {len(articles)} 件")
    if len(articles) < count:
        sys.exit("候補記事が少なすぎます。")

    if dry_run:
        for a in articles:
            print(f"  [{a['id']}] ({a['source']}) {a['title']}")
        print("（--dry-run なので、ここで終了します）")
        return

    print(f"② {MODEL} でカードを作っています…（1〜2分かかります）")
    cards = make_cards(articles, categories, count)

    print("③ 保存しています…")
    path = save(cards, today)
    print(f"完了！ {path} に {len(cards)} 枚保存しました")
    for c in cards:
        print(f"  ・[{c['category']}] {c['headline']}")


if __name__ == "__main__":
    main()
