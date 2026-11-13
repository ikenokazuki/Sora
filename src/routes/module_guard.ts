import type { MiddlewareHandler } from 'hono';
import { EXPLICIT_ONLY_MODULES } from '../mcp/registry.js';
import { isRestModuleActive, moduleOfOperation } from '../rest_operations.js';
import { formatError } from './utils.js';

/**
 * SORA_MODULES で絞ったモジュールの経路を、REST の入口で閉じる（設計 5。穴 20）。実行される処理の経路（Hono が当てたもの）から、
 * 操作の台帳でモジュールを引く。モジュールを持たない経路（システム・ページ・文書）と、台帳に無い経路は、そのまま通す
 * （台帳に無い経路が無いことは、module_guard.test.ts が app の全部の経路で確かめる）。
 */
export const restModuleGuard: MiddlewareHandler = async (c, next) => {
  // 全体にかかるミドルウェア（ALL）を除いた、最後に当たった経路が、実行される処理
  const route = [...c.req.matchedRoutes].reverse().find((matched) => matched.method !== 'ALL');
  const module = route ? moduleOfOperation(route.method, route.path) : undefined;
  if (module && !isRestModuleActive(module)) {
    const hint = (EXPLICIT_ONLY_MODULES as readonly string[]).includes(module) ? `by name (e.g. SORA_MODULES=all,${module}); "all" alone does not include it.` : `(e.g. SORA_MODULES=all, or add ${module} to the list).`;
    return formatError(c, `${module} module is not enabled. Add it to SORA_MODULES ${hint}`, 'MODULE_DISABLED', 404, false);
  }
  return next();
};
