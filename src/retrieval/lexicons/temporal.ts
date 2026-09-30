// Temporal lexicon: knowledge separated from scoring logic.
// One entry here should have a matching case in lexicons.test.ts.
// Add a term only with a real misclassified query to justify it.
export const CURRENT_INTENT_TERMS: string[] = [
  '最新',
  '現在',
  '現行',
  '今年',
  '直近',
  '今現在',
];
export const CURRENT_MARKERS: string[] = [
  '現行',
  '現在',
  '最新',
  '今年',
  '直近',
];
export const OLD_MARKERS: string[] = [
  '旧',
  '以前',
  '過去',
];
export interface FacetKindEntry {
  terms: string[];
  kinds: Array<'price' | 'weight' | 'date' | 'time' | 'version' | 'wifi'>;
}
export const FACET_KIND_TERMS: FacetKindEntry[] = [
  { terms: ['価格', '料金', '値段', '販売価格', '希望小売価格'], kinds: ['price'] },
  { terms: ['重量', '質量', '重さ'], kinds: ['weight'] },
  { terms: ['発売日', '公開日', '配信日', 'リリース', '日付', '日程', '販売開始日'], kinds: ['date'] },
  { terms: ['時刻', '時間', '営業時間', '開演', '開場', '上映'], kinds: ['time'] },
  { terms: ['バージョン', 'version'], kinds: ['version'] },
  { terms: ['wi-fi', 'wifi', '無線lan', '802.11'], kinds: ['wifi'] },
];
export const INTENT_ATTRIBUTE_TERMS_LIST: string[] = [
  '作詞', '作詞者', '作曲', '作曲者', '編曲', '編曲者', '作編曲', 'アーティスト', '歌手', 'ボーカル',
  '発売日', '公開日', '配信日', 'リリース', '誕生日', '生年月日', '出身', '出身地', '本名', '年齢',
  '営業時間', '定休日', '料金', '価格', '値段', '所在地', '住所', '電話番号', 'アクセス', '最寄り駅',
  'キャスト', '声優', '出演者', '出演時間', '出演辞退', '監督', '脚本', '原作', '著者', '作者', '執筆者', '監修',
  '資本金', '代表者', '代表取締役', '設立', '創業', '従業員数',
];
