/**
 * Gemini API Route Handler - Version Hybride Directe (UI Dates + pgvector)
 *
 * 1. Récupère les dates strictes envoyées par le frontend.
 * 2. Nettoie le prompt des indications géographiques pour purifier l'embedding.
 * 3. Génère un embedding Gemini à partir du prompt nettoyé.
 * 4. Exécute une requête SQL hybride (chevauchement dates + similarité cosinus avec seuil).
 * 5. Stream les résultats au client.
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

// ============================================================================
// LOGIQUE DE NETTOYAGE GÉOGRAPHIQUE
// ============================================================================
const MEL_LOCATIONS = [
  "métropole", "metropole", "mel", "métropole lilloise", "agglomération",
  "allennes-les-marais", "annœullin", "annoeullin", "anstaing", "armentières", "armentieres", 
  "aubers", "baisieux", "bauvin", "beaucamps-ligny", "bois-grenier", "bondues", 
  "bousbecque", "bouvines", "capinghem", "carnin", "chéreng", "chereng", "comines", 
  "croix", "deûlémont", "deulemont", "don", "emmerin", "englos", "ennetières-en-weppes", 
  "ennetieres-en-weppes", "erquinghem-le-sec", "erquinghem-lys", "escobecques", 
  "faches-thumesnil", "forest-sur-marque", "fournes-en-weppes", "frelinghien", "fretin", 
  "fromelles", "gruson", "hallennes-lez-haubourdin", "halluin", "hantay", "haubourdin", 
  "hellemmes", "hem", "herlies", "houplin-ancoisne", "houplines", "illies", "la bassée", 
  "la bassee", "la chapelle-d'armentières", "la chapelle-d'armentieres", "la madeleine", 
  "lambersart", "lannoy", "le maisnil", "leers", "lesquin", "lezennes", "lille", 
  "linselles", "lomme", "lompret", "loos", "lys-lez-lannoy", "marcq-en-barœul", 
  "marcq-en-baroeul", "marquette-lez-lille", "marquillies", "mons-en-barœul", 
  "mons-en-baroeul", "mouvaux", "neuville-en-ferrain", "noyelles-lès-seclin", 
  "noyelles-les-seclin", "pérenchies", "perenchies", "péronne-en-mélantois", 
  "peronne-en-melantois", "prémesques", "premesques", "provin", "quesnoy-sur-deûle", 
  "quesnoy-sur-deule", "radinghem-en-weppes", "ronchin", "roncq", "roubaix", 
  "sailly-lez-lannoy", "sainghin-en-mélantois", "sainghin-en-melantois", "sainghin-en-weppes", 
  "saint-andré-lez-lille", "saint-andre-lez-lille", "salomé", "salome", "santes", 
  "seclin", "sequedin", "templemars", "toufflers", "tourcoing", "tressin", "vendeville", 
  "verlinghem", "villeneuve-d'ascq", "villeneuve d'ascq", "wambrechies", "warneton", 
  "wasquehal", "wattignies", "wattrelos", "wavrin", "wervicq-sud", "wicres", "willems",
  "wazemmes", "vieux-lille", "vieux lille", "moulins", "lille-moulins", 
  "vauban", "esquermes", "vauban-esquermes", "fives", "saint-maurice pellevoisin", 
  "saint-maurice", "pellevoisin", "bois blancs", "bois-blancs", "faubourg de béthune", 
  "faubourg de bethune", "lille-sud", "saint-sauveur", "euralille", "lille-centre", "centre-ville", "centre"
];

const ESCAPED_LOCATIONS = MEL_LOCATIONS
  .map(loc => loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length) // Les plus longs en premier pour éviter les conflits partiels
  .join('|');

// Capture les "à Lille", "dans la commune de Loos", "sur la métropole lilloise"
const LOCATION_REGEX = new RegExp(`\\b(à|a|au|aux|dans|sur|en|vers|proche de|autour de)\\s+(?:(la|le|les|l'|d'|de|du|des)\\s+)?(?:(ville|commune|quartier)\\s+(de|d')\\s+)?(${ESCAPED_LOCATIONS})\\b`, 'gi');
// Capture les mots isolés fréquents si l'utilisateur les tape à la va-vite sans préposition (ex: "concert rock lille")
const STANDALONE_REGEX = new RegExp(`\\b(lille|wazemmes|roubaix|tourcoing|villeneuve d'ascq|villeneuve-d'ascq|vieux-lille|vieux lille|mel|métropole|metropole)\\b`, 'gi');

function cleanPrompt(promptText) {
  if (!promptText) return '';
  let cleaned = promptText.replace(LOCATION_REGEX, '');
  cleaned = cleaned.replace(STANDALONE_REGEX, '');
  return cleaned.replace(/\s+/g, ' ').trim();
}

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

  const validationError = validatePayload(req.body);
  if (validationError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: validationError }));
    return;
  }

  // Récupération des données depuis l'UI
  let { prompt, startDate, endDate } = req.body || {};

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
  // 2. NETTOYAGE DU PROMPT ET GÉNÉRATION DE L'EMBEDDING AU RUNTIME
  // ============================================================================
  let vectorString = null;
  
  // Expurger le prompt de la géographie pour garder le sens pur
  prompt = cleanPrompt(prompt);

  // Fallback de sécurité : si l'utilisateur a tapé UNIQUEMENT "à Lille", le prompt est vide
  if (!prompt) {
      prompt = "événement sortie activité loisir";
  }
  
  try {
    contextLog.info('Generating embedding for the search query', { textToEmbed: prompt });
    const embeddingModel = genAI.getGenerativeModel({ model: AI_API_CONFIG.embeddingModel });
    
    const embeddingResult = await embeddingModel.embedContent({
      content: { parts: [{ text: prompt }] },
      taskType: 'RETRIEVAL_QUERY', // Indique que c'est la question de l'utilisateur
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

  sendEvent(res, { type: 'progress', data: { state: 'filtering', message: 'Recherche dans 180 agendas de la métropole...' } });

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
        // Recherche avec un filtre strict de date ET un filtre par pertinence sémantique (<= 0.4)
        dbEvents = await prisma.$queryRaw`
          SELECT 
            e.uid as "id", e.title_fr as "titleFr", e.description_fr as "descriptionFr", 
            e.longdescription_fr as "longDescriptionFr", e.conditions_fr as "conditionsFr", 
            e.image, e.daterange_fr as "dateRangeFr", e.timings, e.canonicalurl as "canonicalUrl",
            l.location_name as "locationName", l.location_district as "locationDistrict",
            (e.embedding <=> ${vectorString}::vector) as "distance"
          FROM events e
          LEFT JOIN locations l ON e.location_uid = l.location_uid
          WHERE 
            e.embedding IS NOT NULL
            AND (e.embedding <=> ${vectorString}::vector) <= 0.4
            AND e.timings IS NOT NULL 
            AND EXISTS (
              SELECT 1 
              FROM jsonb_array_elements(e.timings::jsonb) AS t(timing)
              WHERE (t.timing->>'begin')::timestamp <= ${endOfDay}::timestamp
                AND (t.timing->>'end')::timestamp >= ${startOfDay}::timestamp
            )
          ORDER BY "distance" ASC;
        `;
      } else {
        // Recherche sur le catalogue complet avec filtre de distance <= 0.4
        dbEvents = await prisma.$queryRaw`
          SELECT 
            e.uid as "id", e.title_fr as "titleFr", e.description_fr as "descriptionFr", 
            e.longdescription_fr as "longDescriptionFr", e.conditions_fr as "conditionsFr", 
            e.image, e.daterange_fr as "dateRangeFr", e.timings, e.canonicalurl as "canonicalUrl",
            l.location_name as "locationName", l.location_district as "locationDistrict",
            (e.embedding <=> ${vectorString}::vector) as "distance"
          FROM events e
          LEFT JOIN locations l ON e.location_uid = l.location_uid
          WHERE 
            e.embedding IS NOT NULL
            AND (e.embedding <=> ${vectorString}::vector) <= 0.4
          ORDER BY "distance" ASC;
        `;
      }
    }

    if (dbEvents.length > 0) {
      fallbackRecommendations = dbEvents.map(e => ({
        identifiant: e.id,
        titre: e.titleFr || e.title_fr, 
        chapo: e.descriptionFr || e.description_fr || "Plus de détails sur la page de l'événement.",
        image_url: e.image,
        lieu: (e.locationName && e.locationDistrict) 
          ? `${e.locationName} (${e.locationDistrict})` 
          : (e.locationName || e.locationDistrict || 'Non précisé'),
        date_horaire: e.dateRangeFr || e.daterange_fr,
        tarif: e.conditionsFr || e.conditions_fr || 'Non précisé',
        url_reservation: e.canonicalUrl || e.canonicalurl,
        // On récupère la distance brute pour le debug
        distance_debug: e.distance 
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

    if (fallbackRecommendations.length > 0) {
      parsedResult = {
        message_intro: startOfDay 
          ? "Voici les événements sur le créneau choisi, triés par pertinence :" 
          : "Voici les événements pertinents, triés pour vous :",
        recommendations: fallbackRecommendations
      };
    } else {
      parsedResult = {
        message_intro: "Aucun événement ne correspond exactement à cette recherche.",
        recommendations: []
      };
    }

    sendEvent(res, { 
      type: 'result', 
      data: { 
        result: parsedResult, 
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