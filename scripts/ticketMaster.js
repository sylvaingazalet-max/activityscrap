/**
 * Synchronisation des événements Ticketmaster vers PostgreSQL via Prisma.
 * Gère la pagination et sécurise les clés d'API via les variables d'environnement.
 */

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

// ============================================================================
// 1. FIX TLS : Obligatoire sur ta machine pour éviter le "fetch failed"
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
const RADIUS = '15';
const UNIT = 'km';

/**
 * Génère un identifiant BigInt unique et stable à partir de l'ID String de Ticketmaster.
 */
function generateBigIntId(stringId) {
  let hash = 0;
  for (let i = 0; i < stringId.length; i++) {
    const code = stringId.charCodeAt(i);
    hash = (hash << 5) - hash + code;
    hash = hash & hash;
  }
  return BigInt(Math.abs(hash));
}

/**
 * Mappe un objet JSON Ticketmaster vers le schéma Prisma "events"
 */
function mapTicketmasterToPrisma(tmEvent) {
  const venue = tmEvent._embedded?.venues?.[0] || {};
  
  return {
    Identifiant: generateBigIntId(tmEvent.id),
    Titre___FR: tmEvent.name,
    Description_longue___FR: tmEvent.description || tmEvent.info || null,
    Permalien: tmEvent.url || null,
    Image: tmEvent.images?.[0]?.url || null,
    Lieu__Nom: venue.name || null,
    Lieu__Adresse: venue.address?.line1 || null,
    Lieu__Ville: venue.city?.name || null,
    Lieu__Latitude: venue.location?.latitude ? parseFloat(venue.location.latitude) : null,
    Lieu__Longitude: venue.location?.longitude ? parseFloat(venue.location.longitude) : null,
    Type_d__v_nement: tmEvent.classifications?.[0]?.segment?.name || null,
    Horaires_ISO: tmEvent.dates?.start?.dateTime ? new Date(tmEvent.dates.start.dateTime).toISOString() : null,
    Lien_d_acc_s: tmEvent.url || null
  };
}

/**
 * Fonction Principale
 */
async function main() {
  // Prise en compte de ta variable d'environnement personnalisée
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
      const events = data._embedded?.events || [];

      if (events.length === 0) {
        hasMorePages = false;
        break;
      }

      console.log(`📦 Traitement de ${events.length} événements depuis Ticketmaster...`);

      for (const tmEvent of events) {
        const mappedEvent = mapTicketmasterToPrisma(tmEvent);

        if (!mappedEvent.Titre___FR) continue;

        await prisma.events.upsert({
          where: { Identifiant: mappedEvent.Identifiant },
          update: {
            Titre___FR: mappedEvent.Titre___FR,
            Description_longue___FR: mappedEvent.Description_longue___FR,
            Permalien: mappedEvent.Permalien,
            Image: mappedEvent.Image,
            Lieu__Nom: mappedEvent.Lieu__Nom,
            Lieu__Adresse: mappedEvent.Lieu__Adresse,
            Lieu__Ville: mappedEvent.Lieu__Ville,
            Lieu__Latitude: mappedEvent.Lieu__Latitude,
            Lieu__Longitude: mappedEvent.Lieu__Longitude,
            Type_d__v_nement: mappedEvent.Type_d__v_nement,
            Horaires_ISO: mappedEvent.Horaires_ISO,
            Lien_d_acc_s: mappedEvent.Lien_d_acc_s
          },
          create: mappedEvent
        });
        
        totalInsertedOrUpdated++;
      }

      const pageInfo = data.page || {};
      if (pageInfo.number >= pageInfo.totalPages - 1) {
        hasMorePages = false;
      } else {
        page++;
        // Pause pour respecter le Rate Limit de Ticketmaster
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    console.log(`\n🎉 Synchronisation Ticketmaster réussie !`);
    console.log(`📊 Total traités : ${totalInsertedOrUpdated} événements.`);

  } catch (error) {
    // Affiche la totalité de l'erreur pour voir le [cause] profond en cas de souci
    console.error('💥 Erreur critique lors de la synchronisation Ticketmaster :', error);
  } finally {
    await disconnect();
  }
}

main();