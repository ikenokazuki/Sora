// 「いま呼んでいる利用者（tenant）」を、深い呼び出しまで渡す（設計 6。穴 25）。
//
// 共有の資源（Nominatim・Yahoo・国の情報の提供元・住所データの構築）の待ち行列と予算は、利用者ごとに数える。
// 呼び出しの引数に tenant を足すと、その資源を使う全部の経路（MCP のツール・REST のルート・サービスの中の呼び出し）を直すことになり、
// 1 つ漏れると、その経路の利用者が全員 legacy に混ざる。入口（REST の認証のあと・MCP のツールの呼び出し）で 1 回だけ範囲を作り、
// 共有の資源の側が読む。範囲の外（利用者を持たない経路）は legacy。引数で、別の利用者を名乗ることはできない（範囲は、認証が決めた tenant だけで作る）。
//
// これは、取得・キャッシュ・保存した状態の分離（tenant を型で必須にしている経路）の代わりではない。データの分離には使わない。
import { AsyncLocalStorage } from 'node:async_hooks';
import { LEGACY_TENANT_ID } from './tenant_context.js';

const scope = new AsyncLocalStorage<string>();

/** fn の間（await・タイマーの先を含む）、呼んでいる利用者を tenantId にする。空の tenantId は legacy */
export function runAsCaller<T>(tenantId: string, fn: () => T): T {
  return scope.run(tenantId || LEGACY_TENANT_ID, fn);
}

/** いま呼んでいる利用者。範囲の外は legacy */
export function currentCaller(): string {
  return scope.getStore() ?? LEGACY_TENANT_ID;
}
