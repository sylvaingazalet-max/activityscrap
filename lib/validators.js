/**
 * Input Validators
 * 
 * Validates API request payloads to ensure data integrity.
 */

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
    return 'Request body is empty';
  }

  // Check prompt is present and is a non-empty string
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return 'Missing or empty "prompt" field (required string)';
  }

  // Validation passed
  return null;
};
