/**
 * 認証なしで公開する経路（ヘルスチェック・サービス情報・メトリクス・API ドキュメント）。
 * 認証（auth.ts）と、ブラウザ由来の要求の検査（rest_origin.ts）が同じ一覧を見る。
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/health',
  '/metrics',
  '/openapi.json',
  '/docs',
  '/swagger',
]);

/**
 * 認証なしで公開する経路か。荷物ごとの表示ページ（/t/...）は誰でも開けるが、Sora が発行した署名付きの URL だけを
 * 表示する（services/tracking/page.ts）。EC サイトのページやメールのリンクから開かれるので、ブラウザの別サイト由来の要求も通す。
 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith('/t/');
}

/** MCP の経路。これらは mcp_origin.ts が、ブラウザかどうかによらず Host と Origin を検査する。 */
export const MCP_PATHS: ReadonlySet<string> = new Set(['/mcp', '/sse', '/message']);
