import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TrackingResult } from './types.js';

// 荷物ごとの表示ページ（GET /t/:carrier/:number?sig=…）。佐川急便のように、公式に送り状番号を渡せる URL が無い
// 運送会社でも、利用者に案内できる URL を Sora が発行する。SORA_TRACKING_PAGE_SECRET と SORA_PUBLIC_URL の
// 両方を設定したときだけ有効（既定は無効）。署名で Sora が発行した URL だけを通し、任意の番号を照会する踏み台にしない。

function pageConfig(): { secret: string; baseUrl: string } | undefined {
  const secret = process.env.SORA_TRACKING_PAGE_SECRET;
  const baseUrl = process.env.SORA_PUBLIC_URL?.replace(/\/+$/, '');
  return secret && baseUrl ? { secret, baseUrl } : undefined;
}

function sign(secret: string, carrier: string, num: string): string {
  return createHmac('sha256', secret).update(`${carrier}:${num}`).digest('base64url').slice(0, 22);
}

export function trackingPageUrl(carrier: string, num: string): string | undefined {
  const config = pageConfig();
  if (!config || !num) return undefined;
  return `${config.baseUrl}/t/${carrier}/${encodeURIComponent(num)}?sig=${sign(config.secret, carrier, num)}`;
}

export function isValidTrackingPage(carrier: string, num: string, sig: string | undefined): boolean {
  const config = pageConfig();
  if (!config || !num || !sig) return false;
  const expected = Buffer.from(sign(config.secret, carrier, num));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (text: string | undefined): string => (text ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

// 電話番号は運送会社の表記のまま見せる。電話をかけるリンクにするのは、数字・ハイフン・括弧・+・空白だけで、数字を含むときだけ。
const telephone = (phone: string | undefined): string => {
  if (!phone) return '';
  const digits = phone.replace(/[^\d+]/g, '');
  return `<br>TEL ${digits && /^[\d\-+() ]+$/.test(phone) ? `<a href="tel:${digits}">${esc(phone)}</a>` : esc(phone)}`;
};

const STATUS_MESSAGES: Partial<Record<TrackingResult['status'], string>> = {
  not_found: '該当するお荷物が見つかりません。送り状番号をお確かめください。出荷の直後は、表示されるまで時間がかかることがあります。',
  error: '現在、配達状況を取得できません。時間をおいて再度お試しいただくか、公式ページでご確認ください。',
  unknown: '配達状況を確認できませんでした。公式ページでご確認ください。',
};

const STYLE = `
body{margin:0;background:#f4f5f7;color:#222;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.6}
main{max-width:760px;margin:0 auto;padding:16px}
.notice{background:#fff8e1;border:1px solid #d9a441;border-radius:4px;padding:12px 14px;margin:0 0 16px;font-size:14px}
h1{font-size:20px;margin:8px 0 12px}
table{width:100%;border-collapse:collapse;background:#fff;margin:0 0 16px;font-size:14px}
th,td{border:1px solid #c9ccd1;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#eceff3;width:30%}
.history th{width:auto}
.history td:nth-child(2){white-space:nowrap}
.status{display:inline-block;background:#4a5563;color:#fff;font-weight:bold;padding:4px 10px;border-radius:2px}
.date{font-weight:bold;margin:0 0 16px}
.message{background:#fff;border:1px solid #c9ccd1;padding:10px;margin:0 0 16px}
.meta{color:#666;font-size:12px}`;

/** 照会結果を、佐川急便のお荷物問い合わせサービスの結果画面と同じ並び・項目名で表示する。公式ページではないことを最初に示す。 */
export function renderTrackingPage(result: TrackingResult): string {
  const carrierName = esc(result.carrierName);
  const num = esc(result.trackingNumber);
  const details = result.details ?? {};
  // 状態を分類できなかっただけで、状態と履歴は取れているなら、「確認できませんでした」とは書かない。
  const message = result.status === 'unknown' && result.events.length > 0 ? undefined : STATUS_MESSAGES[result.status];
  const dateLabel = result.status === 'delivered' ? '配達完了日' : 'お届け予定日';
  const offices = [['集荷営業所', details.origin, details.originPhone], ['配達営業所', details.destination, details.destinationPhone]]
    .filter(([, name]) => name)
    .map(([label, name, phone]) => `<tr><th>${label}</th><td>${esc(name)}${telephone(phone)}</td></tr>`)
    .join('');
  const history = result.events
    .map((e) => `<tr><td>${esc(e.status)}</td><td>${esc(e.date)}</td><td>${esc(e.location)}</td></tr>`)
    .join('');
  const official = /^https?:\/\//.test(result.trackingUrl)
    ? `<p><a href="${esc(result.trackingUrl)}" rel="noopener noreferrer">${carrierName}の公式ページで確認する</a>（送り状番号: ${num}）</p>`
    : '';
  const fetchedAt = result.fetchedAt ? new Date(result.fetchedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>お荷物の配達状況（${carrierName}・非公式の表示）</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="notice" role="note"><strong>このページは${carrierName}の公式ページではありません。</strong>${carrierName}が公開している配達状況を自動で取得して表示しています。最新・正確な情報は、${carrierName}の公式ページでご確認ください。このページで個人情報やお支払い情報の入力を求めることはありません。</div>
<h1>お荷物の配達状況</h1>
<table><tr><th>お問い合せ送り状No.</th><td><strong>${num}</strong></td></tr><tr><th>状態</th><td><span class="status">${esc(result.statusText)}</span></td></tr></table>
${message ? `<p class="message">${message}</p>` : ''}${details.deliveryDate ? `<p class="date">${dateLabel}：${esc(details.deliveryDate)}</p>` : ''}
<table><tr><th>運送会社</th><td>${carrierName}</td></tr>${offices}</table>
${history ? `<table class="history"><tr><th>荷物状況</th><th>日時</th><th>担当営業所</th></tr>${history}</table>` : ''}
${official}
${fetchedAt ? `<p class="meta">取得日時: ${esc(fetchedAt)}（少し前の情報の場合があります）</p>` : ''}
</main>
</body>
</html>
`;
}
