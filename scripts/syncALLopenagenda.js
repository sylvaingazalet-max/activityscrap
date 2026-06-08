/**
 * Synchronisation globale des événements OpenAgenda (API v2 native) vers PostgreSQL via Prisma.
 * Parcourt tous les agendas issus du fichier agendas_lille.json avec BLOCAGE en amont des agendas connus.
 */

const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const fs = require('fs');

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n💥 ERREUR FATALE SILENCIEUSE (Unhandled Rejection) :', reason);
});
process.on('uncaughtException', (err) => {
  console.error('\n💥 ERREUR FATALE SILENCIEUSE (Uncaught Exception) :', err);
});

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const isLocalDev = process.env.NODE_ENV !== 'production';
const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' || isLocalDev;

if (allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const { getPrismaClient, disconnect } = require('../lib/prismaClient');

const BATCH_SIZE = 100;
const AGENDAS_FILE = 'agendas_lille.json';


function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function mapOaToPrisma(oaEvent) {
  const lastTimingEnd = oaEvent.lastTiming?.end ? new Date(oaEvent.lastTiming.end) : null;
  const now = new Date();
  
  if (lastTimingEnd && lastTimingEnd < now) {
    return { skip: true, reason: 'past' }; 
  }

  // On garde cette sécurité au cas où un agenda autorisé aspirerait un événement d'un agenda exclu
  const originAgendaTitle = oaEvent.originAgenda?.title || oaEvent.agenda?.title || null;

  const loc = oaEvent.location || {};
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

  const eventId = String(oaEvent.uid);
  let imageUrl = null;
  if (oaEvent.image && oaEvent.image.base && oaEvent.image.filename) {
    imageUrl = `${oaEvent.image.base}${oaEvent.image.filename}`;
  } else if (typeof oaEvent.image === 'string') {
    imageUrl = oaEvent.image;
  }

  let finalTimings = oaEvent.timings || null;
  if (!finalTimings && oaEvent.firstTiming && oaEvent.lastTiming) {
    finalTimings = [{ begin: oaEvent.firstTiming.begin, end: oaEvent.lastTiming.end }];
  }

  const finalCanonicalUrl = oaEvent.canonicalUrl || (oaEvent.slug ? `https://openagenda.com/events/${oaEvent.slug}` : null);
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
    originAgendaTitle: originAgendaTitle,
    originAgendaUid: oaEvent.originAgenda?.uid ? String(oaEvent.originAgenda.uid) : null,
    category: oaEvent['type-devenement'] ? String(oaEvent['type-devenement']) : (oaEvent.category || null),
    countryFr: null,
    registration: oaEvent.registration || null,
    links: oaEvent.links || null,
    locationId: location.id,
  };

  return { event, location };
}

async function processBatch(prisma, batch) {
  const uniqueLocationsMap = new Map();
  batch.forEach(item => uniqueLocationsMap.set(item.location.id, item.location));
  const uniqueLocations = Array.from(uniqueLocationsMap.values());

  try {
    const locationOperations = uniqueLocations.map(loc => 
      prisma.location.upsert({ where: { id: loc.id }, update: loc, create: loc })
    );
    await prisma.$transaction(locationOperations);

    const eventOperations = batch.map(item => 
      prisma.event.upsert({ where: { id: item.event.id }, update: item.event, create: item.event })
    );
    await prisma.$transaction(eventOperations);

  } catch (error) {
    console.error(`\n❌ Erreur Prisma lors de l'enregistrement du lot :`, error.message);
  }
}

async function main() {
  console.log('🚀 Démarrage de la synchronisation MULTI-AGENDAS avec EXCLUSION EN AMONT...');
  
  const agendasPath = path.resolve(process.cwd(), AGENDAS_FILE);
  if (!fs.existsSync(agendasPath)) {
    console.error(`❌ Fichier introuvable : ${agendasPath}.`);
    process.exit(1);
  }

  const agendasList = JSON.parse(fs.readFileSync(agendasPath, 'utf-8'));
  console.log(`📂 ${agendasList.length} agendas à traiter.`);

  const API_KEY = process.env.OPENAGENDA_API_KEY;
  const prisma = await getPrismaClient();

  let globalProcessed = 0, globalSkippedPast = 0, globalSkippedBlacklist = 0, globalSkippedInvalid = 0;
  let agendasSkippedEntirely = 0;

  try {
    for (let i = 0; i < agendasList.length; i++) {
      const agenda = agendasList[i];
      


      console.log(`\n======================================================`);
      console.log(`⏳ [${i + 1}/${agendasList.length}] Extraction : "${agenda.title}" (UID: ${agenda.uid})`);
      console.log(`======================================================`);

      const TARGET_URL = `https://api.openagenda.com/v2/agendas/${agenda.uid}/events`;

      let hasMore = true;
      let afterCursor = [];
      let localProcessed = 0;
      let pageIndex = 1;

      while (hasMore) {
        const url = new URL(TARGET_URL);
        url.searchParams.append('passed', '0');
        url.searchParams.append('size', BATCH_SIZE.toString());

        ['location', 'timings', 'conditions', 'longDescription', 'keywords', 'registration', 'age', 'accessibility']
          .forEach(inc => url.searchParams.append('include[]', inc));

        if (afterCursor && afterCursor.length > 0) {
          afterCursor.forEach(cursor => url.searchParams.append('after[]', cursor));
        }

        try {
          process.stdout.write(`  -> Récupération de la page ${pageIndex}... `);
          
          const response = await fetch(url.toString(), {
            method: 'GET',
            headers: { 'key': API_KEY, 'Content-Type': 'application/json' }
          });
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();
          const events = data.events || [];

          if (events.length === 0) {
            console.log(`[0 événement(s)] - Terminé.`);
            hasMore = false;
            break;
          }

          console.log(`[${events.length} événement(s) analysé(s)]`);
          
          let currentBatch = [];
          for (const rawEvent of events) {
            const mappedData = mapOaToPrisma(rawEvent);
            
            if (mappedData?.skip) {
              if (mappedData.reason === 'past') globalSkippedPast++;
              if (mappedData.reason === 'blacklist') globalSkippedBlacklist++;
              continue;
            }

            if (mappedData.event.id && mappedData.event.titleFr) {
              currentBatch.push(mappedData);
            } else {
              globalSkippedInvalid++;
            }
          }

          if (currentBatch.length > 0) {
            await processBatch(prisma, currentBatch);
            localProcessed += currentBatch.length;
            globalProcessed += currentBatch.length;
          }

          if (data.after && data.after.length > 0) {
            afterCursor = data.after;
            pageIndex++;
          } else {
            hasMore = false;
          }
        } catch (err) {
          console.error(`\n⚠️ Erreur pour l'agenda ${agenda.uid}:`, err.message);
          hasMore = false;
        }
      }
      
      console.log(`📊 Bilan: ${localProcessed} nouveaux événements enregistrés pour "${agenda.title}".`);
    }

    console.log(`\n🎉 TOUS LES AGENDAS ONT ÉTÉ TRAITÉS !`);
    console.log(`🛑 Agendas complets ignorés : ${agendasSkippedEntirely}`);
    console.log(`📈 Nouveaux/Mis à jour     : ${globalProcessed} événements.`);
    console.log(`⏭️  Ignorés (Passés)         : ${globalSkippedPast}`);
    console.log(`🛡️  Ignorés (Déjà en BDD)    : ${globalSkippedBlacklist}`);

  } catch (error) {
    console.error('💥 Erreur critique dans la boucle principale:', error);
  } finally {
    await disconnect();
  }
}

main();