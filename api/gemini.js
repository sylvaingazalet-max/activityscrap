/**
 * Gemini API Route Handler - Version Hybride (pgvector & Chrono-node)
 *
 * Serverless function that:
 * 1. Parses date via LLM (with local chrono-node fallback) from user input.
 * 2. Generates a Gemini vector embedding from the cleaned prompt.
 * 3. Executes a hybrid SQL query: strict date overlap filtering on the `timings` JSONB array
 * AND pgvector cosine similarity sorting (<=>).
 * 4. Streams personalized event recommendations using Gemini.
 */

const path = require('path');
const dotenv = require('dotenv');

// Force loading .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { validatePayload } = require('../lib/validators');
const { generateContent } = require('../services/geminiClient');
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
  timeout: 200000,
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
  contextLog.debug('Validating request payload', { body: req.body });
  const validationError = validatePayload(req.body);
  if (validationError) {
    contextLog.warn('Validation failed', { error: validationError });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: validationError }));
    return;
  }

  // Safe extraction of properties from req.body
  const { prompt, targetDate } = req.body || {};

  // Setup Server-Sent Events stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  sendEvent(res, { type: 'progress', data: { state: 'initializing', message: 'Analyse temporelle de votre demande...' } });

  // Initialize Database Client with await
  const prisma = await getPrismaClient();

  // Setup Target baseline reference date
  const targetDateRef = targetDate ? new Date(targetDate) : new Date();
  const todayStr = targetDateRef.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); 
  const currentYear = new Date(targetDateRef.toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getFullYear();

  // ============================================================================
  // 1. PARSING TEMPOREL PAR IA & FINALISATION CHRONO-NODE
  // ============================================================================
  let startOfDay = null;
  let endOfDay = null;
  let cleanedPrompt = prompt;
  let searchForEmbedding = prompt;

  try {
    contextLog.info('Parsing temporal logic using LLM with local fallback');
    
    const parsedData = await parseTemporalPrompt(prompt, targetDateRef, genAI);
    
    startOfDay = parsedData.startOfDay;
    endOfDay = parsedData.endOfDay;
    cleanedPrompt = parsedData.cleanedPrompt;
    searchForEmbedding = parsedData.searchForEmbedding;

    if (startOfDay) {
      contextLog.info('Time entity detected', { start: startOfDay, end: endOfDay, cleanedPrompt });
    } else {
      contextLog.info('No explicit date found. System will search without strict temporal range filtering.');
    }
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

  let finalPrompt = prompt;
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
        contextLog.info('Hybrid Query with Strict Date overlap + pgvector sorting');
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
        contextLog.info('Query with pgvector sorting only (No date filter detected)');
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

    contextLog.info(`Successfully fetched ${dbEvents.length} events from database`);

    if (dbEvents.length > 0) {
      const formattedEvents = dbEvents.map(e => ({
        id: e.id,
        titleFr: e.titleFr,
        descriptionFr: e.descriptionFr,
        longDescriptionFr: e.longDescriptionFr,
        conditionsFr: e.conditionsFr,
        image: e.image,
        dateRangeFr: e.dateRangeFr,
        canonicalUrl: e.canonicalUrl,
        location: {
          name: e.locationName,
          district: e.locationDistrict
        }
      }));

      fallbackRecommendations = formattedEvents.map(e => ({
        identifiant: e.id,
        titre: e.titleFr,
        chapo: e.descriptionFr || "Plus de détails sur la page de l'événement.",
        image_url: e.image,
        lieu: e.location.name ? `${e.location.name} ${e.location.district ? `(${e.location.district})` : ''}` : 'Lille',
        date_horaire: e.dateRangeFr,
        tarif: e.conditionsFr || 'Non précisé',
        url_reservation: e.canonicalUrl
      }));

      const top5Events = formattedEvents.slice(0, 5);
      finalPrompt += `\n\nVoici les 5 meilleurs événements correspondants trouvés (triés par pertinence sémantique) :\n${JSON.stringify(top5Events, null, 2)}`;
    } else {
      finalPrompt += `\n\nAucun événement n'a été trouvé dans la base de données pour la date ou les critères demandés.`;
    }
  } catch (err) {
    contextLog.error('Failed to execute hybrid search query', err);
    finalPrompt += `\n\n⚠️ Warning: Could not fetch database events: ${err.message}\n`;
  }

  const dateContext = `\n\n[CONTEXTE TEMPOREL] Aujourd'hui nous sommes le ${todayStr}. L'année actuelle est ${currentYear}. Utilise cette date pour formuler ta réponse s'il y a des incohérences.\n\n`;
  finalPrompt = dateContext + finalPrompt;

  finalPrompt += `
Tu es un assistant qui recommande des événements à Lille.
TU ne peux mettre des evenemeents QUE si ils sont dans ceux qu'on t'a fourni dans ce prompt. Sinon précise qu'aucun evenement n'est disponible.
Tu dois STRICTEMENT renvoyer un objet JSON valide, qui aura filtré les doublons (plusieurs événements identiques avec des id différents), respectant rigoureusement le schéma suivant :
{
  "message_intro": "Petite phrase sympa pour introduire les choix.",
  "recommendations": [
    {
      "identifiant": "ID de l'événement (propriété 'id')",
      "titre": "Titre de l'événement (propriété 'titleFr')",
      "chapo": "Courte description (propriété 'descriptionFr' ou résumé de 'longDescriptionFr')",
      "image_url": "L'URL de l'image (propriété 'image', ou null)",
      "lieu": "Ville / Nom du lieu (issus de l'objet 'location')",
      "date_horaire": "Date ou horaires résumés (via 'dateRangeFr')",
      "tarif": "Tarif ou gratuité (propriété 'conditionsFr')",
      "url_reservation": "Lien d'accès ou permalien (propriété 'canonicalUrl')",
    }
  ]
}`;

  const isDebugMode = process.env.RETURN_DEBUG_PROMPT === 'true' || process.env.DEBUG === 'true';

  // ============================================================================
  // 4. GENERATE RECOMMENDATIONS (Appel Gemini)
  // ============================================================================
  try {
    contextLog.info('Starting AI content generation');

    if (isDebugMode) {
      contextLog.debug('Returning debug prompt instead of calling API');
      const debugPrompt = `--- DEBUG MODE: Constructed Prompt ---\n${finalPrompt}`;
      sendEvent(res, { type: 'result', data: { result: debugPrompt } });
    } else {
      let text, raw;
      let attempts = 0;
      const maxAttempts = 2;

      while (attempts < maxAttempts) {
        try {
          contextLog.info(`Calling Gemini API for content generation (Attempt ${attempts + 1}/${maxAttempts})`);
          const response = await generateContent(finalPrompt, {
            timeout: AI_API_CONFIG.timeout
          });
          text = response.text;
          raw = response.raw;
          break;
        } catch (err) {
          attempts++;
          
          if (attempts >= maxAttempts) {
            contextLog.warn(`Gemini API completely failed after ${maxAttempts} attempts. Falling back to raw DB results.`, { error: err.message });
            
            const fallbackResponse = {
              message_intro: "Oups, notre IA est actuellement très sollicitée et n'a pas pu personnaliser votre réponse 🤖. Voici tout de même la sélection brute des événements trouvés :",
              recommendations: fallbackRecommendations.slice(0, 5)
            };

            text = JSON.stringify(fallbackResponse);
            raw = { fallback_activated: true, original_error: err.message };
            break;
          }

          contextLog.warn(`Gemini API call failed. Retrying in 2 seconds...`, { error: err.message });
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      let parsedResult = null;
      try {
        parsedResult = JSON.parse(text);
      } catch (parseError) {
        contextLog.error('Erreur lors du parsing JSON de la réponse Gemini', { text, error: parseError.message });
        throw new Error('La réponse de l\'IA n\'a pas pu être formatée en JSON valide.');
      }

      const extraEvents = fallbackRecommendations.slice(5);
      sendEvent(res, { type: 'result', data: { result: parsedResult, extra_events: extraEvents, raw } });
    }
  } catch (err) {
    contextLog.error('Content generation failed', err);
    sendEvent(res, {
      type: 'error',
      data: { error: err.message || String(err) }
    });
  }

  contextLog.debug('Closing SSE stream');
  res.end();
};