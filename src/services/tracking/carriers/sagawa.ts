import type {
  TrackingCarrierAdapter,
  CarrierDetectionSignal,
  TrackingDetectionHints,
  TrackingResult,
  TrackingVerification,
  TrackingContext,
  TrackingEvent,
} from '../types.js';
import { cleanTrackingNumber } from '../normalization.js';
import { evaluateTrackingVerification } from '../verification.js';
import { determineStatus } from './yamato.js';
import { errorMessage } from '../../../errors.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 旧サイト（k2k.sagawa-exp.co.jp）は 2026-10 に止まり、Next.js 製の新サイトに移った。検索はサーバーアクション
// searchPackages への POST 1 本で、Cookie も Origin も要らない（Next-Action ヘッダと multipart の 2 項目だけ）。
// 応答は React Flight 形式で、`1:` の行がアクションの戻り値の JSON。
const TRACKING_PAGE = 'https://e-customer.sagawa-exp.co.jp/k2k';
// アクション ID は佐川のデプロイで変わりうる。古い ID は 409 で拒否されるので、そのときページの JS から取り直し、以後はそれを使う。
let searchActionId = '60e3b76ba7f1d28cf3c3fa01680217528f16cd1984';

interface SagawaSearchResult {
  ok?: boolean;
  message?: string;
  results?: Array<{
    status?: string;
    dateLines?: Array<{ label?: string; value?: string }>;
    pickupOffice?: { name?: string; tel?: string } | null;
    deliveryOffice?: { name?: string; tel?: string } | null;
    history?: Array<{ status?: string; date?: string; office?: string }>;
  }>;
}

function search(num: string, signal: AbortSignal): Promise<Response> {
  const form = new FormData();
  form.set('_1_tracking_number', num); // `$K1` が指すフォームの項目
  form.set('0', '[null,"$K1"]'); // アクションの引数（前回の状態, フォーム）
  return fetch(TRACKING_PAGE, {
    method: 'POST',
    headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Next-Action': searchActionId },
    body: form,
    signal,
  });
}

async function refreshActionId(signal: AbortSignal): Promise<void> {
  const headers = { 'User-Agent': DEFAULT_USER_AGENT };
  const html = await (await fetch(TRACKING_PAGE, { headers, signal })).text();
  const scripts = await Promise.all(
    [...new Set(html.match(/\/k2k\/_next\/static\/chunks\/[\w.-]+\.js/g))].map(
      async (src) => (await fetch(new URL(src, TRACKING_PAGE), { headers, signal })).text(),
    ),
  );
  const id = /"([0-9a-f]{40,})",[^)]*"searchPackages"\)/.exec(scripts.join('\n'))?.[1];
  if (!id) throw new Error('佐川急便の searchPackages アクション ID が見つかりません');
  searchActionId = id;
}

function parseSearchResult(body: string): SagawaSearchResult | null {
  const row = body.split('\n').find((line) => line.startsWith('1:'));
  try {
    return row ? JSON.parse(row.slice(2)) : null;
  } catch {
    return null;
  }
}

export const sagawaAdapter: TrackingCarrierAdapter = {
  code: 'sagawa',
  name: '佐川急便',

  // 新サイトには番号を渡せる URL が無く（入力フォームだけ）、番号に関わらず同じページになる。
  trackingUrl(): string {
    return TRACKING_PAGE;
  },

  detect(trackingNumber: string, hints?: TrackingDetectionHints): CarrierDetectionSignal {
    const num = cleanTrackingNumber(trackingNumber);
    if (!num) return { candidate: false, score: 0, strength: 'weak', reasons: [] };

    const is12 = /^\d{12}$/.test(num);
    const is10 = /^\d{10}$/.test(num);

    if (!is12 && !is10) {
      return { candidate: false, score: 0, strength: 'weak', reasons: ['Sagawa requires 10 or 12 digit numeric code'] };
    }

    let score = is12 ? 75 : 70;
    const strength = 'strong';
    const reasons = [is12 ? 'Matches standard Sagawa 12-digit format' : 'Matches Sagawa 10-digit format'];

    if (hints?.preferredCarriers?.includes('sagawa')) {
      score += 15;
      reasons.push('Boosted by preferredCarriers hint');
    }

    return { candidate: true, score, strength, reasons };
  },

  async track(trackingNumber: string, context?: TrackingContext): Promise<TrackingResult> {
    const num = cleanTrackingNumber(trackingNumber);
    const base = { carrier: 'sagawa', carrierName: sagawaAdapter.name, trackingNumber: num, trackingUrl: TRACKING_PAGE } as const;
    const fail = (statusText: string, error: string): TrackingResult =>
      ({ ...base, status: 'error', statusText, events: [], error });
    const signal = context?.signal || AbortSignal.timeout(10000);

    try {
      let res = await search(num, signal);
      if (res.status === 409) {
        await refreshActionId(signal);
        res = await search(num, signal);
      }

      if (!res.ok) return fail(`佐川急便サーバーエラー (${res.status})`, `HTTP ${res.status}: ${res.statusText}`);

      // 想定外の形（停止・保守のページなど）を「該当なし」と取り違えない。読めなければ error にする。
      const data = parseSearchResult(await res.text());
      const found = data?.ok ? data.results?.[0] : undefined;
      if (!found) return fail('佐川急便の応答を解釈できませんでした', data?.message ?? 'Unexpected response format');

      if (found.status?.includes('該当なし')) {
        return { ...base, status: 'not_found', statusText: '該当するお荷物が見つかりません', events: [] };
      }

      const events: TrackingEvent[] = (found.history ?? []).map((h) => ({
        status: (h.status ?? '').replace(/^[⇒↓]\s*/, ''),
        date: h.date,
        location: h.office || undefined,
      }));
      const currentStatusText = found.status || events.at(-1)?.status || '荷物情報取得';
      // 「配達完了日」「お届け予定日」の行だけを日時として使う（ほかの行の意味は分からない）。
      const deliveryDate = found.dateLines
        ?.find((line) => /配達完了|お届け予定|配達予定/.test(line.label ?? ''))
        ?.value?.replace(/\s+/g, ' ').trim();

      return {
        ...base,
        status: determineStatus(currentStatusText),
        statusText: currentStatusText,
        events,
        details: {
          origin: found.pickupOffice?.name || undefined,
          originPhone: found.pickupOffice?.tel || undefined,
          destination: found.deliveryOffice?.name || undefined,
          destinationPhone: found.deliveryOffice?.tel || undefined,
          deliveryDate: deliveryDate || undefined,
          serviceType: '飛脚宅配便',
        },
      };
    } catch (err) {
      return fail('佐川急便への照会に失敗しました', errorMessage(err) || String(err));
    }
  },

  verify(result: TrackingResult, requestedTrackingNumber: string): TrackingVerification {
    // 佐川の応答は構造化された JSON で、番号が無ければ「該当なし」になる。履歴があるのに状態語だけ分類できない（unknown）
    // ときも、その番号は佐川の荷物。共通の検証は unknown を根拠にしないので、自動判別で別の社に取り違えられてしまう。
    if (
      result.status === 'unknown' &&
      result.events.length > 0 &&
      cleanTrackingNumber(result.trackingNumber) === cleanTrackingNumber(requestedTrackingNumber)
    ) {
      return { level: 'strong', reasons: [`Sagawa returned ${result.events.length} history entries (status text not classified)`] };
    }
    return evaluateTrackingVerification(result, requestedTrackingNumber);
  },
};
