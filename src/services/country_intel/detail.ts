import { z } from 'zod';

export const EvidenceContentKindSchema = z.enum(['title_only', 'excerpt', 'extracted_text', 'structured_record']);
export type EvidenceContentKind = z.infer<typeof EvidenceContentKindSchema>;

export const EvidenceSourceStatusSchema = z.enum(['unverified', 'verified', 'corrected', 'retracted', 'deleted']);
export type EvidenceSourceStatus = z.infer<typeof EvidenceSourceStatusSchema>;

export interface EvidenceTextBlock {
  index: number;
  text: string;
}

export const EvidenceTextBlockSchema = z.object({ index: z.number(), text: z.string() });

export interface EvidenceDetail {
  evidenceId: string;
  providerId: string;
  providerItemId: string;
  sourceRecordUrl: string;
  contentKind: EvidenceContentKind;
  language?: string;
  blocks: EvidenceTextBlock[];
  structuredData?: Record<string, unknown>;
  occurredAt?: string;
  publishedAt?: string;
  updatedAt?: string;
  retrievedAt: string;
  validFrom?: string;
  validUntil?: string;
  timeBasis: string;
  geographyBasis: string;
  sourceStatus: EvidenceSourceStatus;
  contentTruncated: boolean;
}

export const EvidenceDetailSchema = z.object({
  evidenceId: z.string(),
  providerId: z.string(),
  providerItemId: z.string(),
  sourceRecordUrl: z.string(),
  contentKind: EvidenceContentKindSchema,
  language: z.string().optional(),
  blocks: z.array(EvidenceTextBlockSchema),
  structuredData: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.string().optional(),
  publishedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  retrievedAt: z.string(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  timeBasis: z.string(),
  geographyBasis: z.string(),
  sourceStatus: EvidenceSourceStatusSchema,
  contentTruncated: z.boolean(),
});

export interface SourceState {
  sourceId: string;
  lastCheckedAt?: string;
  lastSuccessfulFetchAt?: string;
  providerUpdatedAt?: string;
  lastErrorCode?: string;
  etag?: string;
  lastModified?: string;
  retryAt?: string;
  cursor?: string;
}

export const SourceStateSchema = z.object({
  sourceId: z.string(),
  lastCheckedAt: z.string().optional(),
  lastSuccessfulFetchAt: z.string().optional(),
  providerUpdatedAt: z.string().optional(),
  lastErrorCode: z.string().optional(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  retryAt: z.string().optional(),
  cursor: z.string().optional(),
});

export interface CollectionWindow {
  from: string;
  to: string;
  complete: boolean;
  gaps: { from: string; to: string; reason: string }[];
}
