# CBP の分類判例の手元の索引（cross_index.ts が読む gzip の JSONL）を組み立てる。
# 入力:
#   --rewrite  判例の原文を書き直した JSONL（1 行 1 判例: ruling, date, ds_code, re_codes, model_codes, en_title, en_desc）。
#              書き直しの方法は docs/engines/hts-prediction.md の「判例の索引」にある。
#   --atlas    ATLAS の写し（Dayanand314Krishna/cross_rulings_hts_dataset_for_tariffs の train/validation/test.jsonl。Apache-2.0）。省略できる。
# 出力: --out の gzip（1 行目は見出し）。同じ入力からは同じバイト列（gzip の時刻は 0）になる。最後に SHA-256 と件数を出す。
# 使い方: python3 scripts/cross-index/build_index.py --rewrite rewrite.jsonl --atlas train.jsonl validation.jsonl test.jsonl --out cross-rulings-index-1.jsonl.gz
#
# 前の索引から作り直す形（cross-index-2）。判例番号と中身の対応が確かめられた公開データを、ある年から先の正にする:
#   --base   前の索引（cross-rulings-index-1.jsonl.gz）。
#   --items  判例を品ごとに分けた公開の CSV（Hugging Face の fklc/cbp-rulings-past-2012 の products.csv。MIT）。
#            欄は ruling_number・collection・ruling_date・product_name・product_description・hs_code_digits。
#   前の索引の行は、番号の無い行と、--items-from（既定 2012）より前の年の行をそのまま残す。--items-from から --base-trusted-from（既定 2022）の
#   前までの年の行は入れない（前の索引のもとのデータは、この期間の判例番号と中身の対応が確かめられない）。--base-trusted-from からの年の行は、
#   同じ番号が CSV に無いものだけ残す。CSV の行は、第 98・99 類のコードと、8 桁・10 桁でないコードを除いて、1 品 1 行で入れる。
# 使い方: python3 scripts/cross-index/build_index.py --base cross-rulings-index-1.jsonl.gz --items products.csv --out cross-rulings-index-2.jsonl.gz
#         python3 scripts/cross-index/build_index.py --self-test
import argparse
import csv
import gzip
import hashlib
import io
import json
import re

CODE = r'\d{4}\.\d{2}(?:\.\d{2}(?:\.?\d{2})?)?'

# 名前・会社名・住所・連絡先・番号を消す（書き直しの指示に加えた二重の守り。ATLAS の問い文にもかける）
SCRUB = [
    re.compile(r'\b(?:Mr|Ms|Mrs|Dr|Messrs)\.?\s+[A-Z][\w\'.-]*(?:\s+[A-Z][\w\'.-]*){0,3}'),
    re.compile(r"(?:\b[A-Z][\w&'.-]*\s+){1,4}(?:Inc|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|Co|Company|GmbH|S\.A|N\.V|B\.V|PLC|LLP|Pty)\b\.?(?:,?\s*(?:Ltd|Inc|LLC)\b\.?)?"),
    re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+'),
    re.compile(r'https?://\S+|www\.\S+'),
    re.compile(r'\(?\+?\d{1,3}\)?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}'),
    re.compile(r'\b\d{1,6}\s+(?:[A-Z][\w.]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Suite|Way|Parkway|Pkwy)\b\.?'),
    re.compile(r'\b(?:NY|HQ|N|H)\s?[A-Z]?\d{5,6}\b'),
    re.compile(r'(?<![/\w])[A-Z]{1,4}-?\d{2,}[A-Z]?\b'),  # 型番・品番（JB42、T0148 など。205/70R15 のような寸法は残す）
    re.compile(CODE),
    re.compile(r'\S*[®™©]\S*'),  # 商標の記号の付いた語（Invar® など）
]


def scrub(s: str) -> str:
    for p in SCRUB:
        s = p.sub('', s)
    return re.sub(r'\s{2,}', ' ', s).strip(' ,;')


def digits(c: str) -> str:
    return re.sub(r'\D', '', c)


def from_rewrite(path: str):
    """原文から抜き出したコード（決まり文句を優先し、無ければ Haiku が抜き出したもの）のうち、データの hts_code と 6 桁まで合うものだけ。"""
    kept = dropped = 0
    for line in open(path, encoding='utf-8'):
        r = json.loads(line)
        ds = r.get('ds_code') or ''
        codes = [c for c in (r.get('re_codes') or r.get('model_codes') or []) if len(c) >= 6 and c[:6] in ds]
        title, desc = scrub(r.get('en_title', '')), scrub(r.get('en_desc', ''))
        if not codes or not (title or desc):
            dropped += 1
            continue
        kept += 1
        yield {'n': r['ruling'], 'd': r.get('date', ''), 't': title, 'x': desc, 'c': list(dict.fromkeys(codes))}
    print(f'rewrite: {kept} kept, {dropped} dropped')


NOTICE_RULINGS = ('Built from U.S. Customs and Border Protection (CBP) classification rulings (U.S. Government works). '
                  'Product names and descriptions were rewritten from the ruling text; names of people and companies were left out or removed where found.')
NOTICE = (NOTICE_RULINGS + ' Rulings without a number are derived from "CROSS Rulings HTS Dataset for Tariff Classification" '
          'by Flexify.AI Inc. (https://www.flexify.ai), https://huggingface.co/datasets/flexifyai/cross_rulings_hts_dataset_for_tariffs, '
          'licensed under Apache-2.0. Changes: only the product description in each question and the codes in the first answer line '
          'are kept; names, numbers and codes were removed from the description.')

ASK = re.compile(r'^\s*What is the HTS US Code for\s+(.*?)\s*\??\s*$', re.S | re.I)
ANSWER = re.compile(r'^\s*HTS US Code\s*->\s*(.*)$', re.I)


def from_atlas(paths: list[str]):
    kept = dropped = 0
    for path in paths:
        for line in open(path, encoding='utf-8'):
            msgs = json.loads(line)['messages']
            q = next((m['content'] for m in msgs if m['role'] == 'user'), '')
            a = next((m['content'] for m in msgs if m['role'] == 'assistant'), '')
            mq, ma = ASK.match(q), ANSWER.match(a.splitlines()[0] if a else '')
            codes = [digits(c) for c in re.findall(CODE, ma.group(1))] if ma else []
            desc = scrub(mq.group(1)) if mq else ''
            if not codes or not desc:
                dropped += 1
                continue
            kept += 1
            yield {'n': '', 'd': '', 't': '', 'x': desc, 'c': list(dict.fromkeys(codes))}
    print(f'atlas: {kept} kept, {dropped} dropped')


NOTICE_ITEMS = (' Rulings dated 2012 or later are taken from "AI-Extracted CBP Customs Rulings Dataset" (fklc/cbp-rulings-past-2012, '
                'https://huggingface.co/datasets/fklc/cbp-rulings-past-2012), Copyright (c) 2026 Fatih Kilic, licensed under the MIT License. '
                'Changes: only the ruling number, date, product name, product description and code of each item are kept; '
                'names, numbers and codes were removed from the names and descriptions.')


def number_key(n: str) -> str:
    """判例番号の比べ方（'NY N299253' と 'N299253' を同じに扱う）。"""
    return re.sub(r'^(NY|HQ)', '', re.sub(r'[^A-Z0-9]', '', n.upper()))


def item_row(r: dict) -> dict | None:
    """公開の CSV の 1 行 → 索引の 1 行。入れない行は None。"""
    code = digits(r.get('hs_code_digits') or '')
    if len(code) not in (8, 10) or code[:2] in ('98', '99'):
        return None
    title, desc = scrub(r.get('product_name') or ''), scrub(r.get('product_description') or '')
    num, col = (r.get('ruling_number') or '').strip(), (r.get('collection') or '').strip().upper()
    if not (title or desc) or not re.fullmatch(r'[A-Za-z]?\d{5,6}', num) or col not in ('NY', 'HQ'):
        return None
    return {'n': f'{col} {num}', 'd': (r.get('ruling_date') or '')[:10], 't': title, 'x': desc, 'c': [code]}


def from_items(path: str):
    kept = dropped = 0
    csv.field_size_limit(10**9)
    with open(path, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            row = item_row(r)
            if row is None:
                dropped += 1
                continue
            kept += 1
            yield row
    print(f'items: {kept} kept, {dropped} dropped')


def keep_base(r: dict, items_from: int, trusted_from: int, item_numbers: set[str]) -> bool:
    """前の索引の行を残すか。番号の無い行・日付の無い行・items_from より前の年の行は残す。trusted_from からの年の行は、同じ番号が CSV に無ければ残す。"""
    if not r['n'] or not r['d'][:4].isdigit():
        return True
    year = int(r['d'][:4])
    if year < items_from:
        return True
    return year >= trusted_from and number_key(r['n']) not in item_numbers


def from_base(path: str, items: list[dict], items_from: int, trusted_from: int):
    lines = [json.loads(line) for line in gzip.open(path, 'rt', encoding='utf-8')]
    head, rows = lines[0], lines[1:]
    if head.get('schema') != 1:
        raise SystemExit('前の索引の形式の版が違います')
    numbers = {number_key(r['n']) for r in items}
    kept = [r for r in rows if keep_base(r, items_from, trusted_from, numbers)]
    print(f'base: {len(kept)} kept, {len(rows) - len(kept)} dropped')
    return head, kept


def self_test():
    """--base と --items の形の決まりの確かめ（python3 scripts/cross-index/build_index.py --self-test）。"""
    ok = {'ruling_number': 'N299253', 'collection': 'ny', 'ruling_date': '2018-08-07', 'product_name': 'Snack bowl', 'product_description': 'Ceramic bowl', 'hs_code_digits': '6912004810'}
    assert item_row(ok) == {'n': 'NY N299253', 'd': '2018-08-07', 't': 'Snack bowl', 'x': 'Ceramic bowl', 'c': ['6912004810']}
    assert item_row({**ok, 'hs_code_digits': '99038803'}) is None  # 第 99 類
    assert item_row({**ok, 'hs_code_digits': '691200'}) is None  # 6 桁
    assert item_row({**ok, 'ruling_number': 'see N1'}) is None and item_row({**ok, 'product_name': '', 'product_description': ' '}) is None
    assert number_key('NY N299253') == number_key('n299253') == 'N299253'
    row = lambda n, d: {'n': n, 'd': d, 't': '', 'x': 'x', 'c': ['1']}
    keep = lambda r: keep_base(r, 2012, 2022, {'N300001'})
    assert keep(row('', '')) and keep(row('NY A00001', '2005-01-01'))  # 番号の無い行・2011 年までの行は残す
    assert not keep(row('NY N200001', '2015-01-01'))  # 2012〜2021 年の行は入れない
    assert not keep(row('NY N300001', '2023-01-01')) and keep(row('NY N300002', '2023-01-01'))  # 2022 年からは、CSV に同じ番号が無いものだけ
    print('self-test ok')


def main():
    if '--self-test' in __import__('sys').argv[1:]:
        return self_test()
    ap = argparse.ArgumentParser()
    ap.add_argument('--rewrite')
    ap.add_argument('--atlas', nargs='*', default=[])
    ap.add_argument('--base')
    ap.add_argument('--items')
    ap.add_argument('--items-from', type=int, default=2012)
    ap.add_argument('--base-trusted-from', type=int, default=2022)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    if bool(args.base) == bool(args.rewrite) or bool(args.base) != bool(args.items) or (args.base and args.atlas):
        ap.error('--rewrite（と --atlas）か、--base と --items の組の、どちらかを指定してください')
    if args.base:
        items = list(from_items(args.items))
        base_head, base_rows = from_base(args.base, items, args.items_from, args.base_trusted_from)
        source, atlas, notice = [*base_rows, *items], bool(base_head.get('atlas')), base_head['notice'] + NOTICE_ITEMS
    else:
        source, atlas, notice = [*from_rewrite(args.rewrite), *from_atlas(args.atlas)], bool(args.atlas), NOTICE if args.atlas else NOTICE_RULINGS
    rows, seen = [], set()
    for r in source:
        key = (r['n'], r['t'], r['x'], tuple(r['c']))
        if key not in seen:
            seen.add(key)
            rows.append(r)
    rows.sort(key=lambda r: (r['n'] == '', r['n'], r['x']))
    head = {'schema': 1, 'rulings': len(rows), 'numbered': sum(1 for r in rows if r['n']), 'atlas': atlas, 'notice': notice}
    text = '\n'.join(json.dumps(x, ensure_ascii=False, separators=(',', ':')) for x in [head, *rows]) + '\n'
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g:
        g.write(text.encode('utf-8'))
    data = buf.getvalue()
    open(args.out, 'wb').write(data)
    print(json.dumps({**head, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    main()
