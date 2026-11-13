// 取得が、tenant の保存済みの状態（Cookie・localStorage）を使ったかを集める印（設計 5。穴 16）。
// 取得の側（静的取得・ブラウザ）が、状態つきで始めたときに印を立て、結果を置く側（scrapeUrl・integratedSearch）が、
// 印が立ったなら tenant ごとのキーに置き、立たなければ共有のキーに置く。印は、リクエストごと（AsyncLocalStorage）で、
// 内側の範囲（integratedSearch の中の scrapeUrl）の印は、外側にも伝わる。
import { AsyncLocalStorage } from 'node:async_hooks';

interface Scope {
  used: boolean;
  parent?: Scope;
}

const scopes = new AsyncLocalStorage<Scope>();

/** fn の中で、tenant の状態が使われたかを集める。使われたら used が true（内側の範囲の印は、外側にも伝わる） */
export async function trackTenantState<T>(fn: () => Promise<T>): Promise<{ value: T; used: boolean }> {
  const scope: Scope = { used: false, parent: scopes.getStore() };
  const value = await scopes.run(scope, fn);
  return { value, used: scope.used };
}

/** 取得が、tenant の保存済みの状態を持って始まった。いまの範囲と、その外側すべてに印を立てる（範囲の外なら何もしない） */
export function markTenantStateUsed(): void {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) scope.used = true;
}

/** いまの範囲で、状態が使われたか（結果を置く側が、置く直前に見る） */
export function tenantStateUsed(): boolean {
  return scopes.getStore()?.used ?? false;
}

/** tenant の状態で得た結果の、キャッシュのキー。tenant ごとに別で、前置き（tenant:<ID>:）から、その tenant の分を探せる */
export function tenantCacheKey(tenantId: string, key: string): string {
  return `tenant:${tenantId}:${key}`;
}
