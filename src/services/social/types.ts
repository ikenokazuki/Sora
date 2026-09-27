import { z } from 'zod';

export const SocialPlatformSchema = z.enum(['weibo', 'threads', 'instagram', 'facebook']);
export type SocialPlatform = z.infer<typeof SocialPlatformSchema>;

export const SocialTimeStatusSchema = z.enum(['known', 'date_only', 'unknown', 'conflict']);
export type SocialTimeStatus = z.infer<typeof SocialTimeStatusSchema>;

export const SocialResultStatusSchema = z.enum(['ok', 'partial', 'empty', 'unavailable']);
export type SocialResultStatus = z.infer<typeof SocialResultStatusSchema>;

export const SocialCommentSchema = z.object({
  id: z.string(),
  author: z.string().optional(),
  text: z.string(),
  publishedAt: z.string().optional(),
  postId: z.string(),
});
export type SocialComment = z.infer<typeof SocialCommentSchema>;

export const SocialCommentsSchema = z.object({
  state: z.enum(['fetched', 'not_requested', 'empty', 'failed', 'unsupported']),
  order: z.string().optional(),
  items: z.array(SocialCommentSchema),
  reason: z.string().optional(),
});
export type SocialComments = z.infer<typeof SocialCommentsSchema>;

export const SocialPostSchema = z.object({
  id: z.string(),
  platform: SocialPlatformSchema,
  url: z.string(),
  requestedUrl: z.string(),
  finalUrl: z.string().optional(),
  author: z.string().optional(),
  text: z.string(),
  textKind: z.enum(['full', 'excerpt']),
  publishedAt: z.string().optional(),
  publishedDate: z.string().optional(),
  rawPublishedAt: z.string().optional(),
  retrievedAt: z.string(),
  timeStatus: SocialTimeStatusSchema,
  inRequestedWindow: z.boolean().nullable(),
  method: z.string(),
  searchMode: z.string().optional(),
  metrics: z.record(z.string(), z.number()).optional(),
  metricLabels: z.record(z.string(), z.string()).optional(),
  media: z.array(z.object({ type: z.string(), url: z.string(), thumbnailUrl: z.string().optional() })).optional(),
  comments: SocialCommentsSchema.optional(),
  quotedPost: z.object({ author: z.string().optional(), text: z.string(), url: z.string().optional() }).optional(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});
export type SocialPost = z.infer<typeof SocialPostSchema>;

export const SocialSearchInputSchema = z.object({
  platform: SocialPlatformSchema,
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(30).default(10),
  lookbackHours: z.number().int().min(1).max(2160).default(24),
});
export type SocialSearchInput = z.infer<typeof SocialSearchInputSchema>;

export const SocialFetchInputSchema = z.object({
  url: z.string().min(1),
  commentLimit: z.number().int().min(0).max(20).default(10),
});
export type SocialFetchInput = z.infer<typeof SocialFetchInputSchema>;

export const SocialSearchResultSchema = z.object({
  status: SocialResultStatusSchema,
  platform: SocialPlatformSchema,
  query: z.string(),
  searchMode: z.string(),
  items: z.array(SocialPostSchema),
  matchedInWindow: z.number(),
  unknownTime: z.number(),
  excluded: z.number(),
  failures: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SocialSearchResult = z.infer<typeof SocialSearchResultSchema>;

export const SocialFetchResultSchema = z.object({
  status: SocialResultStatusSchema,
  post: SocialPostSchema.optional(),
  failures: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SocialFetchResult = z.infer<typeof SocialFetchResultSchema>;
