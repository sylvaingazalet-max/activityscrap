const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const AdmZip = require('adm-zip');
const { getPrismaClient, disconnect } = require('../lib/prismaClient');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const API_KEY = process.env.APIKEY_DATATOURISME;
const FEED_ID = "31a90591074ebf55f5db16bcc9a6af02";
const BATCH_SIZE = 100;

function parseDataTourismeObj(dtObj) {
  const getFr = (node) => Array.isArray(node?.fr) ? node.fr[0] : (node?.fr || null);
  
  const title = getFr(dtObj['rdfs:label']) || 'Sans nom';
  
  // Extraction de la description
  let desc = getFr(dtObj['rdfs:comment']);
  if (!desc && dtObj.hasDescription) {
    const descObj = Array.isArray(dtObj.hasDescription) ? dtObj.hasDescription[0] : dtObj.hasDescription;
    desc = getFr(descObj?.shortDescription) || getFr(descObj?.['dc:description']);
  }

  // Localisation
  const locAt = Array.isArray(dtObj.isLocatedAt) ? dtObj.isLocatedAt[0] : (dtObj.isLocatedAt || {});
  const addressObj = Array.isArray(locAt['schema:address']) ? locAt['schema:address'][0] : (locAt['schema:address'] || {});
  const geoObj = locAt['schema:geo'] || {};
  
  const street = Array.isArray(addressObj['schema:streetAddress']) ? addressObj['schema:streetAddress'][0] : addressObj['schema:streetAddress'];
  const city = addressObj['schema:addressLocality'] || getFr(addressObj.hasAddressCity?.['rdfs:label']);
  const lat = parseFloat(geoObj['schema:latitude']) || null;
  const lon = parseFloat(geoObj['schema:longitude']) || null;

  // Créateur légal (Source)
  let creatorObj = dtObj.hasBeenCreatedBy;
  if (Array.isArray(creatorObj)) creatorObj = creatorObj[0];
  const source = creatorObj?.['schema:legalName'] || 'DataTourisme';

  // Contact et Médias
  let contactObj = dtObj.hasContact;
  if (Array.isArray(contactObj)) contactObj = contactObj[0];
  
  let imageObj = dtObj.hasMainRepresentation;
  if (Array.isArray(imageObj)) imageObj = imageObj[0];
  const targetImage = Array.isArray(imageObj?.ebucoreHasAnnotation) ? imageObj.ebucoreHasAnnotation[0]?.hasTargetImage : null;
  const imageUrl = Array.isArray(targetImage) ? targetImage[0]?.['schema:url']?.[0] : targetImage?.['schema:url'];

  // Temporalité
  const periods = dtObj.takesPlaceAt || [];
  let startDate = null, endDate = null;
  if (periods.length > 0) {
    const firstPeriod = Array.isArray(periods) ? periods[0] : periods;
    const lastPeriod = Array.isArray(periods) ? periods[periods.length - 1] : periods;
    
    if (firstPeriod.startDate) startDate = new Date(Array.isArray(firstPeriod.startDate) ? firstPeriod.startDate[0] : firstPeriod.startDate);
    if (lastPeriod.endDate) endDate = new Date(Array.isArray(lastPeriod.endDate) ? lastPeriod.endDate[0] : lastPeriod.endDate);
  }

  const types = Array.isArray(dtObj['@type']) ? dtObj['@type'] : [dtObj['@type']];
  const isEvent = periods.length > 0 || types.includes('EntertainmentAndEvent') || types.includes('Festival');

  // Si c'est un ÉVÉNEMENT, on mappe pour ta table `Event`
  if (isEvent) {
    return {
      type: 'EVENT',
      data: {
        id: dtObj['@id'],
        titleFr: title,
        descriptionFr: desc,
        category: types.join(', '),
        image: imageUrl || null,
        firstDateBegin: isNaN(startDate?.getTime()) ? null : startDate,
        lastDateEnd: isNaN(endDate?.getTime()) ? null : endDate,
        originAgendaTitle: `DataTourisme - ${source}`, // On y stocke la source !
        canonicalUrl: Array.isArray(contactObj?.['foaf:homepage']) ? contactObj['foaf:homepage'][0] : contactObj?.['foaf:homepage'],
        // On laisse locationId à null pour l'instant (ou tu pourras lier ça plus tard)
      }
    };
  }

  // Si c'est un LIEU, on mappe pour ta table `PointOfInterest`
  return {
    type: 'POI',
    data: {
      id: dtObj['@id'],
      name: title,
      category: types.join(', '),
      description: desc,
      source: source,
      image: imageUrl || null,
      coordinates: (lat && lon) ? { lat, lon } : null,
      street: street || null,
      city: city || null,
      postcode: addressObj['schema:postalCode'] || null,
      phone: Array.isArray(contactObj?.['schema:telephone']) ? contactObj['schema:telephone'][0] : contactObj?.['schema:telephone'],
      website: Array.isArray(contactObj?.['foaf:homepage']) ? contactObj['foaf:homepage'][0] : contactObj?.['foaf:homepage'],
      summary: desc || null // Prêt pour l'affichage frontend
    }
  };
}

async function processBatches(prisma, eventsBatch, poiBatch) {
  try {
    if (eventsBatch.length > 0) {
      const eventOps = eventsBatch.map(ev => prisma.event.upsert({ where: { id: ev.id }, update: ev, create: ev }));
      await prisma.$transaction(eventOps);
    }
    
    if (poiBatch.length > 0) {
      const poiOps = poiBatch.map(poi => prisma.pointOfInterest.upsert({ where: { id: poi.id }, update: poi, create: poi }));
      await prisma.$transaction(poiOps);
    }
  } catch (err) {
    console.error(`\n❌ Erreur Prisma sur l'enregistrement :`, err.message);
  }
}

async function main() {
  console.log('🚀 Démarrage de la synchronisation intelligente DataTourisme...');
  const prisma = await getPrismaClient();
  const url = `https://diffuseur.datatourisme.fr/webservice/${FEED_ID}/${API_KEY}`;

  try {
    console.log('📡 Téléchargement de l\'archive ZIP...');
    const response = await fetch(url, { headers: { 'Accept-Encoding': 'gzip, deflate' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    console.log('📦 Décompression...');
    const buffer = Buffer.from(await response.arrayBuffer());
    const zip = new AdmZip(buffer);
    const dataEntries = zip.getEntries().filter(e => e.entryName.startsWith('objects/') && e.entryName.endsWith('.json'));
    
    console.log(`📂 ${dataEntries.length} objets trouvés. Tri (Événements vs Lieux) et insertion...`);

    let eventsBatch = [];
    let poiBatch = [];
    let processed = 0;

    for (const entry of dataEntries) {
      try {
        const dtObj = JSON.parse(zip.readAsText(entry));
        if (!dtObj['@id']) continue;
        
        const mapped = parseDataTourismeObj(dtObj);
        if (mapped.type === 'EVENT') eventsBatch.push(mapped.data);
        else poiBatch.push(mapped.data);

        if (eventsBatch.length + poiBatch.length >= BATCH_SIZE) {
          process.stdout.write(`  -> Enregistrement de ${processed + BATCH_SIZE} objets...\r`);
          await processBatches(prisma, eventsBatch, poiBatch);
          processed += BATCH_SIZE;
          eventsBatch = [];
          poiBatch = [];
        }
      } catch (e) { /* Ignorer fichier JSON invalide */ }
    }

    // Traiter le reliquat
    if (eventsBatch.length > 0 || poiBatch.length > 0) {
      await processBatches(prisma, eventsBatch, poiBatch);
      processed += (eventsBatch.length + poiBatch.length);
    }

    console.log(`\n🎉 TERMINÉ ! ${processed} objets intégrés proprement dans leurs tables respectives.`);
  } catch (error) {
    console.error('\n💥 Erreur:', error);
  } finally {
    await disconnect();
  }
}

main();