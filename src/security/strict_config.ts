/**
 * `SORA_ISOLATION=strict`（共有のサービス）が、起動のときに求める設定（設計 0。段階 8）。
 * 満たさないものは、黙って弱い側に戻らず、起動を断る。ここは設定の値だけを見る（実行環境は見ない。uid を分けられるか・サンドボックスが実際に
 * 起動できるかは、browser_startup.ts が、起動の計画と、Chromium の試し起動で確かめる）。
 *
 * 求めるもの:
 *  - 名前つきの鍵（SORA_AUTH_KEYS_FILE）: 利用者を分ける単位。単一の鍵（SORA_API_KEY）や鍵なしでは、利用者を分けられない
 *  - Chromium のサンドボックス有効（SORA_BROWSER_SANDBOX=on）: auto は、使えないと黙って --no-sandbox に戻る
 *  - 出口のゲートウェイ（SORA_EGRESS_GATEWAY=on）: 内部への取得を許す設定（SORA_FETCH_ALLOW_PRIVATE_NETWORK=true）と併せると、使われなくなる
 *  - Chromium の uid を落とす（SORA_BROWSER_UID が off でない）: tenant ごとのブラウザを、uid で分けるため
 * tenant ごとのブラウザ・tenant ごとの上限は、strict で自動的に有効になるので、設定を求めない。
 */
import { envBool, envPath, envRaw, type Env } from '../config.js';

/** 問題の文は、変数の名前と、何にすればよいかを含める。すべてを返す（1 つ直すたびに起動し直させない） */
export function strictConfigProblems(env: Env, transport: 'http' | 'stdio'): string[] {
  const problems: string[] = [];
  const strict = (need: string) => `SORA_ISOLATION=strict では、${need}`;

  if (transport === 'stdio') {
    problems.push(strict('stdio は使えません。strict は共有のサービス（HTTP）用で、stdio には、利用者を分ける鍵がありません（SORA_ISOLATION を外すか、standard にしてください）'));
  } else if (!envPath('SORA_AUTH_KEYS_FILE', env)) {
    problems.push(
      strict('SORA_AUTH_KEYS_FILE（名前つきの複数の鍵のファイル）が必要です。単一の鍵（SORA_API_KEY）や鍵なしでは、利用者ごとに状態を分けられません（形式は README の「名前つきの複数の鍵」）'),
    );
  }

  if (envRaw('SORA_BROWSER_SANDBOX', env)?.trim().toLowerCase() !== 'on') {
    problems.push(
      strict('SORA_BROWSER_SANDBOX=on が必要です。auto（未設定を含む）は、サンドボックスを使えないと、黙って --no-sandbox に戻ります（Docker では deploy/seccomp-sora.json を渡します。README の「Chromium 自身のサンドボックス」）'),
    );
  }

  if (!envBool('SORA_EGRESS_GATEWAY', env)) {
    problems.push(strict('SORA_EGRESS_GATEWAY=on が必要です。外向きの通信を、出口のゲートウェイに通して、内部のネットワークへの接続を断ちます'));
  } else if (envBool('SORA_FETCH_ALLOW_PRIVATE_NETWORK', env)) {
    problems.push(
      strict('SORA_FETCH_ALLOW_PRIVATE_NETWORK=true は使えません。この設定のとき、出口のゲートウェイは使われません（内部のネットワークへ出られてしまいます）。外してください。内部の特定の宛先だけを通すなら、SORA_EGRESS_ALLOW_HOSTS を使います'),
    );
  }

  if (envRaw('SORA_BROWSER_UID', env)?.trim().toLowerCase() === 'off') {
    problems.push(strict('SORA_BROWSER_UID=off は使えません。tenant ごとの Chromium を、別の uid に落として分けるためです。auto にするか、数を指定してください'));
  }

  return problems;
}
