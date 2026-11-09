import { describe, it, expect } from 'bun:test';
import {
  extractTemporalAnchors,
  annotateTextWithTemporalAnchors,
} from './temporal_anchor.js';

describe('Temporal Context Anchor', () => {
  const referenceDate = '2026-09-01T12:00:00Z'; // 2026年9月1日 (火曜日)

  it('「明日」「昨日」「明後日」の相対日時を正確に解決すること', () => {
    const text = '明日の10時から発売開始。昨日の告知をご覧ください。明後日には終了します。';
    const anchors = extractTemporalAnchors(text, referenceDate);

    const anchorMap = new Map(anchors.map((a) => [a.expression, a.resolvedDate]));
    expect(anchorMap.get('明日')).toBe('2026-09-02');
    expect(anchorMap.get('昨日')).toBe('2026-08-31');
    expect(anchorMap.get('明後日')).toBe('2026-09-03');
  });

  it('「3日前」「5日後」等の日次オフセットを正確に解決すること', () => {
    const text = '3日前に発表された新製品について、5日後に詳細仕様が公開されます。';
    const anchors = extractTemporalAnchors(text, referenceDate);

    const anchorMap = new Map(anchors.map((a) => [a.expression, a.resolvedDate]));
    expect(anchorMap.get('3日前')).toBe('2026-08-29');
    expect(anchorMap.get('5日後')).toBe('2026-09-06');
  });

  it('「来週金曜日」「今週の日曜」の曜日指定を正確に解決すること', () => {
    // 2026-09-01 は火曜日。
    // 来週金曜日: 2026-09-11 (金)
    // 今週の日曜: 2026-09-06 (日)
    const text = '来週金曜日にアップデートを実施予定。今週の日曜には事前メンテナンスを行います。';
    const anchors = extractTemporalAnchors(text, referenceDate);

    const anchorMap = new Map(anchors.map((a) => [a.expression, a.resolvedDate]));
    expect(anchorMap.get('来週金曜日')).toBe('2026-09-11');
    expect(anchorMap.get('今週の日曜')).toBe('2026-09-06');
  });

  it('annotateTextWithTemporalAnchors で決定論的なインライン注記を付与すること', () => {
    const text = '明日10時よりチケット発売。来週金曜日に開演。';
    const annotated = annotateTextWithTemporalAnchors(text, referenceDate);

    expect(annotated).toContain('明日 [2026-09-02]10時よりチケット発売');
    expect(annotated).toContain('来週金曜日 [2026-09-11]に開演');
  });

  it('リンクと画像の飛び先 ](…) には注記を入れず、リンクの文字・alt・地の文には入れること', () => {
    const text = [
      '[明日があるさ](https://ja.wikipedia.org/wiki/明日があるさ)',
      '![明日の図](https://example.com/明日.png)',
      '[明日](https://ja.wikipedia.org/wiki/明日_(曖昧さ回避) "明日の題")',
      '明日は晴れ。',
    ].join('\n');
    expect(annotateTextWithTemporalAnchors(text, referenceDate)).toBe([
      '[明日 [2026-09-02]があるさ](https://ja.wikipedia.org/wiki/明日があるさ)',
      '![明日 [2026-09-02]の図](https://example.com/明日.png)',
      '[明日 [2026-09-02]](https://ja.wikipedia.org/wiki/明日_(曖昧さ回避) "明日の題")',
      '明日 [2026-09-02]は晴れ。',
    ].join('\n'));
    // 飛び先の中だけにある表現には、注記が付かない（元の文字列のまま）
    const onlyInDestination = '[記事](https://example.com/3日前の記事)';
    expect(annotateTextWithTemporalAnchors(onlyInDestination, referenceDate)).toBe(onlyInDestination);
  });

  it('相対時間表現がない場合は元のテキストをそのまま返すこと', () => {
    const text = '2026年9月15日に正式リリースされます。';
    const anchors = extractTemporalAnchors(text, referenceDate);
    expect(anchors).toEqual([]);
    expect(annotateTextWithTemporalAnchors(text, referenceDate)).toBe(text);
  });
  it('来月・先月・再来月は、移した先の月に同じ日がなければその月の末日にする（あふれて次の月にしない）', () => {
    const at = (ref: string, word: string) => extractTemporalAnchors(word, ref)[0]?.resolvedDate;
    expect(at('2026-01-31T12:00:00', '来月')).toBe('2026-02-28');
    expect(at('2024-01-31T12:00:00', '来月')).toBe('2024-02-29');
    expect(at('2026-03-31T12:00:00', '先月')).toBe('2026-02-28');
    expect(at('2026-12-31T12:00:00', '来月')).toBe('2027-01-31');
    expect(at('2026-01-01T12:00:00', '先月')).toBe('2025-12-01');
    expect(at('2026-11-30T12:00:00', '再来月')).toBe('2027-01-30');
    expect(at('2026-12-31T12:00:00', '再来月')).toBe('2027-02-28');
    expect(at('2026-08-31T12:00:00', '来月')).toBe('2026-09-30');
    expect(at('2026-09-15T12:00:00', '来月')).toBe('2026-10-15');
    expect(at('2026-01-31T12:00:00', '今月')).toBe('2026-01-31');
  });

  it('「一昨日」は 2 日前だけにして、中の「昨日」を別に 1 日前として拾わない', () => {
    const anchors = extractTemporalAnchors('一昨日の試合結果。', referenceDate);
    expect(anchors.map((a) => [a.expression, a.resolvedDate])).toEqual([['一昨日', '2026-08-30']]);
    expect(annotateTextWithTemporalAnchors('一昨日の試合結果。', referenceDate)).toBe('一昨日 [2026-08-30]の試合結果。');
    // 単独の「昨日」は今まで通り 1 日前。両方あれば別々に注記する
    expect(annotateTextWithTemporalAnchors('一昨日と昨日の結果。', referenceDate)).toBe('一昨日 [2026-08-30]と昨日 [2026-08-31]の結果。');
    // 「おととい」が先に出て「一昨日」が分かれて出ても、「一昨日」の中の「昨日」には 1 日前を付けない
    expect(annotateTextWithTemporalAnchors('おとといと一昨日と昨日。', referenceDate)).toBe('おととい [2026-08-30]と一昨日と昨日 [2026-08-31]。');
  });

  it('「当日券」「当日精算」「当日受付」「当日払い」「当日料金」の「当日」は日付ではない。単独の「当日」は今まで通り基準の日', () => {
    for (const compound of ['当日券', '当日精算', '当日受付', '当日払い', '当日料金']) {
      expect(extractTemporalAnchors(`${compound}あり。`, referenceDate)).toEqual([]);
      expect(annotateTextWithTemporalAnchors(`${compound}あり。`, referenceDate)).toBe(`${compound}あり。`);
    }
    expect(extractTemporalAnchors('当日は雨でした。', referenceDate).map((a) => [a.expression, a.resolvedDate])).toEqual([['当日', '2026-09-01']]);
    // 同じ本文に両方あれば、複合語の側には注記を入れない
    expect(annotateTextWithTemporalAnchors('当日券は当日18時から。', referenceDate)).toBe('当日券は当日 [2026-09-01]18時から。');
  });

  it('短い表現が長い表現の一部に当たって二重に注記しない（来週金曜と来週金曜日、来月と再来月）', () => {
    expect(annotateTextWithTemporalAnchors('来週金曜と来週金曜日。', referenceDate)).toBe('来週金曜 [2026-09-11]と来週金曜日 [2026-09-11]。');
    expect(annotateTextWithTemporalAnchors('来月と再来月。', referenceDate)).toBe('来月 [2026-10-01]と再来月 [2026-11-01]。');
    // すでに注記のある本文には重ねない（もう一度かけても同じ）
    const once = annotateTextWithTemporalAnchors('来週金曜日と明日と一昨日と来月。', referenceDate);
    expect(annotateTextWithTemporalAnchors(once, referenceDate)).toBe(once);
  });
});
