/**
 * @nobody/engine — core (no model dependencies, safe for content scripts).
 * Heavy model runtimes live in "@nobody/engine/runtime".
 */
export * from './types.js';
export { detectRules } from './detect/rules.js';
export { detectDictionary, resolveSpans, removeOverlaps, propagate, findWord } from './detect/resolve.js';
export { groupPredictions, alignTokens, chunkText, type TokenPrediction } from './detect/ner-align.js';
export { luhnValid, ibanValid } from './detect/validators.js';
export { Vault, type VaultData, type VaultEntry } from './pseudonymize/vault.js';
export {
  anonymize,
  restore,
  findPlaceholders,
  canonicalPlaceholders,
  type AnonymizeResult,
  type Replacement,
  type PlaceholderMatch,
} from './pseudonymize/anonymize.js';
export { normalizeStyle } from './style/normalize.js';
export { splitProtected, hasProse, type Segment } from './style/protect.js';
export {
  rewriteText,
  splitIntoParts,
  type RewriteOptions,
  verifyRewrite,
  buildRewriteMessages,
  cleanModelOutput,
  type Generate,
  type ChatMessage,
  type RewriteResult,
  type VerifyResult,
} from './style/rewrite.js';
export { REWRITE_MODELS, NER_MODEL, getRewriteModel, type RewriteModel, type StyleTier } from './models/catalog.js';
export { probeDevice, rateModels, FIT_LABELS, type DeviceProbe, type ModelFit, type Fit } from './models/device.js';
