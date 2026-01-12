import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

/**
 * Supported model identifiers (friendly names)
 */
export type ModelId =
  | 'claude-opus-4-5'
  | 'claude-sonnet-4-5'
  | 'claude-haiku-4-5'
  | 'gpt-5.1'
  | 'gpt-5'
  | 'gpt-5-mini'
  | 'gpt-5-nano';

/**
 * Model configuration with official API model strings
 */
const MODEL_CONFIG: Record<ModelId, { provider: 'anthropic' | 'openai'; modelId: string }> = {
  'claude-opus-4-5': { provider: 'anthropic', modelId: 'claude-opus-4-5' },
  'claude-sonnet-4-5': { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  'claude-haiku-4-5': { provider: 'anthropic', modelId: 'claude-haiku-4-5' },
  'gpt-5.1': { provider: 'openai', modelId: 'gpt-5.1' },
  'gpt-5': { provider: 'openai', modelId: 'gpt-5' },
  'gpt-5-mini': { provider: 'openai', modelId: 'gpt-5-mini' },
  'gpt-5-nano': { provider: 'openai', modelId: 'gpt-5-nano' },
};

/**
 * Default model if none specified
 */
export const DEFAULT_MODEL: ModelId = 'claude-opus-4-5';

/**
 * Get model from environment variable or default
 */
export function getModelFromEnv(): ModelId {
  const envModel = process.env.MODEL;
  if (envModel && isValidModelId(envModel)) {
    return envModel;
  }
  return DEFAULT_MODEL;
}

/**
 * Check if a string is a valid ModelId
 */
export function isValidModelId(id: string): id is ModelId {
  return id in MODEL_CONFIG;
}

/**
 * Get all supported model IDs
 */
export function getSupportedModels(): ModelId[] {
  return Object.keys(MODEL_CONFIG) as ModelId[];
}

/**
 * Create a language model instance from a ModelId
 */
export function createModel(modelId: ModelId): LanguageModel {
  const config = MODEL_CONFIG[modelId];
  if (!config) {
    throw new Error(
      `Unknown model: ${modelId}. Supported models: ${getSupportedModels().join(', ')}`,
    );
  }

  if (config.provider === 'anthropic') {
    return anthropic(config.modelId);
  } else {
    return openai(config.modelId);
  }
}
