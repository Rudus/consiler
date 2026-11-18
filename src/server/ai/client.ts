import fs from 'node:fs/promises';
import path from 'node:path';
import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { TaskAttachment } from '../types.js';

let aiClient: GoogleGenAI | null = null;

export function getGenAI(): GoogleGenAI | null {
  if (!config.aiEnabled) return null;
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }
  return aiClient;
}

export async function generateWithTimeout(
  tag: string,
  params: GenerateContentParameters,
  timeoutMs = 45_000
): Promise<GenerateContentResponse> {
  const ai = getGenAI();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const startedAt = Date.now();
  log.info('AI', `-> start (${tag})`, {
    model: params.model,
    timeoutMs,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`AI request timed out after ${timeoutMs}ms (${tag})`));
  }, timeoutMs);

  try {
    const response = await ai.models.generateContent({
      ...params,
      config: {
        ...params.config,
        abortSignal: controller.signal,
        httpOptions: {
          ...params.config?.httpOptions,
          timeout: timeoutMs,
        },
      },
    });

    const elapsed = Date.now() - startedAt;
    const finishReason = response.candidates?.[0]?.finishReason ?? 'UNKNOWN';
    const fnCount = response.functionCalls?.length ?? 0;
    const textLen = response.text?.length ?? 0;
    log.info('AI', `<- done (${tag}) in ${elapsed}ms`, {
      finishReason,
      fnCount,
      textLen,
    });
    return response;
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    log.error('AI', `!! failed (${tag}) after ${elapsed}ms`, err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadAttachmentsAsParts(
  attachments: TaskAttachment[]
): Promise<Part[]> {
  const parts: Part[] = [];
  for (const att of attachments.slice(0, 4)) {
    if (!att.mimeType.startsWith('image/')) continue;
    try {
      const fullPath = path.resolve(config.uploadsDir, path.basename(att.filename));
      const buf = await fs.readFile(fullPath);
      parts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: buf.toString('base64'),
        },
      });
    } catch {
      // Ignore unreadable attachment
    }
  }
  return parts;
}
