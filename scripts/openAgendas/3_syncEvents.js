const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { getPrismaClient, disconnect } = require('../../lib/prismaClient');

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const OA_API_KEY = process.env.OPENAGENDA_API_KEY;
const BATCH_SIZE_EVENTS = 100;

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function mapOaToPrisma(oaEvent) {
  const lastTimingEnd = oaEvent.lastTiming?.end ? new Date(oaEvent.lastTiming.end) : null;
  const now = new Date();
  
  // Ignorer les événements passés
  if (lastTimingEnd && lastTimingEnd < now) {
    return { skip: true }; 
  }

  // --- MAPPING LOCATION ---
  const loc = oaEvent.location || {};
  let locationId = loc.uid ? String(loc.uid) : null;
  
  if (!locationId) {
    // Reprise stricte de la logique de hash du OLD (Nom + Lat + Lon)
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

  // --- MAPPING EVENT ---
  const eventId = String(oaEvent.uid);
  
  // Reconstruction de l'URL de l'image
  let imageUrl = null;
  if (oaEvent.image && oaEvent.image.base && oaEvent.image.filename) {
    imageUrl = `${oaEvent.image.base}${oaEvent.image.filename}`;
  } else if (typeof oaEvent.image === 'string') {
    imageUrl = oaEvent.image;
  }

  // Gestion des timings
  let finalTimings = oaEvent.timings || null;
  if (!finalTimings && oaEvent.firstTiming && oaEvent.lastTiming) {
    finalTimings = [{ begin: oaEvent.firstTiming.begin, end: oaEvent.lastTiming.end }];
  }

  const finalCanonicalUrl = oaEvent.canonicalUrl || (oaEvent.slug ? `https://openagenda.com/events/${oaEvent.slug}` : null);
  const tarifValue = oaEvent.tarifs || oaEvent.conditions?.fr || null;
  
  // Nom de l'agenda avec le préfixe "OpenAgenda : "
  const rawAgendaTitle = oaEvent.originAgenda?.title || oaEvent.agenda?.title || null;
  const originAgendaTitle = rawAgendaTitle ? `OpenAgenda : ${rawAgendaTitle}` : null;

  // Fallback de description
  const descFr = oaEvent.description?.fr || null;
  const longDescFr = oaEvent.longDescription?.fr || null;

  const event = {
    id: eventId,
    slug: oaEvent.slug || null,
    canonicalUrl: finalCanonicalUrl,
    titleFr: oaEvent.title?.fr || null,
    descriptionFr: descFr,
    longDescriptionFr: longDescFr || descFr, // Fallback si la description longue est absente
    conditionsFr: tarifValue,
    keywordsFr: oaEvent.keywords?.fr || null,
    image: imageUrl,
    imageCredits: oaEvent.imageCredits || null,
    thumbnail: oaEvent.thumbnail || null,
    originalImage: oaEvent.originalImage || null,
    updatedAt: safeDate(oaEvent.updatedAt),
    dateRangeFr: oaEvent.dateRange?.fr || null,
    
    // Correction des régressions : dates intermédiaires
    firstDateBegin: safeDate(oaEvent.firstTiming?.begin || oaEvent.firstDate),
    firstDateEnd: safeDate(oaEvent.firstTiming?.end), 
    lastDateBegin: safeDate(oaEvent.lastTiming?.begin), 
    lastDateEnd: safeDate(oaEvent.lastTiming?.end || oaEvent.lastDate),
    
    timings: finalTimings, 
    accessibility: oaEvent.accessibility || null,
    accessibilityLabelFr: [], // L'API v2 gère ça via l'objet accessibility ci-dessus
    attendanceMode: oaEvent.attendanceMode || null,
    onlineAccessLink: oaEvent.onlineAccessLink || null,
    status: oaEvent.status || null,
    ageMin: parseInt(oaEvent.age?.min, 10) || null,
    ageMax: parseInt(oaEvent.age?.max, 10) || null,
    originAgendaTitle: originAgendaTitle, 
    originAgendaUid: oaEvent.originAgenda?.uid ? String(oaEvent.originAgenda.uid) : null,
    category: oaEvent['type-devenement'] ? String(oaEvent['type-devenement']) : (oaEvent.category || null),
    
    // Correction de la régression : pays
    countryFr: loc.countryCode || null,
    
    registration: oaEvent.registration || null,
    links: oaEvent.links || null,
    locationId: location.id,

    // Champs de contributeurs abandonnés (RGPD) : mis à null pour préserver ton schéma Prisma
    contributorEmail: null,
    contributorContactNumber: null,
    contributorContactName: null,
    contributorContactPosition: null,
    contributorOrganization: null,
  };

  return { event, location };
}

async function processBatch(prisma, batch) {
  const uniqueLocationsMap = new Map();
  batch.forEach(item => uniqueLocationsMap.set(item.location.id, item.location));
  const uniqueLocations = Array.from(uniqueLocationsMap.values());
  
  try {
    const locOps = uniqueLocations.map(loc => 
      prisma.location.upsert({ where: { id: loc.id }, update: loc, create: loc })
    );
    await prisma.$transaction(locOps);

    const evtOps = batch.map(item => 
      prisma.event.upsert({ where: { id: item.event.id }, update: item.event, create: item.event })
    );
    await prisma.$transaction(evtOps);
  } catch (err) { 
    console.error(`❌ Erreur Prisma lors de l'enregistrement du lot :`, err.message); 
  }
}

async function main() {
  console.log(`💾 ÉTAPE 3 : Téléchargement des événements depuis les agendas validés...`);
  const prisma = await getPrismaClient();

  const approvedAgendas = await prisma.openAgenda.findMany({
    where: { status: 'APPROVED' },
    select: { uid: true, title: true }
  });

  if (approvedAgendas.length === 0) {
    console.log("❌ Aucun agenda approuvé trouvé en base.");
    return await disconnect();
  }

  let totalProcessed = 0;

  for (let i = 0; i < approvedAgendas.length; i++) {
    const agenda = approvedAgendas[i];
    console.log(`⏳ [${i + 1}/${approvedAgendas.length}] Extraction : "${agenda.title}" (UID: ${agenda.uid})`);
    
    let hasMore = true;
    let afterCursor = [];

    while (hasMore) {
      const url = new URL(`https://api.openagenda.com/v2/agendas/${agenda.uid}/events`);
      url.searchParams.append('passed', '0');
      url.searchParams.append('size', BATCH_SIZE_EVENTS.toString());
      
      // Le paramètre qui débloque la longue description et les conditions
      url.searchParams.append('longDescriptionFormat', 'HTML');
      
      // Récupération complète des champs nécessaires
      ['location', 'timings', 'conditions', 'longDescription', 'keywords', 'registration', 'age', 'accessibility']
        .forEach(inc => url.searchParams.append('include[]', inc));

      if (afterCursor.length > 0) {
        afterCursor.forEach(c => url.searchParams.append('after[]', c));
      }

      try {
        const res = await fetch(url.toString(), { 
          headers: { 'key': OA_API_KEY, 'Content-Type': 'application/json' } 
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json();
        const events = data.events || [];
        
        if (events.length === 0) {
          hasMore = false;
          break;
        }

        const currentBatch = [];
        for (const rawEvent of events) {
          const mapped = mapOaToPrisma(rawEvent);
          if (mapped && !mapped.skip && mapped.event.id && mapped.event.titleFr) {
            currentBatch.push(mapped);
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

      } catch (err) {
        console.error(`  ⚠️ Erreur sur l'agenda ${agenda.uid}:`, err.message);
        hasMore = false;
      }
    }
  }

  console.log(`\n🎉 TERMINÉ ! ${totalProcessed} événements enregistrés en BDD.`);
  await disconnect();
}

main();