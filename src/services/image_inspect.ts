import { getFromCache, setToCache } from '../cache.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
export const CACHE_TTL_IMAGE = 3600; // 1時間 (画像Base64キャッシュ)

export interface InspectImageResult {
  success: boolean;
  url: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
  markdown?: string;
  imageContent: {
    type: 'image';
    data: string;
    mimeType: string;
  };
  cached?: boolean;
}

/** マジックバイトから画像 MIME タイプを安全に判定 */
export function detectImageMimeType(buffer: Uint8Array, headerContentType?: string | null): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (headerContentType && headerContentType.startsWith('image/')) {
    return headerContentType.split(';')[0].trim().toLowerCase();
  }

  return 'image/jpeg'; // フォールバック
}

/** SSRF 防御 & サイズ制限 & TLS指紋偽装付き画像フェッチ */
export async function fetchImageBuffer(
  imageUrl: string,
  maxBytes = MAX_IMAGE_BYTES,
  timeoutMs = 15000,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const { fetchWithSafeRedirects } = await import('../scraper.js');

  const { response: res } = await fetchWithSafeRedirects(
    imageUrl,
    timeoutMs,
    5,
    {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  );

  if (!res.ok) {
    throw new Error(`画像の取得に失敗しました (HTTP ${res.status}): ${imageUrl}`);
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  if (contentLength > maxBytes) {
    throw new Error(`画像サイズが上限（${Math.round(maxBytes / 1024 / 1024)}MB）を超過しています: ${contentLength} bytes`);
  }

  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > maxBytes) {
    throw new Error(`画像サイズが上限を超過しています: ${arrayBuf.byteLength} bytes`);
  }

  const buf = Buffer.from(arrayBuf);
  const mimeType = detectImageMimeType(new Uint8Array(buf), res.headers.get('content-type'));

  return { buffer: buf, mimeType };
}

/** 画像をフェッチして MCP ImageContent / Base64 を生成 (LRUキャッシュ対応) */
export async function inspectImage(options: { url: string }): Promise<InspectImageResult> {
  const cacheKey = `img_inspect:${options.url}`;
  const cached = getFromCache<InspectImageResult>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const { buffer, mimeType } = await fetchImageBuffer(options.url);
  const base64 = buffer.toString('base64');
  const sizeKb = Math.round(buffer.length / 1024);

  const markdown = `![画像](${options.url})\n\n- **画像URL**: ${options.url}\n- **フォーマット**: \`${mimeType}\`\n- **サイズ**: ${sizeKb} KB\n- **ステータス**: MCP ImageContent としてマルチモーダル視覚入力にロード完了`;

  const result: InspectImageResult = {
    success: true,
    url: options.url,
    mimeType,
    sizeBytes: buffer.length,
    base64,
    markdown,
    imageContent: {
      type: 'image',
      data: base64,
      mimeType,
    },
  };

  setToCache(cacheKey, result, CACHE_TTL_IMAGE);
  return result;
}
