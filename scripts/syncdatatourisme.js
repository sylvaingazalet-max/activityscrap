/**
 * Synchronisation DataTourisme
 * * NOUVELLE STRATÉGIE DE PARSING :
 * - Descriptions : rdfs:comment en priorité, fallback sur dc:description (le LLM résumera plus tard)
 * - URL : Extraction dans hasContact / hasBookingContact en excluant apidae-tourisme.com
 * - Prix/Conditions : Extraction dans offers[].schema:priceSpecification (texte ou chiffres)
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const AdmZip = require('adm-zip');
const { getPrismaClient, disconnect } = require('../lib/prismaClient');

// Contournement des erreurs de certificats
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const API_KEY = process.env.APIKEY_DATATOURISME;
const FEED_ID = "31a90591074ebf55f5db16bcc9a6af02";
const BATCH_SIZE = 100;

/**
 * Utilitaire ultra-robuste pour extraire le texte français d'un nœud DataTourisme
 */
function getFr(node) {
  if (!node) return null;
  if (typeof node === 'string') return node.trim();
  if (Array.isArray(node)) return getFr(node[0]); // Si tableau, on prend le premier
  if (node.fr) return Array.isArray(node.fr) ? node.fr[0].trim() : node.fr.trim();
  return null;
}

/**
 * Fonction Spéléologue 1 : Extraction d'une URL propre
 */
function extractCanonicalUrl(dtObj) {
  const urls = new Set();
  const searchInNode = (node) => {
    if (!node) return;
    const items = Array.isArray(node) ? node : [node];
    for (const item of items) {
      let homepage = item['foaf:homepage'];
      if (homepage) {
        if (Array.isArray(homepage)) homepage.forEach(h => urls.add(h));
        else urls.add(homepage);
      }
    }
  };

  searchInNode(dtObj.hasContact);
  searchInNode(dtObj.hasBookingContact);
  searchInNode(dtObj.hasBeenPublishedBy);
  
  const allUrls = Array.from(urls);
  const validUrls = allUrls.filter(u => !u.includes('apidae-tourisme.com'));
  
  return validUrls.length > 0 ? validUrls[0] : dtObj['@id'];
}

/**
 * Fonction Spéléologue 2 : Extraction des prix et conditions
 */
function extractConditions(dtObj) {
  if (!dtObj.offers) return null;
  const offers = Array.isArray(dtObj.offers) ? dtObj.offers : [dtObj.offers];
  const conditionsSet = new Set();

  for (const offer of offers) {
    if (!offer['schema:priceSpecification']) continue;
    const specs = Array.isArray(offer['schema:priceSpecification']) ? offer['schema:priceSpecification'] : [offer['schema:priceSpecification']];
    
    for (const spec of specs) {
      // 1. On cherche du texte pur (Ex: "Gratuit - Sur réservation")
      const text = getFr(spec.additionalInformation) || getFr(spec.name);
      if (text) {
        conditionsSet.add(text);
        continue; // Si on a du texte riche, on le préfère aux chiffres bruts
      }

      // 2. Sinon on cherche les valeurs numériques
      const min = Array.isArray(spec['schema:minPrice']) ? spec['schema:minPrice'][0] : spec['schema:minPrice'];
      const max = Array.isArray(spec['schema:maxPrice']) ? spec['schema:maxPrice'][0] : spec['schema:maxPrice'];
      const price = Array.isArray(spec['schema:price']) ? spec['schema:price'][0] : spec['schema:price'];
      const currency = spec['schema:priceCurrency'] || '€';
      
      if (min !== undefined && max !== undefined && min !== max) {
        conditionsSet.add(`De ${min} à ${max} ${currency}`);
      } else if (min !== undefined) {
        conditionsSet.add(`À partir de ${min} ${currency}`);
      } else if (price !== undefined) {
        conditionsSet.add(`${price} ${currency}`);
      }
    }
  }
  
  const results = Array.from(conditionsSet);
  return results.length > 0 ? results.join(' / ') : null;
}

/**
 * Fonction principale de parsing (Mapping "La Bible")
 */
function parseDataTourismeObj(dtObj) {
  const title = getFr(dtObj['rdfs:label']) || 'Sans nom';
  
  // --- 1. DESCRIPTION DUEL (Rdfs vs LongDesc) ---
  let desc = getFr(dtObj['rdfs:comment']);
  if (!desc && dtObj.hasDescription) {
    const descArray = Array.isArray(dtObj.hasDescription) ? dtObj.hasDescription : [dtObj.hasDescription];
    for (const d of descArray) {
      const textFallback = getFr(d['dc:description']) || getFr(d['shortDescription']);
      if (textFallback) {
        desc = textFallback;
        break;
      }
    }
  }

  // --- 2. GÉOLOCALISATION ET ADRESSE ---
  const locAt = Array.isArray(dtObj.isLocatedAt) ? dtObj.isLocatedAt[0] : (dtObj.isLocatedAt || {});
  const addressObj = Array.isArray(locAt['schema:address']) ? locAt['schema:address'][0] : (locAt['schema:address'] || {});
  const geoObj = locAt['schema:geo'] || {};
  
  const street = Array.isArray(addressObj['schema:streetAddress']) ? addressObj['schema:streetAddress'][0] : addressObj['schema:streetAddress'];
  let city = getFr(addressObj.hasAddressCity?.['rdfs:label']) || addressObj['schema:addressLocality'];
  if (Array.isArray(city)) city = city[0];
  const postcode = addressObj['schema:postalCode'] || null;

  const lat = parseFloat(geoObj['schema:latitude']) || null;
  const lon = parseFloat(geoObj['schema:longitude']) || null;

  // --- 3. SOURCE ET AUTEURS ---
  let creatorObj = dtObj.hasBeenCreatedBy;
  if (Array.isArray(creatorObj)) creatorObj = creatorObj[0];
  const source = creatorObj?.['schema:legalName'] || 'DataTourisme';

  // --- 4. TÉLÉPHONE ET MÉDIAS ---
  let contactObj = dtObj.hasContact;
  if (Array.isArray(contactObj)) contactObj = contactObj[0];
  const phone = Array.isArray(contactObj?.['schema:telephone']) ? contactObj['schema:telephone'][0] : contactObj?.['schema:telephone'];
  
  let imageObj = dtObj.hasMainRepresentation;
  if (Array.isArray(imageObj)) imageObj = imageObj[0];
  const targetImage = Array.isArray(imageObj?.ebucoreHasAnnotation) ? imageObj.ebucoreHasAnnotation[0]?.hasTargetImage : null;
  const imageUrl = Array.isArray(targetImage) ? targetImage[0]?.['schema:url']?.[0] : targetImage?.['schema:url'];

  // --- 5. TEMPORALITÉ ---
  const periods = dtObj.takesPlaceAt || [];
  let startDate = null, endDate = null;
  if (periods.length > 0) {
    const firstPeriod = Array.isArray(periods) ? periods[0] : periods;
    const lastPeriod = Array.isArray(periods) ? periods[periods.length - 1] : periods;
    
    if (firstPeriod.startDate) startDate = new Date(Array.isArray(firstPeriod.startDate) ? firstPeriod.startDate[0] : firstPeriod.startDate);
    if (lastPeriod.endDate) endDate = new Date(Array.isArray(lastPeriod.endDate) ? lastPeriod.endDate[0] : lastPeriod.endDate);
  }

  // Détermination du type final
  const types = Array.isArray(dtObj['@type']) ? dtObj['@type'] : [dtObj['@type']];
  const isEvent = periods.length > 0 || types.includes('EntertainmentAndEvent') || types.includes('Festival');

  // --- MAPPING POUR EVENT ---
  if (isEvent) {
    return {
      type: 'EVENT',
      data: {
        id: dtObj['@id'],
        titleFr: title,
        descriptionFr: desc,
        conditionsFr: extractConditions(dtObj), // Nouvel extracteur
        category: types.join(', '),
        image: imageUrl || null,
        firstDateBegin: isNaN(startDate?.getTime()) ? null : startDate,
        lastDateEnd: isNaN(endDate?.getTime()) ? null : endDate,
        originAgendaTitle: `DataTourisme - ${source}`,
        canonicalUrl: extractCanonicalUrl(dtObj) // Nouvel extracteur
      }
    };
  }

  // --- MAPPING POUR POI ---
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
      postcode: postcode,
      phone: phone || null,
      website: extractCanonicalUrl(dtObj),
      summary: desc || null 
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
  console.log('🚀 Démarrage de la synchronisation intelligente DataTourisme V2...');
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

    console.log(`\n🎉 TERMINÉ ! ${processed} objets intégrés proprement dans leurs tables respectives avec des données ultra-riches.`);
  } catch (error) {
    console.error('\n💥 Erreur:', error);
  } finally {
    await disconnect();
  }
}

main();