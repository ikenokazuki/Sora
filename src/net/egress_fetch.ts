/**
 * Bun の fetch（globalThis.fetch）を、出口のゲートウェイに通す包み。SORA_EGRESS_GATEWAY=on のときだけ、proxy にゲートウェイを指定する。
 * 天気・防災・荷物追跡などの固定の提供元・webhook・提供元の応答が決める URL は、どれも、この fetch で取る（設計 1。穴 8 の B・C）ので、
 * 接続の固定（検査した IP につなぐ）・ポートの制限・DNS の失敗を閉じることが、そのまま効く。
 * 使わないときは、何も変えない（引数の数も中身も、元の fetch にそのまま渡す）。
 * 起動の入口（index.ts・stdio.ts）が、起動時の検査のあとに、1 回だけ呼ぶ。
 * 設計: docs/superpowers/specs/2026-11-12-isolation-design.md の設計 1（E17）。
 */
import { envForgetNoProxy } from '../config.js';
import { getEgressGateway, isEgressGatewayEnabled } from './egress.js';
import type { EgressGatewayOptions } from './egress_gateway.js';

let installed: { original: typeof fetch; wrapped: typeof fetch } | undefined;

/** 呼び出しごとに指定された proxy（文字列か、`{ url }`）の URL。指定がなければ undefined */
function requestedProxy(init: unknown): string | undefined {
  const proxy = (init as { proxy?: unknown } | undefined)?.proxy;
  if (proxy === undefined) return undefined;
  return typeof proxy === 'string' ? proxy : String((proxy as { url?: unknown } | null)?.url);
}

async function throughGateway(original: typeof fetch, args: Parameters<typeof fetch>, options: EgressGatewayOptions): Promise<Response> {
  const [input, init] = args;
  const gateway = await getEgressGateway(options);
  // ゲートウェイは、運用者の NO_PROXY を、作るときに読み終えた。Bun は、NO_PROXY が挙げた宛先には、指定したプロキシも使わず、直接つなぐ（E17）ので、
  // その後で、プロセスの環境から外す（外す前に呼ぶと、ゲートウェイが、迂回の指定を失う）
  envForgetNoProxy();
  const requested = requestedProxy(init);
  if (requested !== undefined && requested !== gateway.url) {
    throw new Error('SORA_EGRESS_GATEWAY=on のときは、呼び出しごとのプロキシの指定は使えない（出口のゲートウェイを迂回してしまう）。運用者のプロキシは、SORA_PROXY_URL などで、ゲートウェイの上流にする');
  }
  return original(input, { ...(init as RequestInit | undefined), proxy: gateway.url });
}

/** 設定の誤りは、使わないことにせず、そのまま投げる（打ち間違いで、ゲートウェイが黙って外れない） */
export function installEgressFetch(options: EgressGatewayOptions = {}): void {
  if (installed) return;
  const original = globalThis.fetch;
  const wrapped = Object.assign(
    (...args: Parameters<typeof fetch>): Promise<Response> => {
      try {
        return isEgressGatewayEnabled() ? throughGateway(original, args, options) : original(...args);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    {
      // 先行の接続は、ゲートウェイを通らない。使うときは、何もしない（いまの呼び出し元には、無い）
      preconnect: (...args: Parameters<typeof fetch.preconnect>): void => {
        try {
          if (isEgressGatewayEnabled()) return;
        } catch {
          return;
        }
        original.preconnect(...args);
      },
    },
  ) as typeof fetch;
  globalThis.fetch = wrapped;
  installed = { original, wrapped };
}

/** 包みを外して、元の fetch に戻す（テスト用）。ほかのコードが、そのあとに fetch を差し替えていたら、それは戻さない */
export function uninstallEgressFetch(): void {
  if (!installed) return;
  if (globalThis.fetch === installed.wrapped) globalThis.fetch = installed.original;
  installed = undefined;
}
