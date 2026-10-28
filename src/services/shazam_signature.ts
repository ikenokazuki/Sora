/**
 * Shazam の音の指紋（SigX）。計算と形の検査は packages/audio-signature（npm の @ikenokazuki/audio-signature、MIT。
 * omkarcloud/shazam-scraper の shazam/sigx.py の移植で、ライセンスの表示もそこにある）にあり、ここは Shazam の tag の窓口に送る
 * data URI の形だけを持つ。
 */
import { createSignature, encodeBase64 } from '../../packages/audio-signature/src/index.js';

export { MIN_WINDOW_SECONDS, SAMPLE_RATE, SignatureTooShortError, WINDOW_SECONDS, checkSignatureBase64 } from '../../packages/audio-signature/src/index.js';

export const DATA_URI_PREFIX = 'data:audio/vnd.shazam.sig;base64,';

/** 16 kHz・モノラルの Int16 → tag の窓口に送る data URI と長さ（ミリ秒）。先頭の 12 秒だけを使う。短すぎる・静かすぎる音は SignatureTooShortError。 */
export function signatureUri(samples: Int16Array): { uri: string; sampleMs: number } {
  const { bytes, sampleMs } = createSignature(samples);
  return { uri: DATA_URI_PREFIX + encodeBase64(bytes), sampleMs };
}
