const path = require('path');
const dotenv = require('dotenv');
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

const { getPrismaClient, disconnect } = require('../../lib/prismaClient');

const BASE_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
const LILLE_LATLONG = '50.6292,3.0572'; 
const RADIUS = '30';
const UNIT = 'km';

// Mapper inchangé (conserve ta logique de BDD)
function mapTicketmasterToPrisma(tmEvent) {
  const venue = tmEvent._embedded?.venues?.[0] || {};
  
  const locationId = venue.id || `tm_loc_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const lat = venue.location?.latitude ? parseFloat(venue.location.latitude) : null;
  const lon = venue.location?.longitude ? parseFloat(venue.location.longitude) : null;

  const location = {
    id: locationId,
    name: venue.name || null,
    address: venue.address?.line1 || null,
    city: venue.city?.name || null,
    coordinates: (lat && lon) ? { lat, lon } : null,
  };

  const startDateStr = tmEvent.dates?.start?.dateTime;
  let firstDateBegin = startDateStr ? new Date(startDateStr) : null;
  if (firstDateBegin && isNaN(firstDateBegin.getTime())) {
    firstDateBegin = null;
  }

  const event = {
    id: tmEvent.id, 
    titleFr: tmEvent.name || null,
    longDescriptionFr: tmEvent.description || tmEvent.info || null,
    canonicalUrl: tmEvent.url || null,
    image: tmEvent.images?.[0]?.url || null,
    category: tmEvent.classifications?.[0]?.segment?.name || null,
    firstDateBegin: firstDateBegin,
    originAgendaTitle: 'TicketMaster', 
    locationId: location.id,
  };

  return { event, location };
}

// Injection en Base (Batch par page)
async function processPage(prisma, batch) {
  const uniqueLocationsMap = new Map();
  batch.forEach(item => {
    uniqueLocationsMap.set(item.location.id, item.location);
  });
  const uniqueLocations = Array.from(uniqueLocationsMap.values());

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
}

async function main() {
  const apiKey = process.env.TICKETMASTER_CONSUMER_KEY;
  
  if (!apiKey) {
    console.error('❌ Erreur : TICKETMASTER_CONSUMER_KEY n\'est pas définie dans le fichier .env');
    process.exit(1);
  }

  console.log('🚀 Test de synchronisation Ticketmaster (Échantillon réduit)...');
  const prisma = await getPrismaClient();

  try {
    const startDateTime = new Date().toISOString().split('.')[0] + 'Z';
    
    // Modification majeure : page=0 et size=5 pour un test rapide
    console.log(`📡 Interrogation de l'API pour 5 événements autour de Lille...`);
    const url = `${BASE_URL}?apikey=${apiKey}&latlong=${LILLE_LATLONG}&radius=${RADIUS}&unit=${UNIT}&locale=fr&startDateTime=${startDateTime}&sort=date,asc&page=0&size=5`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Erreur API Ticketmaster (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const rawEvents = data._embedded?.events || [];

    if (rawEvents.length === 0) {
      console.log('ℹ️ Aucun événement Ticketmaster trouvé actuellement dans un rayon de 30km autour de Lille.');
      return;
    }

    console.log(`🔍 Analyse de l'échantillon reçu :`);
    const mappedBatch = [];

    for (const tmEvent of rawEvents) {
      const mappedData = mapTicketmasterToPrisma(tmEvent);
      
      // LOG DE DIAGNOSTIC : Permet de voir la structure des données récupérées
      console.log(`\n--------------------------------------------------`);
      console.log(`📌 Événement TM : "${mappedData.event.titleFr}"`);
      console.log(`📍 Lieu détecté : "${mappedData.location.name}" (${mappedData.location.city})`);
      console.log(`🔗 URL Ticketmaster : ${mappedData.event.canonicalUrl}`);
      console.log(`--------------------------------------------------`);

      if (mappedData.event.titleFr) {
        mappedBatch.push(mappedData);
      }
    }

    if (mappedBatch.length > 0) {
      console.log(`\n📦 Injection de ${mappedBatch.length} événements de test dans PostgreSQL via Prisma...`);
      await processPage(prisma, mappedBatch);
      console.log(`✅ Injection réussie.`);
    }

  } catch (error) {
    console.error('💥 Erreur critique lors du test :', error);
  } finally {
    await disconnect();
  }
}

main();