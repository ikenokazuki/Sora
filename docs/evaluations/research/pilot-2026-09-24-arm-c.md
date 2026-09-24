# 試行のC腕: 外部検索のみ（2026-09-24 10:15–10:20Z頃）

順序5（A/B/C切り分け）の先行記録。Yahoo上流の429嵐でSora側の再測定が止まったため、外部検索（Tavily、直近週）のみを先に実行した。1問1クエリ、各5件。正確な開始終了時刻は未記録のため、時刻の厳密な比較には使わない。

| ケース | クエリ | 結果 |
| --- | --- | --- |
| KR-marketing | Seoul Korea fire mourning September 2026 cafe boycott | 雑音のみ。0/2 |
| CN-marketing | Shanghai fashion brand controversy boycott September 2026 | 雑音のみ。文化要件の2018年報道には週範囲で届かず。0/2 |
| ID-travel | Jakarta airport Anak Krakatau earthquake September 2026 | Tempoの9/21警報引下げ報道でaviation支持。quakeはなし。1/2 |
| GB-finance | Bank of England base rate decision September 2026 | 3.75%据置（9/17、6対3）を複数・BoE頁で確認しvalue支持。timeは発表日9/17のみで適用日の明示なしのため不採用。1/2 |

合計2/8。要件充足と取得状態の分離、支持の根拠対応はpilot-2026-09-24-evidence.mdの運用に従う。Sora側のA/B再測定と突き合わせる前の単独記録であり、腕間の優劣は主張しない。
