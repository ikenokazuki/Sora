import { z } from 'zod';
import { EventItemSchema, FieldEvidenceSchema, ImageItemSchema, MediaInfoSchema, ScrapeContentStatusSchema, TableDataSchema } from './types.js';

/**
 * HTML の変換の別プロセス（html_convert_child_main.ts）と親（html_convert.ts）の約束。
 *
 * 標準入力: 頼み方の JSON を 1 行（改行で終わる）と、そのあとに HTML の本文（UTF-8。そのまま。JSON にしない＝大きな本文を二重に持たない）。
 * 標準出力: 1 行の JSON。`{"t":"done","result":…,"rsUnavailable":[…],"counters":{…}}` か `{"t":"error","name":…,"message":…}`。
 * 子は乗っ取られうるので、親は結果の形を ConvertResultSchema で検査し、合わなければ約束違反として捨てる。
 */

/** 結果に入れる、大きくなりうる欄。入れないものは、子が返さない（親が使わない大きな欄を、受け渡さない） */
export interface ConvertWant {
  links: boolean;
  images: boolean;
  jsonLd: boolean;
  tables: boolean;
  html: boolean;
}

export const ConvertRequestSchema = z.object({
  v: z.literal(1),
  url: z.string(),
  maxChars: z.number().int().nonnegative(),
  isRendered: z.boolean(),
  onlyMainContent: z.boolean(),
  selectors: z.record(z.string(), z.string()).optional(),
  removeSelectors: z.array(z.string()).optional(),
  stripLinks: z.boolean().optional(),
  keepDataImages: z.boolean().optional(),
  /** 本文の抽出（rs-trafilatura）も、子の中でする。bin = コマンドの場所（親が SORA_RS_TRAFILATURA_PATH から決める。子は環境変数を読まない） */
  mainContent: z.object({ bin: z.string(), removeSelectors: z.array(z.string()).optional(), includeMedia: z.boolean().optional() }).optional(),
  want: z.object({ links: z.boolean(), images: z.boolean(), jsonLd: z.boolean(), tables: z.boolean(), html: z.boolean() }),
});

export type ConvertRequest = z.infer<typeof ConvertRequestSchema>;

/** 標準入力のバイト列を作る（頼み方の 1 行 + HTML）。Blob にまとめるので、HTML の文字列は 1 回だけ UTF-8 にする */
export function encodeConvertRequest(request: ConvertRequest, html: string): Blob {
  return new Blob([`${JSON.stringify(request)}\n`, html]);
}

/** 子の側: 標準入力のバイト列を、頼み方と HTML に分ける。頼み方が読めない・形が違うときは例外 */
export function decodeConvertRequest(bytes: Uint8Array): { request: ConvertRequest; html: string } {
  const newline = bytes.indexOf(10);
  if (newline < 0) throw new Error('頼み方の行がありません（標準入力に、頼み方の JSON の 1 行と HTML を渡してください）');
  const decoder = new TextDecoder();
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(0, newline)));
  } catch {
    throw new Error('頼み方の行が JSON として読めません');
  }
  const request = ConvertRequestSchema.parse(header);
  return { request, html: decoder.decode(bytes.subarray(newline + 1)) };
}

const optionalText = z.string().optional();

/** 変換の結果（html_parser.ts の convertHtmlToMarkdown の戻り値）の形。子が返した結果を、親がこれで検査する（知らない欄は捨てる） */
export const ConvertResultSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  fullMarkdown: z.string(),
  contentStatus: ScrapeContentStatusSchema,
  ogImage: optionalText,
  description: optionalText,
  publishedTime: optionalText,
  author: optionalText,
  siteName: optionalText,
  twitterHandle: optionalText,
  socialLinks: z.record(z.string(), z.string()).optional(),
  availability: optionalText,
  price: optionalText,
  priceCurrency: optionalText,
  brand: optionalText,
  sku: optionalText,
  isTruncated: z.boolean(),
  links: z.array(z.string()),
  images: z.array(ImageItemSchema).optional(),
  jsonLd: z.array(z.unknown()).optional(),
  tables: z.array(TableDataSchema).optional(),
  events: z.array(EventItemSchema).optional(),
  breadcrumb: z.array(z.string()).optional(),
  extracted: z.record(z.string(), z.string().nullable()).optional(),
  media: MediaInfoSchema.optional(),
  html: optionalText,
  estimatedTokens: z.number(),
  quality: z.number().optional(),
  completeness: z.number().optional(),
  pageType: z.enum(['article', 'product', 'qa', 'generic']).optional(),
  qualityReasons: z.array(z.string()).optional(),
  missingFields: z.array(z.string()).optional(),
  evidence: z.record(z.string(), FieldEvidenceSchema).optional(),
});

/** 子が、本文の抽出のために数えたカウンター（親の /metrics に足す）。名前はこの形だけを受け入れ、1 回の変換で数える量にも上限を置く */
export const CHILD_COUNTER_NAME = /^sora_main_content_rs_[a-z_]{1,60}_total$/;
export const CHILD_COUNTER_MAX = 10;

export const ConvertDoneSchema = z.object({
  t: z.literal('done'),
  result: ConvertResultSchema,
  rsUnavailable: z.array(z.enum(['content', 'images'])).max(2),
  counters: z.record(z.string().regex(CHILD_COUNTER_NAME), z.number().int().min(1).max(CHILD_COUNTER_MAX)),
});

export const ConvertErrorSchema = z.object({
  t: z.literal('error'),
  name: z.string(),
  message: z.string(),
});
