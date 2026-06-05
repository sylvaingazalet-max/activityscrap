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
const { generateContent } = require('../services/geminiClient');
const { getPrismaClient } = require('../lib/prismaClient');
const logger = require('../lib/logger');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Check for API key
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// ============================================================================
// Constants
// ============================================================================

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

  const { prompt } = req.body || {};

  sendEvent(res, { type: 'progress', data: { state: 'initializing', message: 'Analyse de votre demande...' } });

    const prisma = await getPrismaClient();

  // 1. EXTRACT FILTERS USING GEMINI
  let filters = {};
  const todayStr = new Date().toISOString().split('T')[0]; // e.g. "2026-06-04"
  const currentYear = new Date().getFullYear();
  try {
    contextLog.info('Extracting filters from prompt', { prompt });
    const extractionPrompt = `Tu es un assistant de recherche spécialisé dans l'extraction de critères structurés à partir de requêtes d'utilisateurs cherchant des événements à Lille.
Aujourd'hui nous sommes le ${todayStr}. L'année actuelle est ${currentYear}.

Voici la requête de l'utilisateur :
"${prompt}"

Analyse cette requête et renvoie UNIQUE-MENT un objet JSON respectant scrupuleusement la structure suivante (sans aucun bloc Markdown \`\`\`json ou texte explicatif supplémentaire) :
{
  "startDate": "YYYY-MM-DD" (ou null),
  "endDate": "YYYY-MM-DD" (ou null),
  "neighborhoods": ["NomQuartier1", "NomQuartier2"] (liste de quartiers de Lille s'ils sont explicités, sinon un tableau vide. Exemples de quartiers valides : "Vieux-Lille", "Lille-Centre", "Wazemmes", "Fives", "Lille-Sud", "Vauban-Esquermes", "Saint-Maurice Pellevoisin", "Bois-Blancs", "Faubourg de Béthune", "Moulins"),
  "isFree": true/false (ou null si non précisé),
  "ageMin": integer (ou null si non précisé),
  "eventType": "Type" (ou null. Exemples de types d'événements fréquents: "Concert", "Spectacle", "Fête / festival", "Stages et ateliers", "Visite", "Nature / environnement", "Rencontre / conférence / débat")
}

Note : Si la requête parle de "ce week-end", calcule la date de samedi et dimanche par rapport à aujourd'hui (${todayStr}). Si elle parle de "ce soir", calcule la date d'aujourd'hui. Si la requête contient une date ou période, convertis-la proprement au format YYYY-MM-DD.
Renvoie STRICTEMENT le JSON de la forme spécifiée ci-dessus, sans fioritures.`;

    const modelForExtraction = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const extractionResult = await modelForExtraction.generateContent(extractionPrompt);
    const extractionText = extractionResult.response.text().trim();

    // Clean potential markdown wrappers if Gemini returned them
    const cleanedText = extractionText.replace(/```json/g, '').replace(/```/g, '').trim();
    filters = JSON.parse(cleanedText);
    contextLog.info('Successfully extracted filters', { filters });
  } catch (err) {
    contextLog.error('Failed to extract filters from Gemini, falling back to empty filters', err);
    filters = {
      startDate: null,
      endDate: null,
      neighborhoods: [],
      isFree: null,
      ageMin: null,
      eventType: null
    };
  }

  sendEvent(res, { type: 'progress', data: { state: 'filtering', message: 'Recherche et filtrage en base de données...', filters } });

  let finalPrompt = prompt;

  contextLog.info('Request validated, starting database lookup', {
    promptLength: prompt.length
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
  // Fetch events from Database (Prisma)
  // =========================================================================
  try {
    contextLog.info('Fetching events based on extracted filters');

    // BUILD PRISMA WHERE CLAUSE
    const whereClause = {};

    if (filters.startDate) {
      whereClause.Horaires_ISO = { contains: filters.startDate };
    }

    if (filters.neighborhoods && filters.neighborhoods.length > 0) {
      whereClause.Lieu__Quartier = { in: filters.neighborhoods };
    }

    if (filters.isFree === true) {
      whereClause.OR = [
        { Conditions_de_participation__tarifs___FR: { contains: 'gratuit', mode: 'insensitive' } },
        { Conditions_de_participation__tarifs___FR: { contains: 'libre', mode: 'insensitive' } },
        { D_tail_des_tarifs: { contains: 'gratuit', mode: 'insensitive' } }
      ];
    } else if (filters.isFree === false) {
       whereClause.NOT = [
        { Conditions_de_participation__tarifs___FR: { contains: 'gratuit', mode: 'insensitive' } },
        { Conditions_de_participation__tarifs___FR: { contains: 'libre', mode: 'insensitive' } }
      ];
    }

    if (filters.eventType) {
      whereClause.Type_d__v_nement = { contains: filters.eventType, mode: 'insensitive' };
    }

    const dbEvents = await prisma.events.findMany({
      where: whereClause,
      take: 15
    });

    contextLog.info(`Successfully fetched ${dbEvents.length} events from database`);

    if (dbEvents.length > 0) {
      // Safe stringification that handles BigInt values
      const safeDbEventsStr = JSON.stringify(dbEvents, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
        2
      );

      finalPrompt += `\n\nVoici les événements correspondants trouvés dans la base de données. Formule une réponse personnalisée pour l'utilisateur en recommandant ces événements:\n${safeDbEventsStr}`;
    } else {
        finalPrompt += `\n\nAucun événement exact n'a été trouvé pour ces critères. Indique-le à l'utilisateur et donne-lui des conseils généraux liés à sa demande.`;
    }
  } catch (err) {
    contextLog.error('Failed to fetch events from database', err);
    finalPrompt += `\n\n⚠️ Warning: Could not fetch database events: ${err.message}\n`;
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

