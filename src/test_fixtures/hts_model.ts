// テスト用の関税分類モデル。本物（約 62MB を取得して読み込む）の代わりに、品名に当たった規則の応答を返す。
import type { HtsClassifier, HtsModelRequest, HtsModelResponse } from '../services/hts_model.js';

const DUTY = { general: '', special: '', other: '' };

export interface ModelAnswerOptions {
  /** 6 桁までが正しい確率（既定 0.95）。 */
  six?: number;
  /** 1 位の 10 桁が正しい確率（既定 0.6）。 */
  ten?: number;
  reader?: 'ja';
  release?: string;
  /** 候補が分かれる段の質問（桁数と選択肢）。flag は「聞いたほうがよい」の印（既定 true）。 */
  ask?: { digits: number; options: { prefix: string; label: string; code: string }[]; flag?: boolean };
}

/** モデルの応答を組み立てる。codes は数字だけの 10 桁で、先頭が 1 位。 */
export function modelAnswer(codes: string[], opts: ModelAnswerOptions = {}): HtsModelResponse {
  const rest = codes.slice(1);
  const ask = opts.ask;
  return {
    codes,
    scores: codes.map((_, i) => -i),
    htsRelease: opts.release ?? '2026HTSRev22',
    hsCode: { code: codes[0], description: '' },
    sixDigit: codes[0].slice(0, 6),
    confidenceScore: opts.ten ?? 0.6,
    sixDigitConfidence: opts.six ?? 0.95,
    dutyRate: DUTY,
    alternates: rest.map((code) => ({ code, description: '', probabilityMass: 0.4 / rest.length, dutyRate: DUTY })),
    questions: ask
      ? [{ digits: ask.digits, ask: ask.flag ?? true, confidence: 0.5, options: ask.options.map((o) => ({ ...o, probabilityMass: 1 / ask.options.length, dutyRate: DUTY })) }]
      : [],
    reader: opts.reader,
  };
}

export type FakeHtsModel = HtsClassifier & { calls: HtsModelRequest[] };

/** 品名＋説明に当たった最初の規則の応答を返すモデル。受け取った入力は calls に残る。どの規則にも当たらなければ失敗する（規則の書き漏れに気づくため）。 */
export function fakeHtsModel(rules: [RegExp, HtsModelResponse][]): FakeHtsModel {
  const calls: HtsModelRequest[] = [];
  const classify = ((req: HtsModelRequest) => {
    calls.push(req);
    const hit = rules.find(([re]) => re.test(`${req.name} ${req.description ?? ''}`));
    if (!hit) throw new Error(`fakeHtsModel: 規則に無い入力です: ${req.name}`);
    return hit[1];
  }) as FakeHtsModel;
  classify.calls = calls;
  return classify;
}
