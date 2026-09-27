import { expect, test } from 'bun:test';
import { buildContentView } from './domains/content.js';
import { buildMarketingView } from './domains/marketing.js';
import { buildTravelView } from './domains/travel.js';
import { buildFinanceView } from './domains/finance.js';
import type { IntelligenceSignal } from './types.js';

function signal(key: string): IntelligenceSignal {
  return {
    key, regionId: 'country:KR', kind: 'count', value: 3, window: '7d',
    observedAt: '2026-09-19T00:00:00Z', activityState: 'elevated',
    evidenceIds: ['ev-1'], providerIds: ['gdelt'], coverage: 'good',
  };
}

const coverage = 'good' as const;
const signals = [
  signal('media_article_count'),
  signal('protest_event_count'),
  signal('disaster_event_count'),
  signal('trade_restriction_count'),
  signal('business_action_count'),
];

test('content view surfaces attention, disaster, and social signals', () => {
  const view = buildContentView({ regionId: 'country:KR', signals, coverage });
  expect(view.attention.map((s) => s.key)).toContain('media_article_count');
  expect(view.disaster.map((s) => s.key)).toContain('disaster_event_count');
  expect(view.socialActivity.map((s) => s.key)).toContain('protest_event_count');
  expect(JSON.stringify(view).toLowerCase()).not.toContain('recommend');
});

test('marketing view surfaces business and attention signals', () => {
  const view = buildMarketingView({ regionId: 'country:KR', signals, coverage });
  expect(view.businessActivity.map((s) => s.key)).toContain('business_action_count');
  expect(view.attention.map((s) => s.key)).toContain('media_article_count');
  expect(JSON.stringify(view).toLowerCase()).not.toContain('recommend');
});

test('travel view surfaces disaster signals without travel advice', () => {
  const view = buildTravelView({ regionId: 'country:KR', signals, coverage });
  expect(view.disasterSignals.map((s) => s.key)).toContain('disaster_event_count');
  expect(JSON.stringify(view).toLowerCase()).not.toContain('recommend');
});

test('finance view surfaces trade and business signals without investment advice', () => {
  const view = buildFinanceView({ regionId: 'country:KR', signals, coverage });
  expect(view.trade.map((s) => s.key)).toContain('trade_restriction_count');
  expect(view.businessAction.map((s) => s.key)).toContain('business_action_count');
  const text = JSON.stringify(view).toLowerCase();
  expect(text).not.toContain('recommend');
  expect(text).not.toContain('invest');
});
