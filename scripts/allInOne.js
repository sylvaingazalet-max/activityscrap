/**
 * Synchronisation France OpenAgenda + Ticketmaster avec Embeddings (Gemini).
 * VERSION ULTRA-RÉSILIENTE (Anti-Crash, Anti-ECONNRESET, Gestion des 503 Gemini)
 */

const path = require('path');
const dotenv = require('dotenv');
const { Readable } = require('stream');
const readline = require('readline');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getPrismaClient, disconnect } = require('../lib/prismaClient');

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_INSECURE_TLS === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const BATCH_SIZE = 50; 
const EMBEDDING_MODEL = 'gemini-embedding-2';

const OA_URL = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/exports/jsonl';
const TM_BASE_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';

const TM_STEPS = [
  "latlong=48.8566,2.3522&radius=20&unit=km",
  "latlong=48.8566,2.3522&radius=50&unit=km",
  "latlong=48.8566,2.3522&radius=150&unit=km",
  "latlong=48.8566,2.3522&radius=300&unit=km",
  "" // Reste de la France
];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

// ============================================================================
// UTILITAIRES & MAPPERS
// ============================================================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const safeParseJSON = (value) => { try { return typeof value === 'object' ? value : JSON.parse(value); } catch { return null; } };
const safeDate = (value) => { const d = new Date(value); return isNaN(d.getTime()) ? null : d; };

function mapOdsToPrisma(odsEvent) {
  const locId = odsEvent.location_uid || odsEvent.location_id;
  const locationId = locId ? String(locId) : `oa_loc_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const location = {
    id: locationId, coordinates: safeParseJSON(odsEvent.location_coordinates) || null,
    name: odsEvent.location_name || null, city: odsEvent.location_city || null,
    district: odsEvent.location_district || null, address: odsEvent.location_address || null,
  };

  const event = {
    id: String(odsEvent.uid || odsEvent.identifiant),
    titleFr: odsEvent.title_fr || odsEvent.title || null,
    longDescriptionFr: odsEvent.longdescription_fr || odsEvent.description || null,
    category: odsEvent.category || null,
    firstDateBegin: safeDate(odsEvent.firstdate_begin),
    originAgendaTitle: odsEvent.originagenda_title || 'OpenAgenda',
    locationId: location.id,
  };

  return { event, location };
}

function mapTicketmasterToPrisma(tmEvent) {
  const venue = tmEvent._embedded?.venues?.[0] || {};
  const locationId = venue.id || `tm_loc_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const lat = venue.location?.latitude ? parseFloat(venue.location.latitude) : null;
  const lon = venue.location?.longitude ? parseFloat(venue.location.longitude) : null;

  const location = {
    id: locationId, name: venue.name || null, city: venue.city?.name || null,
    address: venue.address?.line1 || null, coordinates: (lat && lon) ? { lat, lon } : null,
  };

  const event = {
    id: tmEvent.id, titleFr: tmEvent.name || null,
    longDescriptionFr: tmEvent.description || tmEvent.info || null,
    category: tmEvent.classifications?.[0]?.segment?.name || null,
    firstDateBegin: safeDate(tmEvent.dates?.start?.dateTime),
    originAgendaTitle: 'TicketMaster', locationId: location.id,
  };

  return { event, location };
}

function buildTextContext(event, location) {
  const parts = [];
  if (event.titleFr) parts.push(`Titre: ${event.titleFr}`);
  if (event.longDescriptionFr) parts.push(`Description: ${event.longDescriptionFr}`);
  if (event.category) parts.push(`Catégorie: ${event.category}`);
  const locParts = [location.name, location.district, location.city].filter(Boolean);
  if (locParts.length > 0) parts.push(`Lieu: ${locParts.join(', ')}`);
  return parts.join('\n\n');
}

// 🛡️ Fonction d'embedding ultra-résiliente (Gère les 429 et les 503)
async function embedWithRetry(textToEmbed, eventId, retries = 5, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.embedContent({ content: { parts: [{ text: textToEmbed }] }, outputDimensionality: 768 });
      return result.embedding.values;
    } catch (err) {
      const errMsg = (err.message || '').toLowerCase();
      // On intercepte les quotas (429) et les surcharges serveurs (503)
      if ((errMsg.includes('429') || errMsg.includes('503') || errMsg.includes('high demand')) && attempt < retries) {
        console.warn(`⏳ [Gemini Surchargé] Tentative ${attempt}/${retries} échouée pour l'event ${eventId}. Pause de ${delayMs/1000}s...`);
        await sleep(delayMs);
        delayMs *= 1.5; // Backoff plus doux pour ne pas attendre des heures non plus
      } else {
        console.error(`❌ Abandon de l'embedding pour l'event ${eventId} après ${attempt} tentatives :`, err.message);
        return null; // On renvoie null pour ne pas crasher le script global
      }
    }
  }
  return null;
}

// ============================================================================
// LOGIQUE DE TRAITEMENT
// ============================================================================

async function processCombinedBatch(prisma, mappedEvents) {
  if (mappedEvents.length === 0) return;

  try {
    const uniqueLocations = Array.from(new Map(mappedEvents.map(item => [item.location.id, item.location])).values());

    await prisma.$transaction(uniqueLocations.map(loc => prisma.location.upsert({ where: { id: loc.id }, update: loc, create: loc })));
    await prisma.$transaction(mappedEvents.map(item => prisma.event.upsert({ where: { id: item.event.id }, update: item.event, create: item.event })));

    let successCount = 0;
    for (const { event, location } of mappedEvents) {
      const textToEmbed = buildTextContext(event, location);
      if (!textToEmbed.trim()) continue;

      const embedding = await embedWithRetry(textToEmbed, event.id);
      
      if (embedding) {
        try {
          // ⚠️ Assure-toi que c'est bien `uid` ici selon ton schéma Prisma original
          await prisma.$executeRawUnsafe(
            'UPDATE events SET embedding = $1::vector WHERE uid = $2',
            `[${embedding.join(',')}]`, event.id
          );
          successCount++;
        } catch (dbErr) {
          console.error(`❌ Erreur SQL lors de la sauvegarde de l'embedding pour ${event.id}:`, dbErr.message);
        }
      }
    }
    console.log(`✅ Lot DB traité : ${mappedEvents.length} événements. ${successCount} embeddings générés.`);
  } catch (globalErr) {
    console.error(`💥 Erreur critique inattendue pendant le traitement d'un lot DB:`, globalErr.message);
    // On ne crash pas, on loggue juste pour que la boucle principale continue.
  }
}

// Générateur asynchrone OpenAgenda
async function* createOpenAgendaIterator() {
  const response = await fetch(OA_URL);
  if (!response.ok) throw new Error(`Erreur HTTP OA: ${response.status}`);
  const rl = readline.createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
  
  const today = new Date(); today.setHours(0, 0, 0, 0);

  for await (const line of rl) {
    if (!line.trim()) continue;
    const raw = safeParseJSON(line);
    if (!raw) continue;
    
    const endDate = safeDate(raw.lastdate_end || raw.end_date);
    if (endDate && endDate < today) continue; 
    
    const countryCode = (raw.location_countrycode || '').toUpperCase();
    if (countryCode !== 'FR' && countryCode !== 'FRANCE') continue;

    const mapped = mapOdsToPrisma(raw);
    if (mapped.event.id && mapped.event.titleFr) yield mapped;
  }
}

async function main() {
  console.log('🚀 Démarrage de l\'aspirateur France ULTRA-RÉSILIENT (OA + TM + Gemini)...');
  const prisma = await getPrismaClient();
  const tmApiKey = process.env.TICKETMASTER_CONSUMER_KEY;

  try {
    let oaIterator = createOpenAgendaIterator();
    
    let hasMoreOA = true;
    let hasMoreTM = true;
    let tmStepIndex = 0; 
    let tmPage = 0;

    const startDateTime = new Date().toISOString().split('.')[0] + 'Z';

    while (hasMoreOA || hasMoreTM) {
      const currentBatch = [];

      // --- 🛡️ Extraction OpenAgenda avec protection réseau ---
      if (hasMoreOA) {
        try {
          let oaCount = 0;
          while (oaCount < BATCH_SIZE) {
            const { value, done } = await oaIterator.next();
            if (done) { hasMoreOA = false; break; }
            currentBatch.push(value);
            oaCount++;
          }
          console.log(`📡 OpenAgenda: ${oaCount} événements récupérés.`);
        } catch (oaErr) {
          console.error(`⚠️ [Coupure Réseau OpenAgenda] La connexion a sauté : ${oaErr.message}`);
          console.log(`💤 Pause de 30 secondes avant de relancer le flux OpenAgenda...`);
          await sleep(30000);
          // On recrée l'itérateur. L'upsert DB gérera les doublons lus au redémarrage du flux.
          oaIterator = createOpenAgendaIterator(); 
        }
      }

      // --- 🛡️ Extraction Ticketmaster avec protection réseau ---
      if (hasMoreTM) {
        try {
          const stepQuery = TM_STEPS[tmStepIndex];
          const stepName = stepQuery ? stepQuery : "Reste de la France";
          const url = `${TM_BASE_URL}?apikey=${tmApiKey}&locale=fr&countryCode=FR&startDateTime=${startDateTime}&sort=date,asc&page=${tmPage}&size=${BATCH_SIZE}&${stepQuery}`;
          
          const response = await fetch(url);
          if (!response.ok) {
             if (response.status === 429) throw new Error("Rate Limit Ticketmaster atteint");
             throw new Error(`Erreur HTTP TM: ${response.status}`);
          }

          const data = await response.json();
          const rawEvents = data._embedded?.events || [];
          const tmCount = rawEvents.length;
          
          rawEvents.forEach(e => currentBatch.push(mapTicketmasterToPrisma(e)));
          console.log(`📡 Ticketmaster [${stepName}]: ${tmCount} événements récupérés (Page ${tmPage}).`);

          if (tmCount === 0 || data.page?.number >= data.page?.totalPages - 1) {
            tmStepIndex++;
            tmPage = 0;
            if (tmStepIndex >= TM_STEPS.length) {
              console.log('🏁 Tous les cercles Ticketmaster ont été explorés.');
              hasMoreTM = false;
            } else {
              console.log(`➡️ Passage à la zone Ticketmaster suivante.`);
            }
          } else {
            tmPage++;
          }
        } catch (tmErr) {
          console.error(`⚠️ [Erreur Ticketmaster] Problème rencontré : ${tmErr.message}`);
          console.log(`💤 Pause de 30 secondes avant de retenter la page Ticketmaster...`);
          await sleep(30000);
          // On ne fait ni tmPage++ ni hasMoreTM=false, donc à la prochaine itération il retentera la même page.
        }
      }

      // --- Traitement du lot combiné ---
      if (currentBatch.length > 0) {
        await processCombinedBatch(prisma, currentBatch);
      } else if (!hasMoreOA && !hasMoreTM) {
        console.log('🏁 Plus aucune donnée à traiter sur aucun flux.');
        break;
      }
    }

    console.log(`\n🎉 Processus Global France terminé avec succès !`);
  } catch (err) {
    console.error('💥 Erreur critique impossible à rattraper:', err);
  } finally {
    await disconnect();
  }
}

main();