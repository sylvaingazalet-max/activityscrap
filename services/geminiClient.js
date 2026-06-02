/**
 * Gemini AI Client
 * 
 * Wrapper around Google's Generative AI API (Gemini).
 * Used to generate content based on prompts with company information and job postings.
 * 
 * Environment Variables:
 * - GEMINI_API_KEY (required): Google Gemini API key
 * - GEMINI_MODEL (optional): Model ID (default: 'gemini-3.5-flash')
 */

const { fetchWithTimeout } = require('../lib/http');

// ============================================================================
// Configuration
// ============================================================================

// API endpoint for Gemini content generation
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Generate content using Google's Gemini API
 * 
 * Sends a text prompt to Gemini and returns the generated response.
 * Handles API authentication and response parsing.
 * 
 * @param {string} prompt - Text prompt to send to the model
 * @param {object} options - Request options
 *   - timeout: Request timeout in milliseconds (default: 20000)
 * 
 * @returns {Promise<object>} {
 *   text: string - Generated content text
 *   raw: object|string - Raw API response data
 * }
 * 
 * @throws {Error} If API key is not configured or API returns error
 *   Error objects include:
 *   - .status: HTTP status code
 *   - .raw: Raw API response for debugging
 */
module.exports.generateContent = async function generateContent(prompt, options = {}) {
  // Validate API key is configured
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY environment variable is not configured');
    err.status = 500;
    throw err;
  }

  // Determine which model to use
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const url = `${GEMINI_API_ENDPOINT}/${model}:generateContent`;

  // Set request timeout
  const timeout = options.timeout || 20000;

  // Make API request
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    }),
    timeout
  });

  // Parse response
  const rawBody = await res.text();
  let data = null;

  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    data = null;
  }

  // Handle API errors
  if (!res.ok) {
    const err = new Error('Gemini API error');
    err.status = res.status;
    err.raw = data || rawBody;
    throw err;
  }

  // Extract generated text from response
  // Handles different possible response structures for robustness
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ||
               data?.candidates?.[0]?.content?.[0]?.text ||
               rawBody;

  return { text, raw: data || rawBody };
};
