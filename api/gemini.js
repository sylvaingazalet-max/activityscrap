/**
 * Gemini API Route Handler
 * 
 * Serverless function that:
 * 1. Validates incoming request payload
 * 2. Looks up job postings from predefined company platforms
 * 3. Generates AI-powered content based on prompt and job data
 * 
 * Implements Server-Sent Events (SSE) for streaming responses.
 * 
 * Request Format (POST):
 * {
 *   prompt: string (required) - Base prompt for AI generation
 *   companies?: array|string - Company slugs to lookup for context
 * }
 * 
 * Response Format (SSE):
 * event: progress -> { type: 'progress', data: { slug, state, platform?, url? } }
 * event: result -> { type: 'result', data: { result: string, raw: any } }
 * event: error -> { type: 'error', data: { error: string } }
 */

const { validatePayload } = require('../lib/validators');
const { lookupSlugs } = require('../services/platformLookup');
const { generateContent } = require('../services/geminiClient');

// ============================================================================
// Constants
// ============================================================================

// Configuration for company lookups
const COMPANY_LOOKUP_CONFIG = {
  concurrency: 3,           // Max concurrent requests per batch
  timeout: 8000             // Request timeout in milliseconds
};

// Configuration for AI API
const AI_API_CONFIG = {
  timeout: 20000            // AI API timeout in milliseconds
};

// ============================================================================
// SSE Response Helpers
// ============================================================================

/**
 * Send SSE (Server-Sent Events) formatted event
 * @param {http.ServerResponse} res - Response object
 * @param {object} payload - Data to send (will be JSON stringified)
 */
function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle POST requests to generate AI content with company context
 */
module.exports = async (req, res) => {
  console.log('api/gemini route called', { method: req.method });

  // =========================================================================
  // Validate HTTP method
  // =========================================================================
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // =========================================================================
  // Validate request payload
  // =========================================================================
  const validationError = validatePayload(req.body);
  if (validationError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: validationError }));
    return;
  }

  // =========================================================================
  // Setup Server-Sent Events stream
  // =========================================================================
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const { prompt, companies } = req.body || {};
  let finalPrompt = prompt;

  // =========================================================================
  // Optional: Allow insecure TLS for local development
  // =========================================================================
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' && isLocalDev;

  if (allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log('api/gemini: Local development mode - insecure TLS enabled');
  }

  // =========================================================================
  // Lookup company job postings (optional)
  // =========================================================================
  if (companies) {
    try {
      // Define progress callback to stream updates to client
      const onProgress = (event) => {
        sendEvent(res, { type: 'progress', data: event });
      };

      // Perform company lookups
      const { lookupResults, promptAppend } = await lookupSlugs(companies, {
        concurrency: COMPANY_LOOKUP_CONFIG.concurrency,
        timeout: COMPANY_LOOKUP_CONFIG.timeout,
        onProgress
      });

      // Append lookup results to prompt
      finalPrompt += promptAppend || '';

      console.log('api/gemini: Platform lookup completed', {
        companiesFound: lookupResults.filter(r => r.url).length,
        companiesNotFound: lookupResults.filter(r => !r.url).length
      });
    } catch (err) {
      console.error('api/gemini: Platform lookup failed', err);
      finalPrompt += `\n\n⚠️ Warning: Could not fetch company data: ${err.message}\n`;
    }
  }

  // =========================================================================
  // Generate AI content using Gemini API
  // =========================================================================
  try {
    // Note: Currently disabled for development. In production, uncomment to call Gemini API:
    // const { text, raw } = await generateContent(finalPrompt, {
    //   timeout: AI_API_CONFIG.timeout
    // });
    // sendEvent(res, { type: 'result', data: { result: text, raw } });

    // Development mode: return the constructed prompt for inspection
    const debugPrompt = `--- DEBUG MODE: Constructed Prompt ---\n${finalPrompt}`;
    sendEvent(res, { type: 'result', data: { result: debugPrompt } });
  } catch (err) {
    console.error('api/gemini: Content generation failed', err);
    sendEvent(res, {
      type: 'error',
      data: { error: err.message || String(err) }
    });
  }

  // Close the SSE stream
  res.end();
};
