import { Hono } from 'hono';
import {
  inspectImage,
  InspectImageRequestSchema,
} from '../scraper.js';
import { formatError } from './utils.js';

export const mediaRoutes = new Hono();

// ==========================================
// 3.4 Media & Vision OCR APIs
// ==========================================
mediaRoutes.post('/media/inspect-image', async (c) => {
  let rawBody: any;
  try {
    rawBody = await c.req.json();
  } catch {
    return formatError(c, 'Invalid JSON body', 'INVALID_JSON', 400, false);
  }

  const parsed = InspectImageRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'url'}: ${issue.message}` : 'url is required';
    return formatError(c, message, 'INVALID_INPUT', 400, false, parsed.error.format());
  }

  try {
    const result = await inspectImage(parsed.data);
    return c.json(result);
  } catch (err: any) {
    return formatError(c, err.message || 'Image inspection failed', 'MEDIA_ERROR', 500);
  }
});
