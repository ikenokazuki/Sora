import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jigyosyoText } from '../test_fixtures/address/jigyosyo.js';
import {
  PostalReader, annotationMatchesNumber, buildPostalDb, foldName, linkPostalRows, parseChomeRange, parseJigyosyo, parseKenAll,
  splitTown, zipsForTown, type PostalRow, type TownRef,
} from './postal_code.js';

const KEN_ALL = [
  '13101,"100  ","1000001","トウキョウト","チヨダク","チヨダ","東京都","千代田区","千代田",0,0,1,0,0,0',
  '01101,"060  ","0600000","ホッカイドウ","サッポロシチュウオウク","イカニケイサイガナイバアイ","北海道","札幌市中央区","以下に掲載がない場合",0,0,0,0,0,0',
  '01101,"060  ","0600042","ホッカイドウ","サッポロシチュウオウク","オオドオリニシ(1-19チョウメ)","北海道","札幌市中央区","大通西（１〜１９丁目）",0,0,1,0,0,0',
  '01101,"064  ","0640820","ホッカイドウ","サッポロシチュウオウク","オオドオリニシ(20-28チョウメ)","北海道","札幌市中央区","大通西（２０〜２８丁目）",0,0,1,0,0,0',
  '13101,"100  ","1006801","トウキョウト","チヨダク","オオテマチ","東京都","千代田区","大手町ＪＡビル（１階）",0,0,0,0,0,0',
  '20209,"394  ","3940001","ナガノケン","オカヤシ","オカヤシノツギニバンチガクルバアイ","長野県","岡谷市","岡谷市の次に番地がくる場合",0,0,0,0,0,0',
  '13361,"100  ","1000301","トウキョウト","トシマムラ","トシマムラ","東京都","利島村","利島村一円",0,0,0,0,0,0',
].join('\r\n') + '\r\n';

describe('KEN_ALL', () => {
  test('町域の括弧注記と、町域を持たない行を整理する', () => {
    const rows = parseKenAll(KEN_ALL);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({
      zip: '1000001', kind: 'general', lg5: '13101', pref: '東京都', city: '千代田区',
      town: '千代田', townRaw: '千代田', annotation: '', detail: '', office: '',
    });
    expect(rows[1]).toMatchObject({ zip: '0600000', town: '', townRaw: '以下に掲載がない場合', annotation: '' });
    expect(rows[2]).toMatchObject({ zip: '0600042', town: '大通西', townRaw: '大通西（１〜１９丁目）', annotation: '１〜１９丁目' });
    expect(rows[4]).toMatchObject({ town: '大手町ＪＡビル', annotation: '１階' });
    expect(rows[5]).toMatchObject({ zip: '3940001', town: '', annotation: '' });
    expect(rows[6]).toMatchObject({ town: '利島村一円', annotation: '' });
  });

  test('7 桁でない行や短い行は読み飛ばす', () => {
    expect(parseKenAll('13101,"100  ","100000","a","b","c","東京都","千代田区","千代田"\r\nshort\r\n')).toEqual([]);
  });

  test('splitTown', () => {
    expect(splitTown('以下に掲載がない場合')).toEqual({ town: '', annotation: '' });
    expect(splitTown('境町の次に番地がくる場合')).toEqual({ town: '', annotation: '' });
    expect(splitTown('常盤（その他）')).toEqual({ town: '常盤', annotation: 'その他' });
    expect(splitTown('川上町（３６４９、３６６１）')).toEqual({ town: '川上町', annotation: '３６４９、３６６１' });
    expect(splitTown('永田町')).toEqual({ town: '永田町', annotation: '' });
  });
});

describe('JIGYOSYO', () => {
  test('Shift_JIS の事業所番号と私書箱を読む', () => {
    const rows = parseJigyosyo(jigyosyoText());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      zip: '0608621', kind: 'office', lg5: '01101', pref: '北海道', city: '札幌市中央区', town: '北一条西', townRaw: '北一条西',
      annotation: '', detail: '６丁目１－２アーバンネット札幌ビル２Ｆ', office: '株式会社　日本経済新聞社　札幌支社',
    });
    expect(rows[1]).toMatchObject({ zip: '1008799', kind: 'po_box', lg5: '13101', office: '私書箱テスト' });
  });
});

describe('SQLite', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'addr-postal-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('郵便番号と市区町村コードで引ける。市区町村の引き当ては一般の行だけ', () => {
    const path = join(dir, 'postal.sqlite');
    buildPostalDb(path, [...parseKenAll(KEN_ALL), ...parseJigyosyo(jigyosyoText())]);
    const reader = new PostalReader(path);
    try {
      expect(reader.byZip('1000001')).toEqual([expect.objectContaining({ id: 1, zip: '1000001', town: '千代田', townRaw: '千代田', kind: 'general' })]);
      expect(reader.byZip('0608621')[0]).toMatchObject({ kind: 'office', office: '株式会社　日本経済新聞社　札幌支社' });
      expect(reader.byZip('9999999')).toEqual([]);
      expect(reader.byLg5('01101').map((row) => row.zip)).toEqual(['0600000', '0600042', '0640820']);
    } finally {
      reader.close();
    }
  });
});

describe('foldName', () => {
  test('全角・漢数字・「大字」「字」・表記ゆれをそろえる', () => {
    expect(foldName('北１条西')).toBe(foldName('北一条西'));
    expect(foldName('猪高町大字猪子石字猪々道')).toBe(foldName('猪高町猪子石猪々道'));
    expect(foldName('一ノ井町')).toBe(foldName('一之井町'));
    expect(foldName('上賀茂蝉ヶ垣内町')).toBe(foldName('上賀茂蝉ケ垣内町'));
    expect(foldName('永田町　一丁目')).toBe('永田町1');
    expect(foldName('千代田')).toBe('千代田');
  });
});

describe('注記の解釈', () => {
  test('丁目の範囲', () => {
    expect(parseChomeRange('１〜１９丁目')).toEqual({ lo: 1, hi: 19 });
    expect(parseChomeRange('２０～２８丁目')).toEqual({ lo: 20, hi: 28 });
    expect(parseChomeRange('その他')).toBeNull();
    expect(parseChomeRange('１〜１０番地')).toBeNull();
  });

  test('番地の範囲と列挙は住所の番地が入るかで判定し、解釈できない注記は null', () => {
    expect(annotationMatchesNumber('１〜１０番地', '3-4')).toBe(true);
    expect(annotationMatchesNumber('１〜１０番地', '12')).toBe(false);
    expect(annotationMatchesNumber('１１〜２０番地', '12-3')).toBe(true);
    expect(annotationMatchesNumber('３６４９、３６６１', '3661')).toBe(true);
    expect(annotationMatchesNumber('３６４９、３６６７−３', '3667-3')).toBe(true);
    expect(annotationMatchesNumber('３６４９、３６６７−３', '3667-4')).toBe(false);
    expect(annotationMatchesNumber('１階', '12')).toBeNull();
    expect(annotationMatchesNumber('その他', '12')).toBeNull();
    expect(annotationMatchesNumber('１〜１０番地', 'あ')).toBeNull();
  });
});

function postalRow(id: number, lg5: string, raw: string, zip = String(1000000 + id)): PostalRow {
  const { town, annotation } = splitTown(raw);
  return { id, zip, kind: 'general', lg5, pref: '', city: '', town, townRaw: raw, annotation, detail: '', office: '' };
}
const t = (machiaza_id: string, oaza_cho: string, extra: Partial<TownRef> = {}): TownRef => ({ machiaza_id, oaza_cho, ...extra });

describe('linkPostalRows', () => {
  test('町域名を同じ市区町村の町字に結びつける（丁目は全部に）', () => {
    const towns = [t('a1', '永田町', { chome: '一丁目', chome_n: 1 }), t('a2', '永田町', { chome: '二丁目', chome_n: 2 }), t('b', '千代田')];
    const links = linkPostalRows([postalRow(1, '13101', '永田町'), postalRow(2, '13101', '千代田')], towns);
    expect(links.get(1)).toEqual({ machiazaIds: ['a1', 'a2'], exact: true });
    expect(links.get(2)).toEqual({ machiazaIds: ['b'], exact: true });
  });

  test('丁目の範囲は chome_n で絞る。算用数字・漢数字の揺れも吸収する', () => {
    const towns = [1, 19, 20, 28].map((n) => t(`n${n}`, '北１条西', { chome: `${n}丁目`, chome_n: n }));
    const links = linkPostalRows([postalRow(1, '01101', '北一条西（１〜１９丁目）'), postalRow(2, '01101', '北一条西（２０〜２８丁目）')], towns);
    expect(links.get(1)).toEqual({ machiazaIds: ['n1', 'n19'], exact: true });
    expect(links.get(2)).toEqual({ machiazaIds: ['n20', 'n28'], exact: true });
  });

  test('「その他」は、丁目の範囲の行が取らなかった町字を受ける', () => {
    const towns = [1, 2, 3, 4, 5].map((n) => t(`c${n}`, '常盤', { chome_n: n }));
    const links = linkPostalRows([postalRow(1, '01101', '常盤（１〜３丁目）'), postalRow(2, '01101', '常盤（その他）')], towns);
    expect(links.get(1)?.machiazaIds).toEqual(['c1', 'c2', 'c3']);
    expect(links.get(2)).toEqual({ machiazaIds: ['c4', 'c5'], exact: true });
  });

  test('大字・字・小字・「一円」を扱い、建物別の行と解釈できない注記を区別する', () => {
    const towns = [t('k1', '猪高町大字猪子石', { koaza: '字猪々道' }), t('j', '利島村'), t('m', '岩作')];
    const links = linkPostalRows(
      [postalRow(1, '23101', '猪高町猪子石猪々道'), postalRow(2, '13361', '利島村一円'), postalRow(3, '23101', '岩作（１〜１０番地）'), postalRow(4, '13101', '岩作ビル（１階）')],
      towns,
    );
    expect(links.get(1)).toEqual({ machiazaIds: ['k1'], exact: true });
    expect(links.get(2)).toEqual({ machiazaIds: ['j'], exact: true });
    expect(links.get(3)).toEqual({ machiazaIds: ['m'], exact: false });
    expect(links.has(4)).toBe(false);
  });

  test('結びつかない行と、市区町村の既定行は結果に含めない', () => {
    const links = linkPostalRows([postalRow(1, '13101', '存在しない町'), postalRow(2, '13101', '以下に掲載がない場合')], [t('a', '千代田')]);
    expect(links.size).toBe(0);
  });
});

describe('zipsForTown', () => {
  const towns = [t('m', '岩作')];
  const rows = [postalRow(1, '23101', '岩作（１〜１０番地）', '4801103'), postalRow(2, '23101', '岩作（１１〜２０番地）', '4801104'), postalRow(3, '23101', '以下に掲載がない場合', '4801100')];
  const links = linkPostalRows(rows, towns);

  test('番地が分かれば、範囲の合う郵便番号を exact にして先頭に置く', () => {
    expect(zipsForTown(rows, links, 'm', '12-3').map((m) => [m.row.zip, m.exact, m.fallback])).toEqual([['4801104', true, false]]);
  });

  test('番地が無ければ、範囲つきの行はどれも exact にならない', () => {
    expect(zipsForTown(rows, links, 'm').map((m) => [m.row.zip, m.exact, m.fallback])).toEqual([['4801103', false, false], ['4801104', false, false]]);
  });

  test('どの範囲にも入らなければ全部を exact でなく返す', () => {
    expect(zipsForTown(rows, links, 'm', '99').map((m) => [m.row.zip, m.exact])).toEqual([['4801103', false], ['4801104', false]]);
  });

  test('専用の番号が無い町字は、市区町村の既定番号を fallback で返す', () => {
    expect(zipsForTown(rows, links, 'unknown').map((m) => [m.row.zip, m.exact, m.fallback])).toEqual([['4801100', false, true]]);
  });

  test('同じ郵便番号は 1 件にまとめる', () => {
    const dup = [postalRow(1, '13101', '永田町', '1000014'), postalRow(2, '13101', '永田町（１〜２丁目）', '1000014')];
    const matches = zipsForTown(dup, linkPostalRows(dup, [t('x', '永田町', { chome_n: 1 })]), 'x');
    expect(matches).toHaveLength(1);
  });
});
