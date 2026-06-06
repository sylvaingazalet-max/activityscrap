/**
 * Synchronisation des événements Opendatasoft vers PostgreSQL via Prisma.
 * Utilise un flux (Streaming) pour éviter de saturer la RAM.
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
const { Readable } = require('stream');
const readline = require('readline');

// ============================================================================
// Configuration
// ============================================================================
const BATCH_SIZE = 100;
const BASE_URL = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/exports/jsonl';

// Coordonnées de Lille (Rayon 15km)
const LILLE_LON = 3.0572;
const LILLE_LAT = 50.6292;
const DISTANCE = '15km';

/**
 * Mappe un objet JSON de l'API vers le schéma Prisma "events"
 */
function mapOdsToPrisma(odsEvent) {
  // L'API OpenAgenda renvoie l'ID sous forme numérique ou string, on le force en BigInt
  return {
    Identifiant: BigInt(odsEvent.uid || odsEvent.identifiant),
    Titre___FR: odsEvent.title_fr || odsEvent.title,
    Description_longue___FR: odsEvent.longdescription_fr || odsEvent.description,
    Lieu__Nom: odsEvent.location_name,
    Lieu__Adresse: odsEvent.location_address,
    Lieu__Ville: odsEvent.location_city,
    Lieu__Latitude: odsEvent.location_coordinates?.lat || null,
    Lieu__Longitude: odsEvent.location_coordinates?.lon || null,
    Type_d__v_nement: odsEvent.event_type || null,
    // On conserve un format date standard ISO pour la base
    // On cherche les différents noms de champs possibles pour la date
    Horaires_ISO: odsEvent.firstdate_fr || odsEvent.date_start || odsEvent.start_date || null
  };
}

/**
 * Exécute l'UPSERT en base par lots (Batch) via une transaction Prisma
 */
async function processBatch(prisma, batch) {
  console.log(`📦 Traitement d'un lot de ${batch.length} événements...`);
  
  // Prisma gère le ON CONFLICT via la méthode "upsert"
  const operations = batch.map(eventData => {
    return prisma.events.upsert({
      where: { Identifiant: eventData.Identifiant },
      update: {
        Titre___FR: eventData.Titre___FR,
        Description_longue___FR: eventData.Description_longue___FR,
        Lieu__Nom: eventData.Lieu__Nom,
        Lieu__Adresse: eventData.Lieu__Adresse,
        Lieu__Ville: eventData.Lieu__Ville,
        Lieu__Latitude: eventData.Lieu__Latitude,
        Lieu__Longitude: eventData.Lieu__Longitude,
        Type_d__v_nement: eventData.Type_d__v_nement,
        Horaires_ISO: eventData.Horaires_ISO
      },
      create: eventData
    });
  });

  try {
    await prisma.$transaction(operations);
    console.log(`✅ Lot de ${batch.length} inséré/mis à jour avec succès.`);
  } catch (error) {
    console.error(`❌ Erreur lors du traitement du lot :`, error.message);
  }
}

/**
 * Fonction Principale
 */
async function main() {
  console.log('🚀 Démarrage de la synchronisation des événements (Streaming Bulk)...');
  const prisma = await getPrismaClient();

  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const todayDateObj = new Date(todayStr);
    
    // Construction de la clause WHERE pour l'API (uniquement la géolocalisation)
    const whereClause = `within_distance(location_coordinates, geom'POINT(${LILLE_LON} ${LILLE_LAT})', ${DISTANCE})`;
    const targetUrl = `${BASE_URL}?where=${encodeURIComponent(whereClause)}`;

    console.log(`📡 Connexion au flux Opendatasoft...`);
    const response = await fetch(targetUrl);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erreur API Opendatasoft: ${response.status} ${response.statusText}\n🔍 Détail de l'API: ${errorText}`);
    }

    const stream = Readable.fromWeb(response.body);
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    let currentBatch = [];
    let totalProcessed = 0;
    let totalSkipped = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const rawEvent = JSON.parse(line);
        
        // --- FILTRE DES DATES EN NODE.JS ---
        // On récupère la date de fin (sous ses différents noms possibles selon les datasets)
        const eventEndDateStr = rawEvent.lastdate_fr || rawEvent.date_end || rawEvent.end_date;
        
        if (eventEndDateStr) {
          const eventEndDate = new Date(eventEndDateStr);
          // Si l'événement est déjà terminé, on le passe
          if (eventEndDate < todayDateObj) {
            totalSkipped++;
            continue; 
          }
        }

        const mappedEvent = mapOdsToPrisma(rawEvent);
        
        // On ne garde que les événements qui ont au moins un titre et un ID
        if (mappedEvent.Identifiant && mappedEvent.Titre___FR) {
          currentBatch.push(mappedEvent);
        } else {
          totalSkipped++;
        }

        if (currentBatch.length === BATCH_SIZE) {
          await processBatch(prisma, currentBatch);
          totalProcessed += currentBatch.length;
          currentBatch = [];
        }
      } catch (parseError) {
        console.warn(`⚠️ Ligne JSON invalide ignorée.`);
      }
    }

    if (currentBatch.length > 0) {
      await processBatch(prisma, currentBatch);
      totalProcessed += currentBatch.length;
    }

    console.log(`\n🎉 Synchronisation terminée !`);
    console.log(`📊 Bilan : ${totalProcessed} événements insérés/mis à jour.`);
    console.log(`⏭️  Bilan : ${totalSkipped} événements ignorés (passés ou invalides).`);

  } catch (error) {
    console.error('💥 Erreur critique lors de la synchronisation:', error);
  } finally {
    await disconnect();
  }
}

main();