import 'dotenv/config';
import { initLogger, wrapAISDK } from 'braintrust';
import * as ai from 'ai';

// Initialize Braintrust logger
const logger = initLogger({
  projectName: 'bash-evals',
  apiKey: process.env.BRAINTRUST_API_KEY,
  setCurrent: false,
});

// Wrap the AI SDK for automatic tracing of LLM calls
export const { streamText, generateText, ToolLoopAgent } = wrapAISDK(ai);

// Re-export stepCountIs from ai (doesn't need wrapping)
export { stepCountIs } from 'ai';

// Re-export traced and currentSpan for wrapping user requests
export { traced, currentSpan } from 'braintrust';

// Export the logger for manual logging if needed
export { logger };
