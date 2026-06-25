/**
 * Re-export from src/shared/config.ts for backward compatibility.
 */

export {
  TypegraphConfigSchema,
  type TypegraphConfig,
  type ConfigValidationResult,
  validateConfig,
  resolveConfig,
} from "./src/shared/config.js";
