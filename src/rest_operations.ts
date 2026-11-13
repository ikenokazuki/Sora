/**
 * REST の操作の台帳。
 * - OpenAPI の各操作に operationId・タグ・認証・エラー応答を足す（finalizeOpenApi）。
 * - GET /tools（言語に依存しない、操作の一覧と 1 つ分の定義）の元になる（listRestTools・describeRestTool）。
 *
 * 名前（id）は v4 までの MCP のツール名と同じ。MCP のツールを統合した v5.0.0 のあとも、REST は変えない決定なので、
 * この名前はそのまま使う（docs/superpowers/specs/2026-11-11-tool-consolidation-design.md の「REST と client」）。
 * 一覧に載せるのは「正本」の操作だけ。別名・GET で呼ぶ形・進行状況の SSE・システムの経路は、正本の定義の
 * alternatives に載せる（GET /tools/<name>）か、一覧に出さない。
 */
import { isModuleActive } from './mcp/registry.js';
import { isPublicPath } from './security/public_paths.js';

export type RestMethod = 'GET' | 'POST' | 'DELETE';

export interface RestTool {
  /** operationId であり、GET /tools/<name> の名前 */
  id: string;
  method: RestMethod;
  /** OpenAPI の書き方（パスの変数は {id}） */
  path: string;
  /** MCP のモジュール名（search_tools の category と同じ） */
  category: string;
}

const t = (id: string, method: RestMethod, path: string, category: string): RestTool => ({ id, method, path, category });

/** 一覧に載せる操作。lyrics・shazam・hts-archive の操作は、モジュールが有効なときだけ OpenAPI に出る。 */
export const REST_TOOLS: readonly RestTool[] = [
  t('scrape', 'POST', '/scrape', 'web'),
  t('scrape_batch', 'POST', '/scrape/batch', 'web'),
  t('crawl_site', 'POST', '/crawl', 'web'),
  t('map_site', 'POST', '/map', 'web'),
  t('browser_action', 'POST', '/browser/action', 'browser'),
  t('search_web', 'POST', '/search/web', 'web'),
  t('search_deep', 'POST', '/search/deep', 'web'),
  t('search_social_posts', 'POST', '/social/search', 'web'),
  t('fetch_social_post', 'POST', '/social/fetch', 'web'),
  t('search_image', 'POST', '/search/image', 'yahoo'),
  t('search_video', 'POST', '/search/video', 'yahoo'),
  t('search_news', 'POST', '/search/news', 'yahoo'),
  t('search_chiebukuro', 'POST', '/search/chiebukuro', 'yahoo'),
  t('search_trend', 'POST', '/search/trend', 'yahoo'),
  t('search_realtime', 'POST', '/search/realtime', 'yahoo'),
  t('fetch_x_post', 'POST', '/realtime/post', 'yahoo'),
  t('suggest_keywords', 'POST', '/search/suggest', 'yahoo'),
  t('search_route', 'POST', '/transit/route', 'life'),
  t('get_weather', 'POST', '/weather', 'life'),
  t('get_flight_status', 'POST', '/traffic/flight', 'life'),
  t('track_package', 'POST', '/tracking', 'life'),
  t('search_disaster_warnings', 'POST', '/disaster/warnings', 'disaster'),
  t('search_earthquake', 'POST', '/disaster/earthquake', 'disaster'),
  t('search_road_traffic', 'POST', '/traffic/road', 'disaster'),
  t('get_elevation', 'POST', '/geo/elevation', 'disaster'),
  t('search_poi', 'POST', '/geo/poi', 'disaster'),
  t('search_postal_code', 'POST', '/geo/postal-code', 'disaster'),
  t('normalize_address', 'POST', '/geo/address/normalize', 'disaster'),
  t('reverse_geocode', 'POST', '/geo/reverse', 'disaster'),
  t('watch_register', 'POST', '/watch/register', 'watch'),
  t('watch_check', 'POST', '/watch/check', 'watch'),
  t('watch_list', 'GET', '/watch/list', 'watch'),
  t('watch_delete', 'DELETE', '/watch/{id}', 'watch'),
  t('search_song', 'POST', '/search/song', 'music'),
  t('search_artist', 'POST', '/search/artist', 'music'),
  t('search_music', 'POST', '/search/music', 'music'),
  t('search_laws', 'POST', '/gov/laws', 'gov'),
  t('get_law_text', 'POST', '/gov/law-text', 'gov'),
  t('search_diet_minutes', 'POST', '/gov/diet-minutes', 'gov'),
  t('check_cpsc_certificate', 'POST', '/trade/cpsc-check', 'trade'),
  t('check_fda_regulated', 'POST', '/trade/fda-check', 'trade'),
  t('verify_hts_code', 'POST', '/trade/hts-verify', 'trade'),
  t('predict_hts_code', 'POST', '/trade/hts-predict', 'trade'),
  t('check_product_compliance', 'POST', '/trade/compliance', 'trade'),
  t('generate_gcc_certificate', 'POST', '/trade/gcc-generate', 'trade'),
  t('inspect_image', 'POST', '/media/inspect-image', 'media'),
  t('get_youtube_transcript', 'POST', '/youtube/transcript', 'youtube'),
  t('get_youtube_channel', 'POST', '/youtube/channel', 'youtube'),
  t('research_country_context', 'POST', '/intelligence/country', 'intel'),
  t('get_country_context', 'GET', '/intelligence/context/{contextId}', 'intel'),
  t('get_country_context_evidence', 'GET', '/intelligence/context/{contextId}/evidence', 'intel'),
  t('get_country_context_updates', 'GET', '/intelligence/context/{contextId}/updates', 'intel'),
  // SORA_MODULES に名前を挙げたときだけ有効になるもの
  t('get_lyrics', 'POST', '/lyrics', 'lyrics'),
  t('recognize_song', 'POST', '/music/recognize', 'shazam'),
  // REST にだけある操作（MCP のツールは無い）
  t('recognize_song_signature', 'POST', '/music/recognize/signature', 'shazam'),
  t('list_hts_releases', 'GET', '/trade/hts/releases', 'hts-archive'),
  t('get_hts_release', 'GET', '/trade/hts/releases/{id}', 'hts-archive'),
];

/**
 * alias: 同じ処理の別のパス。get: 同じ処理を GET（path・query）で呼ぶ形。stream: 進行状況を SSE で返す形。
 * system・page: 一覧に載せない（サービスの情報・ヘルスチェック・操作の一覧・HTML のページなど）。
 */
export type OtherKind = 'alias' | 'get' | 'stream' | 'system' | 'page';
export interface OtherOperation { id: string; kind: OtherKind; of?: string }

export const OTHER_OPERATIONS: Readonly<Record<string, OtherOperation>> = {
  'GET /': { id: 'get_service_info', kind: 'system' },
  'GET /health': { id: 'get_health', kind: 'system' },
  'GET /metrics': { id: 'get_metrics', kind: 'system' },
  'POST /cache/clear': { id: 'clear_cache', kind: 'system' },
  'GET /tools': { id: 'list_tools', kind: 'system' },
  'GET /tools/{name}': { id: 'get_tool', kind: 'system' },
  'GET /t/{carrier}/{number}': { id: 'get_tracking_page', kind: 'page' },
  'POST /scrape/stream': { id: 'scrape_stream', kind: 'stream', of: 'scrape' },
  'POST /crawl/stream': { id: 'crawl_site_stream', kind: 'stream', of: 'crawl_site' },
  'POST /action': { id: 'browser_action_alias', kind: 'alias', of: 'browser_action' },
  'POST /search': { id: 'search_deep_alias', kind: 'alias', of: 'search_deep' },
  'POST /search/integrated': { id: 'search_deep_alias_integrated', kind: 'alias', of: 'search_deep' },
  'POST /deep-search': { id: 'search_deep_alias_deep_search', kind: 'alias', of: 'search_deep' },
  'POST /realtime': { id: 'search_realtime_alias', kind: 'alias', of: 'search_realtime' },
  'POST /search/music/song': { id: 'search_song_alias', kind: 'alias', of: 'search_song' },
  'POST /search/music/artist': { id: 'search_artist_alias', kind: 'alias', of: 'search_artist' },
  'GET /weather': { id: 'get_weather_query', kind: 'get', of: 'get_weather' },
  'GET /weather/{city}': { id: 'get_weather_by_city', kind: 'get', of: 'get_weather' },
  'GET /traffic/road': { id: 'search_road_traffic_query', kind: 'get', of: 'search_road_traffic' },
  'GET /traffic/road/{pref}': { id: 'search_road_traffic_by_pref', kind: 'get', of: 'search_road_traffic' },
  'GET /traffic/flight': { id: 'get_flight_status_query', kind: 'get', of: 'get_flight_status' },
  'GET /traffic/flight/{airport}': { id: 'get_flight_status_by_airport', kind: 'get', of: 'get_flight_status' },
  'GET /gov/diet-minutes': { id: 'search_diet_minutes_query', kind: 'get', of: 'search_diet_minutes' },
  'GET /geo/elevation': { id: 'get_elevation_query', kind: 'get', of: 'get_elevation' },
  'GET /geo/poi': { id: 'search_poi_query', kind: 'get', of: 'search_poi' },
  'GET /geo/postal-code': { id: 'search_postal_code_query', kind: 'get', of: 'search_postal_code' },
  'GET /geo/address/normalize': { id: 'normalize_address_query', kind: 'get', of: 'normalize_address' },
  'GET /geo/reverse': { id: 'reverse_geocode_query', kind: 'get', of: 'reverse_geocode' },
  'GET /tracking/{carrier}/{number}': { id: 'track_package_by_carrier_and_number', kind: 'get', of: 'track_package' },
  'GET /tracking/{number}': { id: 'track_package_by_number', kind: 'get', of: 'track_package' },
};

export const operationKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

const TOOL_BY_KEY = new Map(REST_TOOLS.map((tool) => [operationKey(tool.method, tool.path), tool]));
const TOOL_BY_ID = new Map(REST_TOOLS.map((tool) => [tool.id, tool]));

/**
 * 経路が属するモジュール（台帳のカテゴリ）。別名・GET の形・進行状況の SSE は、正本のカテゴリ。
 * システム・ページ（モジュールに属さない経路）と、台帳に無い経路は undefined。path は、台帳の書き方（/watch/{id}）でも、
 * Hono の書き方（/watch/:id）でもよい
 */
export function moduleOfOperation(method: string, path: string): string | undefined {
  const key = operationKey(method, path.replace(/:([A-Za-z_]\w*)/g, '{$1}'));
  const tool = TOOL_BY_KEY.get(key);
  if (tool) return tool.category;
  const other = OTHER_OPERATIONS[key];
  return other?.of ? TOOL_BY_ID.get(other.of)?.category : undefined;
}

/**
 * モジュールが有効か（SORA_MODULES）。MCP のツールの登録と同じ規則: media は、media か web のどちらかで有効
 * （画像の確認は、web の取得の一部として使えるため）
 */
export function isRestModuleActive(module: string): boolean {
  if (module === 'media') return isModuleActive('media') || isModuleActive('web');
  return isModuleActive(module as Parameters<typeof isModuleActive>[0]);
}

/** 台帳に無い操作（これから足す経路など）にも、重ならない operationId を付ける。テストが台帳の漏れを見つける。 */
function fallbackId(method: string, path: string): string {
  return `${method.toLowerCase()}_${path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/** エラー応答の本文（formatError の形）。auth・Origin 検査・各ルートの応答がこの形にそろっている。 */
const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'エラーの内容' },
    code: { type: 'string', description: 'エラーコード（INVALID_INPUT・NOT_FOUND・UNAUTHORIZED など）' },
    status: { type: 'integer', description: 'HTTP ステータス' },
    retryable: { type: 'boolean', description: 'true のときだけ、間を置いて再試行してよい' },
    details: { description: '入力エラーの項目ごとの詳細など（無いこともある）' },
  },
  required: ['error', 'code', 'status', 'retryable'],
};
const ERROR_CONTENT = { 'application/json': { schema: ERROR_SCHEMA } };

type Json = Record<string, any>;

function describeAlternative(other: OtherOperation, canonical: RestTool | undefined): string | undefined {
  const where = canonical ? `${canonical.method} ${canonical.path}（operationId: ${canonical.id}）` : '';
  if (other.kind === 'alias') return `別名。正本は ${where}。`;
  if (other.kind === 'get') return `同じ処理を GET（path・query）で呼ぶ形。正本は ${where}。`;
  if (other.kind === 'stream') return `進行状況を SSE（text/event-stream）で返す形。正本は ${where}。`;
  return undefined;
}

/**
 * OpenAPI の文書に、operationId・タグ・認証・エラー応答を足す。入力の文書は変えない
 * （別名の経路は同じ操作のオブジェクトを共有しているので、操作ごとに作り直す）。
 * スキーマは各操作の中に直接書かれたままで、$ref は使わない（1 つの操作の定義を取り出せば、それだけで完結する）。
 */
export function finalizeOpenApi<T extends { paths: object }>(doc: T): Omit<T, 'paths'> & { paths: Record<string, Json>; components: Json; security: Json[] } {
  const paths: Record<string, Json> = {};
  for (const [path, item] of Object.entries(doc.paths as Record<string, Json>)) {
    paths[path] = {};
    for (const [method, op] of Object.entries<Json>(item)) {
      const key = operationKey(method, path);
      const tool = TOOL_BY_KEY.get(key);
      const other = OTHER_OPERATIONS[key];
      const canonical = other?.of ? TOOL_BY_ID.get(other.of) : undefined;
      const category = tool?.category ?? canonical?.category ?? 'system';
      // SORA_MODULES で絞ったモジュールの経路は、REST で 404 になる（routes/module_guard.ts）ので、文書にも載せない
      if (category !== 'system' && !isRestModuleActive(category)) continue;
      const responses: Json = {};
      for (const [code, response] of Object.entries<Json>(op.responses ?? {})) {
        responses[code] = code.startsWith('2') || response.content || other?.kind === 'page' ? response : { ...response, content: ERROR_CONTENT };
      }
      if (other?.kind !== 'page' && !responses.default) {
        responses.default = { description: 'エラー。本文は { error, code, status, retryable, details? }', content: ERROR_CONTENT };
      }
      const note = other ? describeAlternative(other, canonical) : undefined;
      // パスの変数は、OpenAPI では必ず parameters に宣言する（宣言の無いものは、文字列の必須の引数として足す）
      const declared = new Set<string>((op.parameters ?? []).filter((p: Json) => p.in === 'path').map((p: Json) => p.name));
      const undeclared = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((name) => !declared.has(name));
      const parameters = [...(op.parameters ?? []), ...undeclared.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }))];
      paths[path][method] = {
        ...op,
        operationId: tool?.id ?? other?.id ?? fallbackId(method, path),
        tags: [category],
        ...(note ? { description: op.description ? `${op.description}\n${note}` : note } : {}),
        ...(isPublicPath(path) ? { security: [] } : {}),
        ...(parameters.length ? { parameters } : {}),
        responses,
      };
    }
    if (Object.keys(paths[path]).length === 0) delete paths[path];
  }
  return {
    ...doc,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API キー。キーを設定していないサーバーは、認証なしで使える' },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Authorization: Bearer の代わりに使える' },
      },
    },
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }, {}],
  };
}

interface OpenApiLike { paths: Record<string, Json> }

const operationOf = (doc: OpenApiLike, tool: RestTool): Json | undefined => doc.paths[tool.path]?.[tool.method.toLowerCase()];

export interface RestToolSummary { name: string; method: RestMethod; path: string; category: string; summary: string }

/**
 * 一覧に載せる操作（モジュールが無効で OpenAPI に出ていないものは除く）。
 * q: 空白で区切った語をすべて含むものだけ（名前・パス・カテゴリ・概要を、大文字小文字を区別せずに見る）。category: そのカテゴリだけ。
 */
export function listRestTools(doc: OpenApiLike, filter: { q?: string; category?: string } = {}): RestToolSummary[] {
  const words = (filter.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out: RestToolSummary[] = [];
  for (const tool of REST_TOOLS) {
    const op = operationOf(doc, tool);
    if (!op) continue;
    if (filter.category && tool.category !== filter.category) continue;
    const summary = String(op.summary ?? '');
    const haystack = `${tool.id} ${tool.path} ${tool.category} ${summary}`.toLowerCase();
    if (words.some((word) => !haystack.includes(word))) continue;
    out.push({ name: tool.id, method: tool.method, path: tool.path, category: tool.category, summary });
  }
  return out;
}

/**
 * 1 つの操作の定義。入力（parameters・request）と、文書にある非 2xx の状態を返す。
 * 応答のスキーマは大きいことがある（中央値 約 1.9KB、最大 約 70KB）ので、response: true のときだけ付ける。
 */
export function describeRestTool(doc: OpenApiLike, name: string, options: { response?: boolean } = {}): Json | undefined {
  const tool = TOOL_BY_ID.get(name);
  const op = tool && operationOf(doc, tool);
  if (!tool || !op) return undefined;
  const body = op.requestBody?.content?.['application/json'];
  const ok = Object.entries<Json>(op.responses ?? {}).find(([code]) => code.startsWith('2'))?.[1];
  const okContent = ok?.content && Object.entries<Json>(ok.content)[0];
  const errors = Object.entries<Json>(op.responses ?? {})
    .filter(([code]) => !code.startsWith('2') && code !== 'default')
    .map(([status, response]) => ({ status, description: String(response.description ?? '') }));
  const alternatives = Object.entries(OTHER_OPERATIONS)
    .filter(([, other]) => other.of === tool.id)
    .map(([k, other]) => ({ kind: other.kind, ...splitKey(k) }))
    .filter(({ method, path }) => doc.paths[path]?.[method.toLowerCase()]);
  return {
    name: tool.id,
    method: tool.method,
    path: tool.path,
    category: tool.category,
    summary: String(op.summary ?? ''),
    ...(op.parameters?.length ? { parameters: op.parameters } : {}),
    ...(body ? { request: { contentType: 'application/json', schema: body.schema, ...(body.example !== undefined ? { example: body.example } : {}) } } : {}),
    ...(options.response && okContent ? { response: { contentType: okContent[0], schema: okContent[1].schema } } : {}),
    ...(errors.length ? { errors } : {}),
    ...(alternatives.length ? { alternatives } : {}),
  };
}

function splitKey(k: string): { method: string; path: string } {
  const i = k.indexOf(' ');
  return { method: k.slice(0, i), path: k.slice(i + 1) };
}
