/**
 * @module @ophir/reference-agents
 *
 * Five pre-configured seller agents for testing Ophir negotiations.
 * Each agent specializes in a different service category with
 * domain-specific pricing logic and SLA commitments.
 */

export { createInferenceAgent } from './agents/inference.js';
export { createDataProcessingAgent } from './agents/data-processing.js';
export { createCodeReviewAgent } from './agents/code-review.js';
export { createTranslationAgent } from './agents/translation.js';
export { createImageGenerationAgent } from './agents/image-generation.js';
