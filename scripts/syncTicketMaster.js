/**
 * Synchronisation des événements Ticketmaster vers PostgreSQL via Prisma.
 * Gère la pagination, la séparation Lieu/Événement, et sécurise les clés d'API.
 */

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

const { getPrismaClient, disconnect } = require('../lib/prismaClient');

// ============================================================================
// Configuration
// ============================================================================
const BASE_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
const LILLE_LATLONG = '50.6292,3.0572'; // Centre de Lille
const RADIUS = '30';
const UNIT = 'km';

// ============================================================================
// Mapper API -> Prisma
// ============================================================================

/**
 * Mappe un objet JSON Ticketmaster vers les schémas Prisma "Event" et "Location"
 */
function mapTicketmasterToPrisma(tmEvent) {
  const venue = tmEvent._embedded?.venues?.[0] || {};
  
  // 1. Extraction du Lieu (Location)
  // On utilise l'ID de la salle fourni par Ticketmaster s'il existe
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

  // 2. Extraction de l'Événement (Event)
  const startDateStr = tmEvent.dates?.start?.dateTime;
  let firstDateBegin = startDateStr ? new Date(startDateStr) : null;
  // Vérification de validité de la date
  if (firstDateBegin && isNaN(firstDateBegin.getTime())) {
    firstDateBegin = null;
  }

  const event = {
    id: tmEvent.id, // On garde l'ID string natif de Ticketmaster
    titleFr: tmEvent.name || null,
    longDescriptionFr: tmEvent.description || tmEvent.info || null,
    canonicalUrl: tmEvent.url || null,
    image: tmEvent.images?.[0]?.url || null,
    category: tmEvent.classifications?.[0]?.segment?.name || null,
    firstDateBegin: firstDateBegin,
    
    // On stocke l'origine pour filtrer facilement dans l'application
    originAgendaTitle: 'TicketMaster', 
    
    // Clé étrangère vers le lieu
    locationId: location.id,
  };

  return { event, location };
}

// ============================================================================
// Injection en Base (Batch par page)
// ============================================================================

/**
 * Exécute l'UPSERT en base pour une page entière via des transactions Prisma
 */
async function processPage(prisma, batch) {
  // 1. Isoler et dédoublonner les Lieux de la page en cours
  const uniqueLocationsMap = new Map();
  batch.forEach(item => {
    uniqueLocationsMap.set(item.location.id, item.location);
  });
  const uniqueLocations = Array.from(uniqueLocationsMap.values());

  // 2. Upsert des Lieux EN PREMIER
  const locationOperations = uniqueLocations.map(loc => 
    prisma.location.upsert({
      where: { id: loc.id },
      update: loc,
      create: loc
    })
  );
  await prisma.$transaction(locationOperations);

  // 3. Upsert des Événements ENSUITE
  const eventOperations = batch.map(item => 
    prisma.event.upsert({
      where: { id: item.event.id },
      update: item.event,
      create: item.event
    })
  );
  await prisma.$transaction(eventOperations);
}

// ============================================================================
// Fonction Principale
// ============================================================================

async function main() {
  const apiKey = process.env.TICKETMASTER_CONSUMER_KEY;
  
  if (!apiKey) {
    console.error('❌ Erreur : TICKETMASTER_CONSUMER_KEY n\'est pas définie dans le fichier .env');
    process.exit(1);
  }

  console.log('🚀 Démarrage de la synchronisation Ticketmaster...');
  const prisma = await getPrismaClient();

  try {
    const startDateTime = new Date().toISOString().split('.')[0] + 'Z';
    
    let page = 0;
    let hasMorePages = true;
    let totalInsertedOrUpdated = 0;

    while (hasMorePages) {
      console.log(`📡 Récupération de la page ${page + 1}...`);
      
      const url = `${BASE_URL}?apikey=${apiKey}&latlong=${LILLE_LATLONG}&radius=${RADIUS}&unit=${UNIT}&locale=fr&startDateTime=${startDateTime}&sort=date,asc&page=${page}&size=50`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Erreur API Ticketmaster (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const rawEvents = data._embedded?.events || [];

      if (rawEvents.length === 0) {
        hasMorePages = false;
        break;
      }

      console.log(`📦 Traitement de ${rawEvents.length} événements...`);

      // Mappage et filtrage des événements invalides
      const mappedBatch = [];
      for (const tmEvent of rawEvents) {
        const mappedData = mapTicketmasterToPrisma(tmEvent);
        if (mappedData.event.titleFr) {
          mappedBatch.push(mappedData);
        }
      }

      // Envoi du lot complet à Prisma via des transactions
      if (mappedBatch.length > 0) {
        await processPage(prisma, mappedBatch);
        totalInsertedOrUpdated += mappedBatch.length;
      }

      // Gestion de la pagination
      const pageInfo = data.page || {};
      if (pageInfo.number >= pageInfo.totalPages - 1) {
        hasMorePages = false;
      } else {
        page++;
        // Pause pour respecter le Rate Limit de Ticketmaster (5 requêtes/seconde max)
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    console.log(`\n🎉 Synchronisation Ticketmaster réussie !`);
    console.log(`📊 Total insérés/mis à jour : ${totalInsertedOrUpdated} événements.`);

  } catch (error) {
    console.error('💥 Erreur critique lors de la synchronisation Ticketmaster :', error);
  } finally {
    await disconnect();
  }
}

main();