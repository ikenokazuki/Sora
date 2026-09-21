import { describe, expect, test } from 'bun:test';
import { buildSoraMcpInstructions } from '../../mcp.js';
import { generateOpenApiDocument } from '../../types.js';

describe('intel contract parity', () => {
  test('REST, OpenAPI, and MCP expose the same research_country_context contract', () => {
    const doc = generateOpenApiDocument() as { paths: Record<string, unknown> };
    expect(doc.paths['/intelligence/country']).toBeDefined();
    expect(doc.paths['/intelligence/context/{contextId}']).toBeDefined();
    expect(buildSoraMcpInstructions()).toContain('research_country_context');
    expect(buildSoraMcpInstructions(['web'])).not.toContain('research_country_context');
  });
});
