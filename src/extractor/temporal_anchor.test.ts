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

  it('相対時間表現がない場合は元のテキストをそのまま返すこと', () => {
    const text = '2026年9月15日に正式リリースされます。';
    const anchors = extractTemporalAnchors(text, referenceDate);
    expect(anchors).toEqual([]);
    expect(annotateTextWithTemporalAnchors(text, referenceDate)).toBe(text);
  });
});
