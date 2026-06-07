/**
 * Gemini API Route Handler - Version Hybride (pgvector & Chrono-node)
 *
 * Serverless function that:
 * 1. Parses date locally from user input using chrono-node (in milliseconds).
 * 2. Cleans the prompt by removing the time-related string.
 * 3. Generates a Gemini vector embedding from the cleaned prompt.
 * 4. Executes a hybrid SQL query: strict date overlap filtering on the `timings` JSONB array
 * AND pgvector cosine similarity sorting (<=>).
 * 5. Streams personalized event recommendations using Gemini.
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
const chrono = require('chrono-node');

// Check for API key
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// ============================================================================
// Constants
// ============================================================================
const AI_API_CONFIG = {
  timeout: 200000,
  embeddingModel: 'gemini-embedding-2' // Modèle recommandé pour les embeddings
};

// ============================================================================
// SSE Response Helpers
// ============================================================================
function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ============================================================================
// Main Handler
// ============================================================================
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

  // Setup Server-Sent Events stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const { prompt } = req.body || {};

  sendEvent(res, { type: 'progress', data: { state: 'initializing', message: 'Analyse locale de votre demande...' } });

  const prisma = await getPrismaClient();

  // Contexte temporel calé sur Paris
  const targetDateRef = new Date();
  const todayStr = targetDateRef.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); 
  const currentYear = new Date(targetDateRef.toLocaleString('en-US', { timeZone: 'Europe/Paris' })).getFullYear();

  // ============================================================================
  // 1. PARSING TEMPOREL LOCAL & NETTOYAGE (Phase Instantanée)
  // ============================================================================
  let startOfDay = null;
  let endOfDay = null;
  let cleanedPrompt = prompt;

  try {
    contextLog.info('Parsing temporal logic locally using chrono-node');
    // Version française de chrono-node
    const parsedDates = chrono.fr.parse(prompt, targetDateRef);

    if (parsedDates.length > 0) {
      const timeMatch = parsedDates[0];
      contextLog.info('Time entity detected locally', { text: timeMatch.text, start: timeMatch.start.date() });
      
      const detectedDate = timeMatch.start.date();
      
      // On crée des bornes strictes pour le jour complet détecté (00:00:00.000 -> 23:59:59.999)
      startOfDay = new Date(detectedDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      endOfDay = new Date(detectedDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Si chrono-node a aussi détecté une date de fin (ex: "ce week-end", "du mardi au jeudi")
      if (timeMatch.end) {
        const detectedEndDate = timeMatch.end.date();
        endOfDay = new Date(detectedEndDate);
        endOfDay.setHours(23, 59, 59, 999);
      }

      // Nettoyage de la requête utilisateur (on retire la chaîne de caractères temporelle)
      cleanedPrompt = prompt.replace(timeMatch.text, '').replace(/\s+/g, ' ').trim();
      contextLog.info('Prompt cleaned successfully', { cleanedPrompt });
    } else {
      contextLog.info('No explicit date found in prompt. System will search without strict temporal range filtering.');
    }
  } catch (err) {
    contextLog.error('Local temporal parsing failed, keeping original prompt', err);
  }

  // ============================================================================
  // 2. GÉNÉRATION DE L'EMBEDDING AU RUNTIME (pgvector requirement)
  // ============================================================================
  let vectorString = null;
  
  // Si le nettoyage a tout vidé (ex: l'user a juste écrit "Samedi"), on utilise le prompt d'origine
  const searchForEmbedding = cleanedPrompt.length > 1 ? cleanedPrompt : prompt;

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
  let fallbackRecommendations = []; // Stockage des événements bruts

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
      // Cas optimal : Recherche sémantique vectorielle disponible
      if (startOfDay && endOfDay) {
        contextLog.info('Hybrid Query with Strict Date overlap + pgvector sorting');
        // Requête hybride complète avec filtrage sur le tableau JSONB timings
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
              WHERE (t.timing->>'begin')::timestamp <= ${endOfDay}
                AND (t.timing->>'end')::timestamp >= ${startOfDay}
            )
          ORDER BY e.embedding <=> ${vectorString}::vector
          LIMIT 15;
        `;
      } else {
        contextLog.info('Query with pgvector sorting only (No date filter detected)');
        // Si aucune date n'est détectée, on effectue uniquement la recherche sémantique globale
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
          LIMIT 15;
        `;
      }
    } else {
      contextLog.warn('Embedding missing, fallback to traditional Prisma match');
      // Fallback au cas où l'API d'embedding échouerait complètement
      const whereClause = {};
      if (startOfDay) {
        whereClause.firstDateBegin = { gte: startOfDay };
      }
      dbEvents = await prisma.event.findMany({
        where: whereClause,
        include: { location: true },
        take: 15
      });
    }

    contextLog.info(`Successfully fetched ${dbEvents.length} events from database`);

    if (dbEvents.length > 0) {
      // Remodelage léger pour correspondre au format attendu par le prompt final de Gemini
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

      // Préparation des données formatées pour le front-end en cas de panne Gemini
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

      finalPrompt += `\n\nVoici les événements correspondants trouvés (triés par pertinence sémantique) :\n${JSON.stringify(formattedEvents, null, 2)}`;
    } else {
      finalPrompt += `\n\nAucun événement n'a été trouvé dans la base de données pour la date ou les critères demandés.`;
    }
  } catch (err) {
    contextLog.error('Failed to execute hybrid search query', err);
    finalPrompt += `\n\n⚠️ Warning: Could not fetch database events: ${err.message}\n`;
  }

  // Injection du contexte temporel pour la réécriture finale du LLM
  const dateContext = `\n\n[CONTEXTE TEMPOREL] Aujourd'hui nous sommes le ${todayStr}. L'année actuelle est ${currentYear}. Utilise cette date pour formuler ta réponse s'il y a des incohérences.\n\n`;
  finalPrompt = dateContext + finalPrompt;

  // Instructions système strictes
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

  // Helper de debug
  const isTruthy = (val) => {
    if (val === true || val === 1) return true;
    if (typeof val !== 'string') return false;
    const cleaned = val.trim().toLowerCase().replace(/['"]/g, '');
    return cleaned === 'true' || cleaned === '1' || cleaned === 'yes';
  };

  const isDebugMode = isTruthy(process.env.RETURN_DEBUG_PROMPT) || isTruthy(process.env.DEBUG);

  // ============================================================================
  // 4. GENERATE RECOMMENDATIONS (Appel Gemini de rendu de texte avec Retry)
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
      const maxAttempts = 2; // Première tentative + 1 retry

      while (attempts < maxAttempts) {
        try {
          contextLog.info(`Calling Gemini API for content generation (Attempt ${attempts + 1}/${maxAttempts})`);
          const response = await generateContent(finalPrompt, {
            timeout: AI_API_CONFIG.timeout
          });
          text = response.text;
          raw = response.raw;
          break; // Succès ! On sort de la boucle de retry
        } catch (err) {
          attempts++;
          
          if (attempts >= maxAttempts) {
            // Fallback gracieux au lieu de faire planter la requête
            contextLog.warn(`Gemini API completely failed after ${maxAttempts} attempts. Falling back to raw DB results.`, { error: err.message });
            
            const fallbackResponse = {
              message_intro: "Oups, notre IA est actuellement très sollicitée et n'a pas pu personnaliser votre réponse 🤖. Voici tout de même la sélection brute des événements trouvés :",
              recommendations: fallbackRecommendations.length > 0 ? fallbackRecommendations : []
            };

            // On simule la réponse de Gemini
            text = JSON.stringify(fallbackResponse);
            raw = { fallback_activated: true, original_error: err.message };
            
            break; // On sort de la boucle avec notre texte de secours, qui sera parsé en JSON juste après
          }

          // Premier plantage : on attend 2 secondes avant de boucler
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

      sendEvent(res, { type: 'result', data: { result: parsedResult, raw } });
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