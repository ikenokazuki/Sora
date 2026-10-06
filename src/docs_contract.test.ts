import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { generateOpenApiDocument, PoiSearchRequestSchema, zodToOpenApiSchema } from './types.js';
import { systemRoutes } from './routes/system.js';

const sharedPaths = ['/weather', '/weather/{city}', '/traffic/road', '/traffic/road/{pref}', '/gov/diet-minutes', '/geo/elevation', '/geo/poi', '/traffic/flight', '/traffic/flight/{airport}'];
const basePath = (path: string) => path.replace(/\/\{[^}]+\}$/, '');

describe('documentation defaults and enum consistency', () => {
  test('GET parameters share POST descriptions, defaults, bounds and enum values', () => {
    const doc: any = generateOpenApiDocument();
    for (const path of sharedPaths) {
      const props = doc.paths[basePath(path)].post.requestBody.content['application/json'].schema.properties;
      for (const param of doc.paths[path].get.parameters) {
        expect(param.schema, `${path} ${param.name}`).toEqual(props[param.name]);
        expect(param.description, `${path} ${param.name}`).toBe(props[param.name].description);
      }
    }
  });

  test('declares numeric, boolean, array and enum defaults without changing omission semantics', () => {
    const input = z.object({ enabled: z.boolean().optional().meta({ default: false }), count: z.number().optional().meta({ default: 0 }), formats: z.array(z.enum(['markdown', 'html'])).optional().meta({ default: ['markdown'] }), mode: z.enum(['fast', 'browser']).optional().meta({ default: 'fast' }) });
    const { properties } = zodToOpenApiSchema(input);
    expect(properties.enabled.default).toBe(false);
    expect(properties.count.default).toBe(0);
    expect(properties.formats.default).toEqual(['markdown']);
    expect(properties.mode.default).toBe('fast');
    expect(properties.mode).toMatchObject({ type: 'string', enum: ['fast', 'browser'] });
    expect(input.parse({})).toEqual({});
  });

  test('POI test body is valid and starts with actual defaults instead of the minimum radius', () => {
    const doc: any = generateOpenApiDocument();
    const media = doc.paths['/geo/poi'].post.requestBody.content['application/json'];
    expect(media.example).toMatchObject({ query: 'カフェ', center: '原宿', radiusMeters: 5000, limit: 10, noCache: false });
    expect(PoiSearchRequestSchema.safeParse(media.example).success).toBe(true);
    expect(media.example.lat).toBeUndefined();
    expect(media.example.bbox).toBeUndefined();
  });

  test('tracking GET documents the same cache default and accepted carriers as the handler', () => {
    const doc: any = generateOpenApiDocument();
    for (const path of ['/tracking/{carrier}/{number}', '/tracking/{number}']) {
      const params = doc.paths[path].get.parameters;
      expect(params.find((p: any) => p.name === 'noCache').schema.default).toBe(false);
      expect(params.find((p: any) => p.name === 'number').required).toBe(true);
    }
    expect(doc.paths['/tracking/{carrier}/{number}'].get.parameters.find((p: any) => p.name === 'carrier').schema.enum).toContain('auto');
  });

  test('docs pin the renderer and revalidate documentation after updates', async () => {
    for (const path of ['/docs', '/openapi.json']) {
      const res = await systemRoutes.request(path);
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      if (path === '/docs') {
        const html = await res.text();
        expect(html).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\/dist\/browser\/standalone\.js/);
      }
    }
  });
});
