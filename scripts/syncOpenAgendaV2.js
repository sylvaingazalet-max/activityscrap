/**
 * Synchronisation des événements OpenAgenda (API v2 native) vers PostgreSQL via Prisma.
 * Version ciblée (Ville de Lille) avec extraction des données riches et filtrage temporel.
 */

const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

// ============================================================================
// Contournement TLS pour le développement local
// ============================================================================
const isLocalDev = process.env.NODE_ENV !== 'production';
const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' || isLocalDev;

if (allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠️ Mode développement local : Vérification TLS désactivée');
}

const { getPrismaClient, disconnect } = require('../lib/prismaClient');

// ============================================================================
// Configuration
// ============================================================================
const BATCH_SIZE = 100;
const AGENDA_SLUG = 'ville-de-lille'; // Le nom public de l'agenda cible

// ============================================================================
// Fonctions Utilitaires
// ============================================================================

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// ============================================================================
// Mapper API -> Prisma
// ============================================================================

function mapOaToPrisma(oaEvent) {
  // 1. GARDE-FOU TEMPOREL : On vérifie si l'événement est 100% dans le passé
  const lastTimingEnd = oaEvent.lastTiming?.end ? new Date(oaEvent.lastTiming.end) : null;
  const now = new Date();
  
  if (lastTimingEnd && lastTimingEnd < now) {
    return null; // L'événement est obsolète, on l'écarte
  }

  // 2. Extraction du Lieu (Location)
  const loc = oaEvent.location || {};
  
  // Génération d'un ID stable basé sur les infos du lieu si 'uid' est absent
  let locationId = loc.uid ? String(loc.uid) : null;
  if (!locationId) {
    const locString = `${loc.name || ''}_${loc.latitude || ''}_${loc.longitude || ''}`;
    locationId = `custom_${crypto.createHash('md5').update(locString).digest('hex')}`;
  }

  const location = {
    id: locationId,
    coordinates: (loc.latitude && loc.longitude) ? { lat: loc.latitude, lon: loc.longitude } : null,
    name: loc.name || null,
    address: loc.address || null,
    district: loc.district || null,
    insee: loc.insee ? String(loc.insee) : null,
    postalCode: loc.postalCode ? String(loc.postalCode) : null,
    city: loc.city || null,
    department: loc.department || null,
    region: loc.region || null,
    countryCode: loc.countryCode || null,
    image: loc.image || null,
    imageCredits: loc.imageCredits || null,
    phone: loc.phone ? String(loc.phone) : null,
    website: loc.website || null,
    links: loc.links || null,
    tags: loc.tags || null,
    descriptionFr: loc.description?.fr || null,
    accessFr: loc.access?.fr || null,
  };

  // 3. Extraction de l'Événement (Event)
  const eventId = String(oaEvent.uid);

  let imageUrl = null;
  if (oaEvent.image && oaEvent.image.base && oaEvent.image.filename) {
    imageUrl = `${oaEvent.image.base}${oaEvent.image.filename}`;
  } else if (typeof oaEvent.image === 'string') {
    imageUrl = oaEvent.image;
  }

  // Fallback pour les horaires (utile pour la requête SQL pgvector)
  let finalTimings = oaEvent.timings || null;
  if (!finalTimings && oaEvent.firstTiming && oaEvent.lastTiming) {
    finalTimings = [{ 
      begin: oaEvent.firstTiming.begin, 
      end: oaEvent.lastTiming.end 
    }];
  }

  // Reconstruction de l'URL si elle est absente
  const finalCanonicalUrl = oaEvent.canonicalUrl || (oaEvent.slug ? `https://openagenda.com/events/${oaEvent.slug}` : null);
  
  // Extraction de la tarification (priorité au champ personnalisé "tarifs")
  const tarifValue = oaEvent.tarifs || oaEvent.conditions?.fr || null;

  const event = {
    id: eventId,
    slug: oaEvent.slug || null,
    canonicalUrl: finalCanonicalUrl,
    titleFr: oaEvent.title?.fr || null,
    descriptionFr: oaEvent.description?.fr || null,
    longDescriptionFr: oaEvent.longDescription?.fr || null,
    conditionsFr: tarifValue,
    keywordsFr: oaEvent.keywords?.fr || null,
    image: imageUrl,
    imageCredits: oaEvent.imageCredits || null,
    thumbnail: oaEvent.thumbnail || null,
    originalImage: oaEvent.originalImage || null,
    updatedAt: safeDate(oaEvent.updatedAt),
    dateRangeFr: oaEvent.dateRange?.fr || null,
    firstDateBegin: safeDate(oaEvent.firstTiming?.begin || oaEvent.firstDate),
    firstDateEnd: null,
    lastDateBegin: null, 
    lastDateEnd: safeDate(oaEvent.lastTiming?.end || oaEvent.lastDate),
    timings: finalTimings, 
    accessibility: oaEvent.accessibility || null,
    accessibilityLabelFr: [], 
    attendanceMode: oaEvent.attendanceMode || null,
    onlineAccessLink: oaEvent.onlineAccessLink || null,
    status: oaEvent.status || null,
    ageMin: parseInt(oaEvent.age?.min, 10) || null,
    ageMax: parseInt(oaEvent.age?.max, 10) || null,
    originAgendaTitle: oaEvent.originAgenda?.title || oaEvent.agenda?.title || null,
    originAgendaUid: oaEvent.originAgenda?.uid ? String(oaEvent.originAgenda.uid) : null,
    category: oaEvent['type-devenement'] ? String(oaEvent['type-devenement']) : (oaEvent.category || null),
    countryFr: null,
    registration: oaEvent.registration || null,
    links: oaEvent.links || null,
    locationId: location.id,
  };

  return { event, location };
}

// ============================================================================
// Injection en Base (Batch)
// ============================================================================

async function processBatch(prisma, batch) {
  console.log(`📦 Enregistrement d'un lot de ${batch.length} événements...`);
  
  const uniqueLocationsMap = new Map();
  batch.forEach(item => {
    uniqueLocationsMap.set(item.location.id, item.location);
  });
  const uniqueLocations = Array.from(uniqueLocationsMap.values());

  try {
    const locationOperations = uniqueLocations.map(loc => 
      prisma.location.upsert({
        where: { id: loc.id },
        update: loc,
        create: loc
      })
    );
    await prisma.$transaction(locationOperations);

    const eventOperations = batch.map(item => 
      prisma.event.upsert({
        where: { id: item.event.id },
        update: item.event,
        create: item.event
      })
    );
    await prisma.$transaction(eventOperations);

  } catch (error) {
    console.error(`❌ Erreur lors de l'enregistrement du lot :`, error.message);
  }
}

// ============================================================================
// Fonction Principale
// ============================================================================

async function main() {
  console.log('🚀 Démarrage de la synchronisation ciblée (OpenAgenda API v2)...');
  const prisma = await getPrismaClient();

  try {
    const API_KEY = process.env.OPENAGENDA_API_KEY;
    if (!API_KEY) {
      throw new Error("Clé OPENAGENDA_API_KEY introuvable. Ajoutez-la dans le fichier .env");
    }

    // 1. Découverte de l'UID de l'agenda
    console.log(`🔍 Recherche de l'identifiant pour l'agenda "${AGENDA_SLUG}"...`);
    const searchAgendaUrl = `https://api.openagenda.com/v2/agendas?slug=${AGENDA_SLUG}`;
    const agendaRes = await fetch(searchAgendaUrl, {
      method: 'GET',
      headers: { 'key': API_KEY }
    });

    if (!agendaRes.ok) {
      const errTxt = await agendaRes.text();
      throw new Error(`Échec de la recherche d'agenda (${agendaRes.status}): ${errTxt}`);
    }

    const agendaSearchData = await agendaRes.json();
    if (!agendaSearchData.agendas || agendaSearchData.agendas.length === 0) {
      throw new Error(`Aucun agenda trouvé avec le slug "${AGENDA_SLUG}".`);
    }

    const agendaUid = agendaSearchData.agendas[0].uid;
    console.log(`✅ Agenda trouvé ! UID : ${agendaUid}`);

    // 2. Construction de l'URL spécifique
    const TARGET_URL = `https://api.openagenda.com/v2/agendas/${agendaUid}/events`;

    let hasMore = true;
    let afterCursor = [];
    let totalProcessed = 0;
    let totalSkippedPast = 0;
    let totalSkippedInvalid = 0;

    console.log(`📡 Connexion à l'API pour récupérer les événements...`);

    while (hasMore) {
      const url = new URL(TARGET_URL);
      
      url.searchParams.append('passed', '0'); // On exclut les événements passés côté serveur (si possible)
      url.searchParams.append('size', BATCH_SIZE.toString());

      // On force la récupération complète de toutes les propriétés utiles
      const includes = [
        'location', 'timings', 'conditions', 'longDescription', 
        'keywords', 'registration', 'age', 'accessibility'
      ];
      includes.forEach(inc => url.searchParams.append('include[]', inc));

      if (afterCursor && afterCursor.length > 0) {
        afterCursor.forEach(cursor => url.searchParams.append('after[]', cursor));
      }

      // Appel sécurisé par les headers
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'key': API_KEY,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Erreur API OpenAgenda (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const events = data.events || [];

      if (events.length === 0) {
        hasMore = false;
        break;
      }

      console.log(`📥 Page récupérée : ${events.length} événements. Traitement en cours...`);

      let currentBatch = [];
      for (const rawEvent of events) {
        const mappedData = mapOaToPrisma(rawEvent);
        
        if (!mappedData) {
          totalSkippedPast++; // Événement rejeté par notre filtre anti-passé
          continue;
        }

        // Validation basique finale
        if (mappedData.event.id && mappedData.event.titleFr) {
          currentBatch.push(mappedData);
        } else {
          totalSkippedInvalid++;
        }
      }

      if (currentBatch.length > 0) {
        await processBatch(prisma, currentBatch);
        totalProcessed += currentBatch.length;
      }

      if (data.after && data.after.length > 0) {
        afterCursor = data.after;
      } else {
        hasMore = false;
      }
    }

    console.log(`\n🎉 Synchronisation terminée avec succès !`);
    console.log(`📊 Bilan : ${totalProcessed} événements futurs insérés/mis à jour.`);
    console.log(`⏭️  Ignorés : ${totalSkippedPast} obsolètes | ${totalSkippedInvalid} incomplets.`);

  } catch (error) {
    console.error('💥 Erreur critique lors de la synchronisation:', error);
  } finally {
    await disconnect();
  }
}

main();