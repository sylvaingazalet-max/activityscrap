/**
 * Gemini API Route Handler - Version Hybride Directe (UI Dates + pgvector)
 *
 * 1. Récupère les dates strictes envoyées par le frontend.
 * 2. Génère un embedding Gemini à partir du prompt.
 * 3. Exécute une requête SQL hybride (chevauchement dates + similarité cosinus).
 * 4. Stream les résultats au client.
 */

const path = require('path');
const dotenv = require('dotenv');

// Force loading .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { validatePayload } = require('../lib/validators');
const { getPrismaClient } = require('../lib/prismaClient');
const logger = require('../lib/logger');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Check for API key
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

const AI_API_CONFIG = {
  embeddingModel: 'gemini-embedding-2'
};

// SSE Response Helper
function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

module.exports = async (req, res) => {
  const contextLog = logger.createLogger('api/gemini');
  contextLog.info('API route called', { method: req.method, url: req.url });

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // NOTE: Tu devras peut-être mettre à jour validatePayload pour accepter startDate et endDate
  const validationError = validatePayload(req.body);
  if (validationError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: validationError }));
    return;
  }

  // Récupération des données depuis l'UI
  const { prompt, startDate, endDate } = req.body || {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  sendEvent(res, { type: 'progress', data: { state: 'initializing', message: 'Recherche de vos événements...' } });

  const prisma = await getPrismaClient();

  // ============================================================================
  // 1. FORMATAGE DES DATES (Directement depuis l'input UI)
  // ============================================================================
  let startOfDay = null;
  let endOfDay = null;

  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0); // Début de journée
    startOfDay = start.toISOString();
  }

  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999); // Fin de journée
    endOfDay = end.toISOString();
  } else if (startDate) {
    // Si seule la date de début est fournie, on cherche uniquement sur cette journée précise
    const end = new Date(startDate);
    end.setHours(23, 59, 59, 999);
    endOfDay = end.toISOString();
  }

  // ============================================================================
  // 2. GÉNÉRATION DE L'EMBEDDING AU RUNTIME (pgvector requirement)
  // ============================================================================
  let vectorString = null;
  
  try {
    contextLog.info('Generating embedding for the search query', { textToEmbed: prompt });
    const embeddingModel = genAI.getGenerativeModel({ model: AI_API_CONFIG.embeddingModel });
    
    const embeddingResult = await embeddingModel.embedContent({
      content: { parts: [{ text: prompt }] },
      outputDimensionality: 768
    });

    if (embeddingResult?.embedding?.values) {
      vectorString = `[${embeddingResult.embedding.values.join(',')}]`;
    }
  } catch (err) {
    contextLog.error('Failed to generate embedding at runtime', err);
    sendEvent(res, { type: 'error', data: { error: 'Erreur lors de la compréhension de votre demande (IA indisponible).' } });
    res.end();
    return;
  }

  sendEvent(res, { type: 'progress', data: { state: 'filtering', message: 'Recherche hybride en cours...' } });

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
        // Recherche avec un filtre strict de date ET un tri par pertinence sémantique
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
        // Recherche sur le catalogue complet (sans dates sélectionnées)
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
    }

    if (dbEvents.length > 0) {
      fallbackRecommendations = dbEvents.map(e => ({
        identifiant: e.id,
        titre: e.titleFr || e.title_fr, 
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
  // 4. RETOUR DIRECT DES RÉSULTATS
  // ============================================================================
  try {
    let parsedResult;
    let extraEvents = [];

    if (fallbackRecommendations.length > 0) {
      parsedResult = {
        message_intro: startOfDay 
          ? "Voici les événements sur le créneau choisi, triés par pertinence :" 
          : "Voici les événements pertinents, triés pour vous :",
        recommendations: fallbackRecommendations.slice(0, 5)
      };
      extraEvents = fallbackRecommendations.slice(5);
    } else {
      parsedResult = {
        message_intro: "Désolé, nous n'avons trouvé aucun événement dans le créneau souhaité.",
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