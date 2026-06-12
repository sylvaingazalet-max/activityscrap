process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const https = require('https');
const fs = require('fs');

// Remonte de /scripts/eventbrite/ vers /lib/prismaClient.js
const { getPrismaClient, disconnect } = require('../../lib/prismaClient'); 

const EB_TOKEN = process.env.EVENTBRITE_PRIVATE_TOKEN;
const ORGANIZERS_FILE = path.join(__dirname, 'eventbrite.json');
const BATCH_SIZE = 50;

function mapEventbriteToPrisma(ebEvent, organizerName) {
  const venue = ebEvent.venue || {};
  
  const locationId = venue.id || `eb_loc_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const lat = venue.latitude ? parseFloat(venue.latitude) : null;
  const lon = venue.longitude ? parseFloat(venue.longitude) : null;

  const location = {
    id: locationId,
    name: venue.name || 'Lieu non spécifié',
    address: venue.address?.localized_address_display || null,
    city: venue.address?.city || null,
    postalCode: venue.address?.postal_code || null,
    countryCode: venue.address?.country || null,
    coordinates: (lat && lon) ? { lat, lon } : null,
  };

  let firstDateBegin = ebEvent.start?.utc ? new Date(ebEvent.start.utc) : null;
  if (firstDateBegin && isNaN(firstDateBegin.getTime())) firstDateBegin = null;

  let firstDateEnd = ebEvent.end?.utc ? new Date(ebEvent.end.utc) : null;
  if (firstDateEnd && isNaN(firstDateEnd.getTime())) firstDateEnd = null;

  const event = {
    id: String(ebEvent.id),
    titleFr: ebEvent.name?.text || null,
    descriptionFr: ebEvent.summary || null,
    longDescriptionFr: ebEvent.description?.html || ebEvent.description?.text || null,
    canonicalUrl: ebEvent.url || null,
    image: ebEvent.logo?.original?.url || ebEvent.logo?.url || null,
    firstDateBegin: firstDateBegin,
    firstDateEnd: firstDateEnd,
    status: ebEvent.status || null,
    originAgendaTitle: `Eventbrite - ${organizerName}`,
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

function fetchEvents(organizerId, continuation = null) {
  return new Promise((resolve, reject) => {
    // ❌ On a retiré &page_size=${BATCH_SIZE} de l'URL car l'API le refuse ici
    let apiPath = `/v3/organizers/${organizerId}/events/?status=live&expand=venue`;
    if (continuation) apiPath += `&continuation=${continuation}`;

    const options = {
      hostname: 'www.eventbriteapi.com',
      path: apiPath,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${EB_TOKEN}` },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Erreur JSON")); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(ORGANIZERS_FILE)) {
    console.error(`❌ Fichier ${ORGANIZERS_FILE} introuvable.`);
    return;
  }

  const organizers = JSON.parse(fs.readFileSync(ORGANIZERS_FILE, 'utf-8'));
  console.log(`🚀 Démarrage : ${organizers.length} organisateurs à synchroniser.`);

  const prisma = await getPrismaClient();
  let totalProcessed = 0;

  try {
    for (let i = 0; i < organizers.length; i++) {
      const org = organizers[i];
      console.log(`\n⏳ [${i + 1}/${organizers.length}] Extraction : "${org.name}"`);

      let hasMore = true;
      let continuation = null;

      while (hasMore) {
        try {
          const data = await fetchEvents(org.id, continuation);
          const events = data.events || [];

          if (events.length === 0) {
            console.log(`  -> 0 événement trouvé.`);
            break;
          }

          console.log(`  -> Récupération de ${events.length} événements...`);
          const currentBatch = events
            .map(raw => mapEventbriteToPrisma(raw, org.name))
            .filter(mapped => mapped.event.titleFr);

          if (currentBatch.length > 0) {
            await processBatch(prisma, currentBatch);
            totalProcessed += currentBatch.length;
          }

          if (data.pagination && data.pagination.has_more_items) {
            continuation = data.pagination.continuation;
            await new Promise(r => setTimeout(r, 300));
          } else {
            hasMore = false;
          }
        } catch (err) {
          console.error(`❌ Erreur API pour l'organisateur ${org.name}:`, err.message);
          hasMore = false;
        }
      }
    }
    console.log(`\n🎉 Synchronisation terminée ! ${totalProcessed} événements traités.`);
  } catch (error) {
    console.error('💥 Erreur critique:', error);
  } finally {
    await disconnect();
  }
}

main();