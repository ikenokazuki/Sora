import { afterEach, describe, expect, test } from 'bun:test';
import { isModuleActive } from './mcp/registry.js';

const savedModules = process.env.ENABLED_MODULES;
afterEach(() => {
  if (savedModules === undefined) delete process.env.ENABLED_MODULES;
  else process.env.ENABLED_MODULES = savedModules;
});

describe('hts-archive module is explicit opt-in', () => {
  test('all, wildcard and unset do not enable it; naming it does', () => {
    delete process.env.ENABLED_MODULES;
    expect(isModuleActive('hts-archive')).toBe(false);
    process.env.ENABLED_MODULES = 'all';
    expect(isModuleActive('hts-archive')).toBe(false);
    process.env.ENABLED_MODULES = '*';
    expect(isModuleActive('hts-archive')).toBe(false);
    expect(isModuleActive('hts-archive', ['all'])).toBe(false);
    process.env.ENABLED_MODULES = 'all,hts-archive';
    expect(isModuleActive('hts-archive')).toBe(true);
  });
});
