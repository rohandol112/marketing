/**
 * Kept as a thin re-export. The LLM layer is no longer Gemini-specific - see
 * llm.js for why (gemini-3.6-flash allows 20 requests a day on the free tier).
 */
export * from './llm.js';
export { generateJson as default } from './llm.js';
