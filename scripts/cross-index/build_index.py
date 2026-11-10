# CBP の分類判例の手元の索引（cross_index.ts が読む gzip の JSONL）を組み立てる。
# 入力:
#   --rewrite  判例の原文を書き直した JSONL（1 行 1 判例: ruling, date, ds_code, re_codes, model_codes, en_title, en_desc）。
#              書き直しの方法は docs/engines/hts-prediction.md の「判例の索引」にある。
#   --atlas    ATLAS の写し（Dayanand314Krishna/cross_rulings_hts_dataset_for_tariffs の train/validation/test.jsonl。Apache-2.0）。省略できる。
# 出力: --out の gzip（1 行目は見出し）。同じ入力からは同じバイト列（gzip の時刻は 0）になる。最後に SHA-256 と件数を出す。
# 使い方: python3 scripts/cross-index/build_index.py --rewrite rewrite.jsonl --atlas train.jsonl validation.jsonl test.jsonl --out cross-rulings-index-1.jsonl.gz
import argparse
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rewrite', required=True)
    ap.add_argument('--atlas', nargs='*', default=[])
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    rows, seen = [], set()
    for r in [*from_rewrite(args.rewrite), *from_atlas(args.atlas)]:
        key = (r['n'], r['t'], r['x'], tuple(r['c']))
        if key not in seen:
            seen.add(key)
            rows.append(r)
    rows.sort(key=lambda r: (r['n'] == '', r['n'], r['x']))
    head = {'schema': 1, 'rulings': len(rows), 'numbered': sum(1 for r in rows if r['n']), 'atlas': bool(args.atlas), 'notice': NOTICE if args.atlas else NOTICE_RULINGS}
    text = '\n'.join(json.dumps(x, ensure_ascii=False, separators=(',', ':')) for x in [head, *rows]) + '\n'
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g:
        g.write(text.encode('utf-8'))
    data = buf.getvalue()
    open(args.out, 'wb').write(data)
    print(json.dumps({**head, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    main()
