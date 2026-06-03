/**
 * Gemini API Route Handler
 *
 * Serverless function that:
 * 1. Validates incoming request payload
 * 2. Fetches events from configured sources using JinaAI for content extraction
 * 3. Generates AI-powered personalized event recommendations based on user preferences
 *
 * Implements Server-Sent Events (SSE) for streaming responses.
 *
 * Request Format (POST):
 * {
 *   prompt: string (required) - User preferences for event recommendations
 * }
 *
 * Response Format (SSE):
 * event: progress -> { type: 'progress', data: { state, source?, eventCount? } }
 * event: result -> { type: 'result', data: { result: string, raw: any } }
 * event: error -> { type: 'error', data: { error: string } }
 */

// Load environment variables from .env file
const path = require('path');
const dotenv = require('dotenv');

// Force le chargement du .env depuis la racine du projet pour éviter les problèmes de CWD
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { validatePayload } = require('../lib/validators');
const { lookupSlugs } = require('../services/platformLookup');
const { generateContent } = require('../services/geminiClient');
const logger = require('../lib/logger');

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
  timeout: 200000            // AI API timeout in milliseconds
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
 * Main Handler
 * Handles POST requests to generate AI content with event context
 */
module.exports = async (req, res) => {
  const contextLog = logger.createLogger('api/gemini');
  contextLog.info('API route called', { method: req.method, url: req.url });

  // =========================================================================
  // Validate HTTP method
  // =========================================================================
  if (req.method !== 'POST') {
    contextLog.warn('Invalid HTTP method', { method: req.method });
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // =========================================================================
  // Validate request payload
  // =========================================================================
  contextLog.debug('Validating request payload', { body: req.body });
  const validationError = validatePayload(req.body);
  if (validationError) {
    contextLog.warn('Validation failed', { error: validationError });
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

  contextLog.info('Request validated, starting event lookup', {
    promptLength: prompt.length,
    companiesRequested: companies
  });

  // =========================================================================
  // Optional: Allow insecure TLS for local development
  // =========================================================================
  const isLocalDev = process.env.NODE_ENV !== 'production';
  const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' && isLocalDev;

  if (allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    contextLog.info('Local development mode - insecure TLS enabled');
  }

  // =========================================================================
  // Fetch events from configured sources using JinaAI
  // =========================================================================
  try {
    // Define progress callback to stream updates to client
    const onProgress = (event) => {
      sendEvent(res, { type: 'progress', data: event });
    };

    contextLog.info('Starting event lookup from configured sources');

    // Fetch events using JinaAI from all configured sources
    const { events, promptAppend } = await lookupSlugs(null, {
      timeout: COMPANY_LOOKUP_CONFIG.timeout,
      onProgress
    });

    // Append event data to prompt
    finalPrompt += promptAppend || '';

    contextLog.info('Event fetching completed successfully', {
      eventsFound: events ? events.length : 0,
      promptAppendLength: promptAppend ? promptAppend.length : 0
    });
  } catch (err) {
    contextLog.error('Event fetching failed', err);
    finalPrompt += `\n\n⚠️ Warning: Could not fetch event data: ${err.message}\n`;
    sendEvent(res, {
      type: 'progress',
      data: { state: 'warning', source: 'Events', message: `Partial failure: ${err.message}` }
    });
  }

  // =========================================================================
  // Generate AI content using Gemini API
  // =========================================================================

  // Helper robuste pour vérifier la véracité d'une variable d'env
  const isTruthy = (val) => {
    if (val === true || val === 1) return true;
    if (typeof val !== 'string') return false;
    // Supprime espaces et guillemets éventuels (ex: "true" -> true)
    const cleaned = val.trim().toLowerCase().replace(/['"]/g, '');
    return cleaned === 'true' || cleaned === '1' || cleaned === 'yes';
  };

  const isDebugMode = isTruthy(process.env.RETURN_DEBUG_PROMPT) || isTruthy(process.env.DEBUG);

  try {
    contextLog.info('Starting AI content generation', {
      debugMode: isDebugMode,
      finalPromptLength: finalPrompt.length,
      envCheck: {
        // On force en String pour que JSON.stringify n'ignore pas les valeurs undefined
        RETURN_DEBUG_PROMPT: String(process.env.RETURN_DEBUG_PROMPT),
        DEBUG: String(process.env.DEBUG),
        loadedKeys: Object.keys(process.env).filter(k => k.includes('DEBUG') || k.includes('GEMINI')).length
      }
    });

    if (isDebugMode) {
      // Debug mode: return the constructed prompt for inspection
      contextLog.debug('Returning debug prompt instead of calling API');
      const debugPrompt = `--- DEBUG MODE: Constructed Prompt ---\n${finalPrompt}`;
      sendEvent(res, { type: 'result', data: { result: debugPrompt } });
    } else {
      // Production mode: call Gemini API
      contextLog.info('Calling Gemini API for content generation');
      const { text, raw } = await generateContent(finalPrompt, {
        timeout: AI_API_CONFIG.timeout
      });
      contextLog.info('Gemini API response received successfully', {
        responseLength: text ? text.length : 0
      });
      sendEvent(res, { type: 'result', data: { result: text, raw } });
    }
  } catch (err) {
    contextLog.error('Content generation failed', err);
    sendEvent(res, {
      type: 'error',
      data: { error: err.message || String(err) }
    });
  }

  // Close the SSE stream
  contextLog.debug('Closing SSE stream');
  res.end();
};
