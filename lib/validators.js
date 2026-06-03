/**
 * Input Validators
 *
 * Validates API request payloads to ensure data integrity and proper format.
 * All validation failures are logged for debugging.
 */

const logger = require('./logger');
const contextLog = logger.createLogger('lib/validators');

/**
 * Validate API request payload for /api/gemini endpoint
 *
 * Checks that required fields are present and have correct types:
 * - prompt: Required, must be a non-empty string
 * - companies: Optional, can be array or string
 *
 * @param {object} body - Request body to validate
 *
 * @returns {string|null} Error message if validation fails, null if valid
 */
module.exports.validatePayload = function validatePayload(body) {
  // Check body exists
  if (!body) {
    const error = 'Request body is empty';
    contextLog.warn('Validation failed: empty body');
    return error;
  }

  // Check prompt is present and is a non-empty string
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    const error = 'Missing or empty "prompt" field (required string)';
    contextLog.warn('Validation failed: invalid prompt field', {
      hasPrompt: !!body.prompt,
      promptType: typeof body.prompt,
      promptLength: body.prompt ? body.prompt.length : 0
    });
    return error;
  }

  // Validation passed
  contextLog.debug('Payload validation successful', {
    promptLength: body.prompt.length,
    hasCompanies: !!body.companies
  });
  return null;
};
