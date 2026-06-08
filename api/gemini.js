/**
 * Gemini API Route Handler - Version Hybride (pgvector & Chrono-node)
 *
 * Serverless function that:
 * 1. Parses date via LLM (with local chrono-node fallback) from user input.
 * 2. Generates a Gemini vector embedding from the cleaned prompt.
 * 3. Executes a hybrid SQL query: strict date overlap filtering on the `timings` JSONB array
 * AND pgvector cosine similarity sorting (<=>).
 * 4. Streams events directly to client (LLM generation skipped for speed).
 */

const path = require('path');
const dotenv = require('dotenv');

// Force loading .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { validatePayload } = require('../lib/validators');
const { getPrismaClient } = require('../lib/prismaClient');
const logger = require('../lib/logger');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parseTemporalPrompt } = require('../lib/temporalParser');

// Check for API key
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// ============================================================================
// Constants
// ============================================================================
const AI_API_CONFIG = {
  embeddingModel: 'gemini-embedding-2'
};

// SSE Response Helper
function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Main API Route Handler
 */
module.exports = async (req, res) => {
  const contextLog = logger.createLogger('api/gemini');
  contextLog.info('API route called', { method: req.method, url: req.url });

  // Validate HTTP method
  if (req.method !== 'POST') {
    contextLog.warn('Invalid HTTP method', { method: req.method });
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // Validate request payload
  const validationError = validatePayload(req.body);
  if (validationError) {
    contextLog.warn('Validation failed', { error: validationError });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: validationError }));
    return;
  }

  const { prompt, targetDate } = req.body || {};

  // Setup Server-Sent Events stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  sendEvent(res, { type: 'progress', data: { state: 'initializing', message: 'Analyse temporelle de votre demande...' } });

  const prisma = await getPrismaClient();
  const targetDateRef = targetDate ? new Date(targetDate) : new Date();

  // ============================================================================
  // 1. PARSING TEMPOREL PAR IA & FINALISATION CHRONO-NODE
  // ============================================================================
  let startOfDay = null;
  let endOfDay = null;
  let searchForEmbedding = prompt;

  try {
    contextLog.info('Parsing temporal logic using LLM with local fallback');
    const parsedData = await parseTemporalPrompt(prompt, targetDateRef, genAI);
    
    startOfDay = parsedData.startOfDay;
    endOfDay = parsedData.endOfDay;
    searchForEmbedding = parsedData.searchForEmbedding;

  } catch (err) {
    contextLog.error('Temporal parsing block failed, keeping original prompt', err);
  }

  // ============================================================================
  // 2. GÉNÉRATION DE L'EMBEDDING AU RUNTIME (pgvector requirement)
  // ============================================================================
  let vectorString = null;
  
  try {
    contextLog.info('Generating embedding for the search query', { textToEmbed: searchForEmbedding });
    const embeddingModel = genAI.getGenerativeModel({ model: AI_API_CONFIG.embeddingModel });
    
    const embeddingResult = await embeddingModel.embedContent({
      content: { parts: [{ text: searchForEmbedding }] },
      outputDimensionality: 768
    });

    if (embeddingResult?.embedding?.values) {
      vectorString = `[${embeddingResult.embedding.values.join(',')}]`;
    }
  } catch (err) {
    contextLog.error('Failed to generate embedding at runtime', err);
  }

  sendEvent(res, { type: 'progress', data: { state: 'filtering', message: 'Recherche hybride (Date SQL + pgvector) en cours...' } });

  let fallbackRecommendations = [];

  const isLocalDev = process.env.NODE_ENV !== 'production';
  const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' && isLocalDev;
  if (allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  // ============================================================================
  // 3. EXÉCUTION HYBRIDE (SQL Brute + pgvector)
  // ============================================================================
  try {
    contextLog.info('Executing hybrid raw SQL query');
    let dbEvents = [];

    if (vectorString) {
      if (startOfDay && endOfDay) {
        dbEvents = await prisma.$queryRaw`
          SELECT 
            e.uid as "id", e.title_fr as "titleFr", e.description_fr as "descriptionFr", 
            e.longdescription_fr as "longDescriptionFr", e.conditions_fr as "conditionsFr", 
            e.image, e.daterange_fr as "dateRangeFr", e.timings, e.canonicalurl as "canonicalUrl",
            l.location_name as "locationName", l.location_district as "locationDistrict"
          FROM events e
          LEFT JOIN locations l ON e.location_uid = l.location_uid
          WHERE 
            e.embedding IS NOT NULL
            AND e.timings IS NOT NULL 
            AND EXISTS (
              SELECT 1 
              FROM jsonb_array_elements(e.timings::jsonb) AS t(timing)
              WHERE (t.timing->>'begin')::timestamp <= ${endOfDay}::timestamp
                AND (t.timing->>'end')::timestamp >= ${startOfDay}::timestamp
            )
          ORDER BY e.embedding <=> ${vectorString}::vector
          LIMIT 50;
        `;
      } else {
        dbEvents = await prisma.$queryRaw`
          SELECT 
            e.uid as "id", e.title_fr as "titleFr", e.description_fr as "descriptionFr", 
            e.longdescription_fr as "longDescriptionFr", e.conditions_fr as "conditionsFr", 
            e.image, e.daterange_fr as "dateRangeFr", e.timings, e.canonicalurl as "canonicalUrl",
            l.location_name as "locationName", l.location_district as "locationDistrict"
          FROM events e
          LEFT JOIN locations l ON e.location_uid = l.location_uid
          WHERE e.embedding IS NOT NULL
          ORDER BY e.embedding <=> ${vectorString}::vector
          LIMIT 50;
        `;
      }
    } else {
      contextLog.warn('Embedding missing, fallback to traditional Prisma match');
      const whereClause = {};
      if (startOfDay) {
        whereClause.firstDateBegin = { gte: new Date(startOfDay) };
      }
      dbEvents = await prisma.events.findMany({
        where: whereClause,
        take: 50
      });
    }

    if (dbEvents.length > 0) {
      fallbackRecommendations = dbEvents.map(e => ({
        identifiant: e.id,
        titre: e.titleFr || e.title_fr, // Handling both queryRaw and findMany formats
        chapo: e.descriptionFr || e.description_fr || "Plus de détails sur la page de l'événement.",
        image_url: e.image,
        lieu: e.locationName ? `${e.locationName} ${e.locationDistrict ? `(${e.locationDistrict})` : ''}` : 'Lille',
        date_horaire: e.dateRangeFr || e.daterange_fr,
        tarif: e.conditionsFr || e.conditions_fr || 'Non précisé',
        url_reservation: e.canonicalUrl || e.canonicalurl
      }));
    }

  } catch (err) {
    contextLog.error('Failed to execute hybrid search query', err);
    sendEvent(res, { type: 'error', data: { error: 'Erreur lors de la recherche dans la base de données.' } });
    res.end();
    return;
  }

  // ============================================================================
  // 4. RETOUR DIRECT DES RÉSULTATS (Bypass du LLM)
  // ============================================================================
  try {
    contextLog.info('Sending direct DB results without LLM formatting');

    let parsedResult;
    let extraEvents = [];

    if (fallbackRecommendations.length > 0) {
      parsedResult = {
        message_intro: "Voici les événements qui correspondent le mieux à votre recherche :",
        recommendations: fallbackRecommendations.slice(0, 5)
      };
      extraEvents = fallbackRecommendations.slice(5);
    } else {
      parsedResult = {
        message_intro: "Désolé, nous n'avons trouvé aucun événement correspondant à votre recherche pour le moment.",
        recommendations: []
      };
    }

    sendEvent(res, { 
      type: 'result', 
      data: { 
        result: parsedResult, 
        extra_events: extraEvents, 
        raw: { source: 'direct_db' } 
      } 
    });

  } catch (err) {
    contextLog.error('Error sending final payload', err);
    sendEvent(res, {
      type: 'error',
      data: { error: err.message || 'Une erreur est survenue lors de la préparation des résultats.' }
    });
  }

  contextLog.debug('Closing SSE stream');
  res.end();
};