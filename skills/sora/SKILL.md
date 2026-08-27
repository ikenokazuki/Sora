---
name: sora
description: "High-performance Japanese web scraping, deep search, Yahoo JAPAN integration, real-time X news, weather, transit, disaster, music, and law search CLI & tool suite."
argument-hint: "[search|web|scrape|weather|transit|realtime|news|chiebukuro|traffic|flight|elevation|diet|music|laws|health] [args]"
license: MIT
---

# Sora (空) - Web 検索 & スクレイピング エージェントスキル

Sora は、日本国内の Web 検索、リアルタイム速報 (X / 旧 Twitter)、深層本文スクレイピング、気象庁オープンデータ、乗換案内、道路交通情報、法令検索などを提供する高性能ツールスイートです。

## 🚀 2 つの利用方法

### 1. CLI 経由での直接実行 (Code Execution with CLI: トークン最節約・推奨)
ターミナルから `bin/sora` を直接呼び出すことで、MCP のツール定義によるコンテキスト消費をゼロに抑えて最新データを高速取得できます。

```bash
# 統合深層検索 (Web検索 + 上位本文スクレイプ + X速報を一括取得してプロンプト形式出力)
/home/ikeno/app/web-fetcher/bin/sora search "TypeScript 5.5 新機能" --limit 3 --prompt

# Web 検索 (タイトル・スニペット・URL一覧)
/home/ikeno/app/web-fetcher/bin/sora web "Next.js 15 Server Actions"

# 単一 URL / PDF の Markdown 本文抽出
/home/ikeno/app/web-fetcher/bin/sora scrape "https://example.com/article" --prompt

# 気象庁 天気予報 (市区町村名)
/home/ikeno/app/web-fetcher/bin/sora weather "千代田区"

# Yahoo! 乗換案内
/home/ikeno/app/web-fetcher/bin/sora transit "新宿" "渋谷"

# X (旧 Twitter) リアルタイム速報
/home/ikeno/app/web-fetcher/bin/sora realtime "地震"

# Yahoo! ニュース検索
/home/ikeno/app/web-fetcher/bin/sora news "AI 半導体"

# Yahoo! 知恵袋 Q&A 検索
/home/ikeno/app/web-fetcher/bin/sora chiebukuro "NixOS バッテリー節約"

# JARTIC 道路交通情報
/home/ikeno/app/web-fetcher/bin/sora traffic "東京都" "首都高"

# フライト航空運航状況・欠航・遅延
/home/ikeno/app/web-fetcher/bin/sora flight "羽田"

# 国土地理院 標高 (海抜) & 座標判定
/home/ikeno/app/web-fetcher/bin/sora elevation "東京都千代田区永田町1-7-1"

# 国会会議録 全文検索 (衆参本会議・委員会答弁)
/home/ikeno/app/web-fetcher/bin/sora diet "人工知能"

# iTunes 音楽情報検索
/home/ikeno/app/web-fetcher/bin/sora music "YOASOBI アイドル"

# e-Gov 法令・条文検索
/home/ikeno/app/web-fetcher/bin/sora laws "著作権法 第三十条"

# 米国CPSC適合証明書(GCC/CCC) eFiling義務化判定
/home/ikeno/app/web-fetcher/bin/sora cpsc-check "9503.00.0073" child

# 米国FDA規制対象 簡易判定 (HS Chapter単位)
/home/ikeno/app/web-fetcher/bin/sora fda-check "3004.90.0000"

# HTS/HSコード実在確認・検証 (USITC公式データ照合、製品説明は必須)
/home/ikeno/app/web-fetcher/bin/sora hts-verify "9503.00.0073" "plastic toy car for children"
```

> **HTSコードを推論する際の注意**: キーワード検索によるコードの一意特定はUSITC公式APIの精度上不可能です。素材・用途・機能・加工度合いを踏まえて自分で候補コードを推論してから `hts-verify` で実在確認・関税率取得を行ってください（`productDescription` にその根拠を必ず記載する）。

### 2. MCP (Model Context Protocol) 経由での利用 (動的ツール発見 `search_tools`)
Sora MCP サーバー (`http://127.0.0.1:3016/mcp`) は、コンテキスト最適化のために初期状態では以下の **4 つのコアツール** のみを露出しています。

- `scrape`: 単一 URL / PDF の本文 Markdown 抽出
- `search_web`: 基本 Web 検索 (URL・タイトル一覧)
- `search_deep`: 深層統合検索 (上位サイト本文一括取得 + X速報)
- `search_tools`: 専門ツールの動的検索・有効化 (メタツール)

#### 専門ツールが必要な場合:
1. `search_tools({ query: "天気" })` または `search_tools({ query: "知恵袋" })` を呼び出す。
2. 該当ツール (`get_weather`, `search_chiebukuro` 等) がセッション内で自動有効化される。
3. 有効化されたツールを通常通り呼び出す。

## 💡 トークン節約と高品質回答のベストプラクティス

1. **検索と本文取得を1往復で済ませる場合**:
   - `search_deep` (または `sora search "<query>" --limit 3`) を使用。検索結果一覧と上位本文が最初から結合されて返るため、個別に `scrape` を複数回叩く必要がありません。
2. **URL の確認や候補の絞り込みのみ必要な場合**:
   - `search_web` (または `sora web "<query>"`) を使用。
3. **生の声・世間の反応・障害情報を調べる場合**:
   - `realtime` (または `sora realtime "<query>"`) を使用。
4. **LLM へのコンテキスト注入**:
   - CLI の `--prompt` オプションを使用すると、`<article>` や `<citation>` で構造化された XML コンテキストとして返却されます。
