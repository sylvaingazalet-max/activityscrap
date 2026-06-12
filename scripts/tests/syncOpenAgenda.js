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

const { getPrismaClient, disconnect } = require('../../lib/prismaClient');
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

// ============================================================================
// Fonctions Utilitaires
// ============================================================================

/** Parse le JSON en toute sécurité (OpenAgenda renvoie parfois des strings au lieu d'objets purs) */
function safeParseJSON(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

/** Convertit une chaîne en objet Date valide pour Prisma */
function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// ============================================================================
// Mapper API -> Prisma
// ============================================================================

/**
 * Mappe un objet JSON de l'API vers les schémas Prisma "Event" et "Location"
 */
function mapOdsToPrisma(odsEvent) {
  // 1. Extraction du Lieu (Location)
  // On gère le cas où l'ID est absent pour ne pas tout bloquer
  const rawLocId = odsEvent.location_uid || odsEvent.location_id;
  const locationId = rawLocId ? String(rawLocId) : `unknown_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const location = {
    id: locationId,
    coordinates: safeParseJSON(odsEvent.location_coordinates) || null,
    name: odsEvent.location_name || null,
    address: odsEvent.location_address || null,
    district: odsEvent.location_district || null,
    insee: odsEvent.location_insee ? String(odsEvent.location_insee) : null,
    postalCode: odsEvent.location_postalcode ? String(odsEvent.location_postalcode) : null,
    city: odsEvent.location_city || null,
    department: odsEvent.location_department ? String(odsEvent.location_department) : null,
    region: odsEvent.location_region || null,
    countryCode: odsEvent.location_countrycode || null,
    image: odsEvent.location_image || null,
    imageCredits: odsEvent.location_imagecredits || null,
    phone: odsEvent.location_phone ? String(odsEvent.location_phone) : null,
    website: odsEvent.location_website || null,
    links: odsEvent.location_links || null,
    tags: safeParseJSON(odsEvent.location_tags) || null,
    descriptionFr: odsEvent.location_description_fr || null,
    accessFr: odsEvent.location_access_fr || null,
  };

  // 2. Extraction de l'Événement (Event)
  const eventId = String(odsEvent.uid || odsEvent.identifiant);

  // Prisma attend un tableau de string pour accessibilityLabelFr (String[])
  let accLabels = [];
  if (Array.isArray(odsEvent.accessibility_label_fr)) {
    accLabels = odsEvent.accessibility_label_fr;
  } else if (typeof odsEvent.accessibility_label_fr === 'string') {
    accLabels = [odsEvent.accessibility_label_fr];
  }

  const event = {
    id: eventId,
    slug: odsEvent.slug || null,
    canonicalUrl: odsEvent.canonicalurl || null,
    titleFr: odsEvent.title_fr || odsEvent.title || null,
    descriptionFr: odsEvent.description_fr || null,
    longDescriptionFr: odsEvent.longdescription_fr || odsEvent.description || null,
    conditionsFr: odsEvent.conditions_fr || null,
    keywordsFr: safeParseJSON(odsEvent.keywords_fr) || null,
    
    image: odsEvent.image || null,
    imageCredits: odsEvent.imagecredits || null,
    thumbnail: odsEvent.thumbnail || null,
    originalImage: odsEvent.originalimage || null,
    
    updatedAt: safeDate(odsEvent.updatedat),
    dateRangeFr: odsEvent.daterange_fr || null,
    firstDateBegin: safeDate(odsEvent.firstdate_begin),
    firstDateEnd: safeDate(odsEvent.firstdate_end),
    lastDateBegin: safeDate(odsEvent.lastdate_begin),
    lastDateEnd: safeDate(odsEvent.lastdate_end),
    timings: safeParseJSON(odsEvent.timings) || null,
    
    accessibility: odsEvent.accessibility || null,
    accessibilityLabelFr: accLabels,
    
    attendanceMode: safeParseJSON(odsEvent.attendancemode) || null,
    onlineAccessLink: odsEvent.onlineaccesslink || null,
    status: safeParseJSON(odsEvent.status) || null,
    ageMin: parseInt(odsEvent.age_min, 10) || null,
    ageMax: parseInt(odsEvent.age_max, 10) || null,
    
    originAgendaTitle: odsEvent.originagenda_title || null,
    originAgendaUid: odsEvent.originagenda_uid ? String(odsEvent.originagenda_uid) : null,
    category: odsEvent.category || null,
    countryFr: odsEvent.country_fr || null,
    
    registration: safeParseJSON(odsEvent.registration) || null,
    links: safeParseJSON(odsEvent.links) || null,
    
    contributorEmail: odsEvent.contributor_email || null,
    contributorContactNumber: odsEvent.contributor_contactnumber ? String(odsEvent.contributor_contactnumber) : null,
    contributorContactName: odsEvent.contributor_contactname || null,
    contributorContactPosition: odsEvent.contributor_contactposition || null,
    contributorOrganization: odsEvent.contributor_organization || null,

    // Clé étrangère
    locationId: location.id,
  };

  return { event, location };
}

// ============================================================================
// Injection en Base (Batch)
// ============================================================================

/**
 * Exécute l'UPSERT en base par lots via des transactions Prisma
 */
async function processBatch(prisma, batch) {
  console.log(`📦 Traitement d'un lot de ${batch.length} événements...`);
  
  // 1. Isoler et dédoublonner les Lieux (Locations)
  const uniqueLocationsMap = new Map();
  batch.forEach(item => {
    uniqueLocationsMap.set(item.location.id, item.location);
  });
  const uniqueLocations = Array.from(uniqueLocationsMap.values());

  try {
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

  } catch (error) {
    console.error(`❌ Erreur lors du traitement du lot :`, error.message);
  }
}

// ============================================================================
// Fonction Principale
// ============================================================================

async function main() {
  console.log('🚀 Démarrage de la synchronisation des événements (Streaming Bulk)...');
  const prisma = await getPrismaClient();

  try {
    const todayDateObj = new Date();
    todayDateObj.setHours(0, 0, 0, 0);
    
    const whereClause = `within_distance(location_coordinates, geom'POINT(${LILLE_LON} ${LILLE_LAT})', ${DISTANCE})`;
    const targetUrl = `${BASE_URL}?where=${encodeURIComponent(whereClause)}`;

    console.log(`📡 Connexion au flux Opendatasoft...`);
    const response = await fetch(targetUrl);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erreur API Opendatasoft: ${response.status} ${response.statusText}\n🔍 Détail: ${errorText}`);
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

      let rawEvent;
      // 1. On isole STRICTEMENT le parsing JSON dans son propre try/catch
      try {
        rawEvent = JSON.parse(line);
      } catch (parseError) {
        console.warn(`⚠️ Ligne JSON invalide ignorée.`);
        continue; // On passe à la ligne suivante
      }

      // 2. Traitement des données
      // On récupère la date de fin (sous ses différents noms possibles)
      const eventEndDateStr = rawEvent.lastdate_end || rawEvent.lastdate_fr || rawEvent.date_end || rawEvent.end_date;
      
      if (eventEndDateStr) {
        const eventEndDate = new Date(eventEndDateStr);
        if (eventEndDate < todayDateObj) {
          totalSkipped++;
          continue; 
        }
      }

      const mappedData = mapOdsToPrisma(rawEvent);
      
      // On ne garde que les événements qui ont au moins un titre et un ID valide
      if (mappedData.event.id && mappedData.event.titleFr) {
        currentBatch.push(mappedData);
      } else {
        totalSkipped++;
      }

      // 3. Envoi du lot
      // On utilise >= au cas où, pour être sûr de toujours vider
      if (currentBatch.length >= BATCH_SIZE) {
        await processBatch(prisma, currentBatch);
        totalProcessed += currentBatch.length;
        currentBatch = []; // On vide le lot correctement
      }
    }

    // 4. Envoi des derniers éléments restants
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