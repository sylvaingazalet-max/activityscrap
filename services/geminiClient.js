/**
 * Gemini AI Client
 *
 * Wrapper around Google's Generative AI API (Gemini).
 * Used to generate personalized event recommendations based on user preferences and event data.
 *
 * Environment Variables:
 * - GEMINI_API_KEY (required): Google Gemini API key
 * - GEMINI_MODEL (optional): Model ID (default: 'gemini-3.5-flash')
 *
 * Error Handling:
 * - Missing API key results in 500 status with clear error message
 * - API errors include status code and raw response for debugging
 */

const { fetchWithTimeout } = require('../lib/http');
const logger = require('../lib/logger');
const contextLog = logger.createLogger('services/geminiClient');

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
 * - timeout: Request timeout in milliseconds (default: 20000)
 *
 * @returns {Promise<object>} {
 * text: string - Generated content text
 * raw: object|string - Raw API response data
 * }
 *
 * @throws {Error} If API key is not configured or API returns error
 * Error objects include:
 * - .status: HTTP status code
 * - .raw: Raw API response for debugging
 */
module.exports.generateContent = async function generateContent(prompt, options = {}) {
  // Validate API key is configured
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    contextLog.error('GEMINI_API_KEY not configured');
    const err = new Error('GEMINI_API_KEY environment variable is not configured');
    err.status = 500;
    throw err;
  }

  // Determine which model to use
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${GEMINI_API_ENDPOINT}/${model}:generateContent`;

  // Set request timeout
  const timeout = options.timeout || 20000;

  contextLog.info('Calling Gemini API', {
    model,
    promptLength: prompt.length,
    timeout
  });

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
      ],
      // Forcer le retour en JSON (Structured Output)
      generationConfig: {
        responseMimeType: "application/json"
      }
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
    contextLog.error('Gemini API error response', {
      status: res.status,
      hasData: !!data,
      responseLength: rawBody.length
    });

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

  contextLog.info('Gemini API response received', {
    model,
    generatedTextLength: text ? text.length : 0,
    status: res.status
  });

  return { text, raw: data || rawBody };
};