/**
 * Generate Embeddings for Events using Google Gemini API
 * Refactored for better maintainability and readability.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { getPrismaClient, disconnect } = require('../lib/prismaClient');

// ============================================================================
// Configuration
// ============================================================================
const BATCH_SIZE = 25;
const EMBEDDING_MODEL = 'gemini-embedding-2';
const PREPROCESSING_MODEL = 'gemini-2.5-flash-lite';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Error: GEMINI_API_KEY is not defined in your environment variables.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

// ============================================================================
// Schéma Strict JSON (Structured Outputs)
// ============================================================================
const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    is_lille_metropolis: {
      type: SchemaType.BOOLEAN,
      description: "TRUE si l'événement a lieu dans la Métropole Européenne de Lille (Lille, Roubaix, Tourcoing, Villeneuve d'Ascq, etc.). FALSE si c'est manifestement en dehors (ex: Valenciennes, Douai, Paris, Anzin, Belgique, etc.)."
    },
    condensed_text: { 
      type: SchemaType.STRING, 
      description: "Tags, ambiance, cadre, public cible et contexte sémantique enrichi pour l'indexation vectorielle."
    },
    is_recurring: { type: SchemaType.BOOLEAN },
    specific_dates: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      nullable: true,
      description: "Uniquement pour des dates isolées ou éparses. Format: YYYY-MM-DD."
    },
    recurrence_rule: {
      type: SchemaType.OBJECT,
      nullable: true,
      properties: {
        weekdays: { 
          type: SchemaType.ARRAY, 
          items: { type: SchemaType.INTEGER },
          description: "0=Dimanche, 1=Lundi, 2=Mardi, 3=Mercredi, 4=Jeudi, 5=Vendredi, 6=Samedi"
        },
        start_time: { type: SchemaType.STRING, nullable: true, description: "Format HH:MM" },
        end_time: { type: SchemaType.STRING, nullable: true, description: "Format HH:MM" }
      }
    }
  },
  required: ["is_lille_metropolis", "condensed_text", "is_recurring"]
};

// ============================================================================
// Utilitaires Généraux
// ============================================================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callAIWithRetry(actionFn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await actionFn();
    } catch (err) {
      const errMsg = err.message || '';
      const isRecoverableError = errMsg.includes('429') || errMsg.includes('503') ||
                                 errMsg.toLowerCase().includes('rate limit') || 
                                 errMsg.toLowerCase().includes('quota') ||
                                 errMsg.toLowerCase().includes('overloaded');
      
      if (isRecoverableError && attempt < retries) {
        console.warn(`⚠️ API Overloaded. Attempt ${attempt}/${retries}. Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
        delayMs *= 2; 
      } else {
        throw err;
      }
    }
  }
}

// ============================================================================
// Logique Métier : Temps & Dates
// ============================================================================
function hasValidExistingTimings(timings) {
  if (!timings || !Array.isArray(timings) || timings.length === 0) return false;
  
  for (const t of timings) {
    const durationHours = (new Date(t.end).getTime() - new Date(t.begin).getTime()) / (1000 * 60 * 60);
    if (durationHours > 48) { 
      return false;
    }
  }
  return true;
}

function expandRecurrence(globalStartDate, globalEndDate, weekdays, startTime, endTime) {
  const timings = [];
  const current = new Date(globalStartDate);
  const end = new Date(globalEndDate);

  const startH = startTime ? parseInt(startTime.split(':')[0], 10) : 0;
  const startM = startTime ? parseInt(startTime.split(':')[1], 10) : 0;
  const endH = endTime ? parseInt(endTime.split(':')[0], 10) : 23;
  const endM = endTime ? parseInt(endTime.split(':')[1], 10) : 59;

  let safeCounter = 0; 
  const MAX_DAYS = 730;

  while (current <= end && safeCounter < MAX_DAYS) {
    if (weekdays.includes(current.getDay())) {
      const beginDate = new Date(current);
      beginDate.setHours(startH, startM, 0, 0);
      
      const endDate = new Date(current);
      endDate.setHours(endH, endM, 59, 999);

      timings.push({
        begin: beginDate.toISOString(),
        end: endDate.toISOString()
      });
    }
    current.setDate(current.getDate() + 1);
    safeCounter++;
  }

  return timings;
}

function generateDateRangeFrString(timings) {
  if (!timings || !Array.isArray(timings) || timings.length === 0) return null;

  const formatPart = (isoString) => {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '??/??/???? ??h';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hour = String(d.getHours()).padStart(2, '0');
    return `${day}/${month}/${year} ${hour}h`;
  };

  const maxItems = Math.min(timings.length, 3);
  const parts = timings.slice(0, maxItems).map(t => {
    if (t.begin && t.end) return `du ${formatPart(t.begin)} au ${formatPart(t.end)}`;
    if (t.begin) return `le ${formatPart(t.begin)}`;
    return '';
  });

  let result = parts.join(', ');
  if (timings.length > 3) result += ' ...';

  return result;
}

function evaluateTimings(parsedData, event) {
  const rule = parsedData.recurrence_rule || {};
  const globalStart = event.firstDateBegin ? new Date(event.firstDateBegin) : new Date();
  const globalEnd = event.lastDateEnd ? new Date(event.lastDateEnd) : null;
  
  if (globalEnd && globalEnd < globalStart) {
    return { isTimingIncoherent: true, ignoreReasonStr: "Timing invalide : date de fin antérieure à la date de début.", timings: null };
  } 

  const effectiveEnd = globalEnd ? globalEnd : new Date(globalStart.getTime() + (180 * 24 * 60 * 60 * 1000));
  const durationTotalHours = (effectiveEnd.getTime() - globalStart.getTime()) / (1000 * 60 * 60);

  let calculatedTimings = [];

  if (parsedData.specific_dates && parsedData.specific_dates.length > 0) {
    const startH = rule.start_time ? parseInt(rule.start_time.split(':')[0], 10) : 0;
    const startM = rule.start_time ? parseInt(rule.start_time.split(':')[1], 10) : 0;
    const endH = rule.end_time ? parseInt(rule.end_time.split(':')[0], 10) : 23;
    const endM = rule.end_time ? parseInt(rule.end_time.split(':')[1], 10) : 59;

    for (const dStr of parsedData.specific_dates) {
      const dateObj = new Date(dStr);
      if (isNaN(dateObj.getTime())) continue; 
      
      const beginDate = new Date(dateObj);
      beginDate.setHours(startH, startM, 0, 0);
      
      const endDate = new Date(dateObj);
      endDate.setHours(endH, endM, 59, 999);
      
      calculatedTimings.push({ begin: beginDate.toISOString(), end: endDate.toISOString() });
    }
    return { isTimingIncoherent: false, ignoreReasonStr: null, timings: calculatedTimings, ruleApplied: 'Dates spécifiques' };
  } 
  
  if (parsedData.is_recurring && rule.weekdays && rule.weekdays.length > 0) {
    calculatedTimings = expandRecurrence(globalStart, effectiveEnd, rule.weekdays, rule.start_time, rule.end_time);
    if (calculatedTimings.length === 0) {
      return { isTimingIncoherent: true, ignoreReasonStr: "Timing invalide : la récurrence générée ne correspond à aucun jour dans la période globale.", timings: null };
    }
    return { isTimingIncoherent: false, ignoreReasonStr: null, timings: calculatedTimings, ruleApplied: `Récurrence sémantique (Jours: ${rule.weekdays})` };
  } 
  
  if (globalEnd && durationTotalHours <= 48) {
    calculatedTimings = [{ begin: globalStart.toISOString(), end: globalEnd.toISOString() }];
    return { isTimingIncoherent: false, ignoreReasonStr: null, timings: calculatedTimings, ruleApplied: 'Période courte (<= 48h) de Begin à End' };
  } 
  
  const endDate = new Date(globalStart.getTime() + (3 * 60 * 60 * 1000));
  calculatedTimings = [{ begin: globalStart.toISOString(), end: endDate.toISOString() }];
  return { isTimingIncoherent: false, ignoreReasonStr: null, timings: calculatedTimings, ruleApplied: 'Création d\'un créneau générique +3h par défaut' };
}

// ============================================================================
// Service d'Enregistrement BDD
// ============================================================================
async function ignoreEventInDb(prisma, eventId, reason) {
  await prisma.$executeRawUnsafe('UPDATE events SET is_ignored = true, ignore_reason = $1 WHERE uid = $2', reason, eventId);
}

async function updateEventInDb(prisma, eventId, embeddingString, calculatedTimings, generatedDateRangeFr) {
  if (calculatedTimings && calculatedTimings.length > 0) {
    if (generatedDateRangeFr) {
      await prisma.$executeRawUnsafe(
        'UPDATE events SET embedding = $1::vector, timings = $3::jsonb, daterange_fr = $4 WHERE uid = $2',
        embeddingString, eventId, JSON.stringify(calculatedTimings), generatedDateRangeFr
      );
    } else {
      await prisma.$executeRawUnsafe(
        'UPDATE events SET embedding = $1::vector, timings = $3::jsonb WHERE uid = $2',
        embeddingString, eventId, JSON.stringify(calculatedTimings)
      );
    }
  } else {
    if (generatedDateRangeFr) {
      await prisma.$executeRawUnsafe(
        'UPDATE events SET embedding = $1::vector, daterange_fr = $3 WHERE uid = $2',
        embeddingString, eventId, generatedDateRangeFr
      );
    } else {
      await prisma.$executeRawUnsafe(
        'UPDATE events SET embedding = $1::vector WHERE uid = $2',
        embeddingString, eventId
      );
    }
  }
}

// ============================================================================
// Processus Core (Un Événement)
// ============================================================================
async function processEvent(event, prisma, prepModel, embedModel) {
  const eventId = event.id;
  
  // Règle de passe-droit (VIP Pass)
  const isForced = event.ignoreReason === 'FORCED';
  
  // On identifie s'il s'agit d'un leurre
  const isHoneypot = String(eventId).startsWith('honeypot_');

  // Si c'est un honeypot, on force la validité des dates pour 
  // l'empêcher d'écraser la durée de 10 ans (qui dépasse la règle des 48h)
  const hasValidTimings = isHoneypot ? true : hasValidExistingTimings(event.timings);

  // --- ETAPE 1 & 2 : PREPARATION VIA LLM ---
  const eventDataForAI = {
    titre: event.titleFr,
    description: event.descriptionFr,
    daterange_texte: event.dateRangeFr,
    date_debut_globale: event.firstDateBegin,
    date_fin_globale: event.lastDateEnd,
    lieu_nom: event.locationName || "Inconnu",
    lieu_ville: event.locationCity || "Inconnue"
  };

  const temporalTaskPrompt = hasValidTimings 
    ? `TACHE 3 - Temporalité : IGNORE CETTE ÉTAPE. Les dates sont déjà parfaites. Renvoie simplement is_recurring=false et laisse les dates vides.`
    : `TACHE 3 - Temporalité fine (is_recurring, recurrence_rule, specific_dates) :
Analyse sémantiquement le titre, la description et daterange_texte pour comprendre la logique de l'événement.
- Si l'événement a lieu à des dates éparses précises, mets-les dans 'specific_dates' (YYYY-MM-DD) et is_recurring=false.
- Si l'événement se répète chaque semaine, mets is_recurring=true et remplis 'weekdays'.
- Extrait 'start_time' et 'end_time' (Format HH:MM) si présents.`;

  const systemPrompt = `Tu es un expert en extraction de données culturelles.

Voici les données de l'événement :
${JSON.stringify(eventDataForAI, null, 2)}

TACHE 1 - Filtre Géographique (CRUCIAL) :
Analyse le titre, la description, et les champs de lieu. Si l'événement ne se déroule PAS dans la Métropole Européenne de Lille (MEL) ou ses communes limitrophes immédiates, tu dois impérativement renvoyer "is_lille_metropolis": false. Attention, des villes comme Valenciennes, Anzin, Saultain, Douai ou Lens sont considérées comme HORS ZONE.

TACHE 2 - Enrichissement sémantique (condensed_text) :
Génère une suite de mots-clés liés à l'ambiance et au thème. SUPPRIME TOUTES LES DATES ET HEURES de ce champ.

${temporalTaskPrompt}`;

  const prepResult = await callAIWithRetry(() => prepModel.generateContent(systemPrompt));
  const parsedData = JSON.parse(prepResult.response.text());
  
  // --- ETAPE 3 : APPLICATION DU FILTRE GÉOGRAPHIQUE IA ---
  if (parsedData.is_lille_metropolis === false && !isHoneypot && !isForced) {
    console.log(` 🚫 [IGNORE] Event ${eventId} : Hors Métropole Lilloise (Détecté par IA).`);
    await ignoreEventInDb(prisma, eventId, 'Hors zone géographique cible (Détection IA)');
    return 'ignored';
  } else if (isHoneypot && parsedData.is_lille_metropolis === false) {
    console.log(`  [INFO] Event ${eventId} : Honeypot détecté, on conserve l'événement malgré sa localisation.`);
  } else if (isForced && parsedData.is_lille_metropolis === false) {
    console.log(`  [INFO] Event ${eventId} : 🎟️ Passe-droit FORCED utilisé, événement conservé malgré le filtre IA (hors zone).`);
  }

  if (!parsedData.condensed_text) throw new Error("LLM returned empty condensed text");

  // --- ETAPE 4 : CALCUL DES DATES & DÉTECTION D'INCOHÉRENCES ---
  let calculatedTimings = null;

  if (hasValidTimings) {
    console.log(`  [RÈGLE 1] Event ${eventId} : Timings actuels valides conservés.`);
  } else {
    const timingEval = evaluateTimings(parsedData, event);
    
    if (timingEval.isTimingIncoherent) {
      if (isForced) {
        console.log(`  [INFO] Event ${eventId} : 🎟️ Passe-droit FORCED utilisé, événement conservé malgré des dates incohérentes (${timingEval.ignoreReasonStr}).`);
        // Génération d'un créneau de secours pour que l'intégration ne plante pas
        const fallbackBegin = event.firstDateBegin ? new Date(event.firstDateBegin) : new Date();
        const fallbackEnd = event.lastDateEnd ? new Date(event.lastDateEnd) : new Date(fallbackBegin.getTime() + (3 * 60 * 60 * 1000));
        calculatedTimings = [{ begin: fallbackBegin.toISOString(), end: fallbackEnd.toISOString() }];
      } else {
        console.log(` 🚫 [IGNORE] Event ${eventId} : ${timingEval.ignoreReasonStr}`);
        await ignoreEventInDb(prisma, eventId, timingEval.ignoreReasonStr);
        return 'ignored';
      }
    } else {
      console.log(`  [RÈGLE LLM / FALLBACK] Event ${eventId} : ${timingEval.ruleApplied}.`);
      calculatedTimings = timingEval.timings;
    }
  }

  // --- ETAPE 5 : GÉNÉRATION DE L'EMBEDDING ---
  const embedResult = await callAIWithRetry(() => embedModel.embedContent({
    content: { parts: [{ text: parsedData.condensed_text }] },
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: 768
  }));

  const embeddingString = `[${embedResult.embedding.values.join(',')}]`;

  // --- ETAPE 6 : MISE A JOUR BASE DE DONNEES ---
  const finalTimings = (calculatedTimings && calculatedTimings.length > 0) ? calculatedTimings : event.timings;
  let generatedDateRangeFr = null;

  if ((!event.dateRangeFr || event.dateRangeFr.trim() === '') && finalTimings && finalTimings.length > 0) {
    generatedDateRangeFr = generateDateRangeFrString(finalTimings);
  }

  await updateEventInDb(prisma, eventId, embeddingString, calculatedTimings, generatedDateRangeFr);

  if (calculatedTimings && calculatedTimings.length > 0) {
    console.log(`  [INFO] Event ${eventId} : Timings mis à jour (Nbr: ${calculatedTimings.length}) et Vectorisé.`);
  } else {
    console.log(`  [INFO] Event ${eventId} : Vectorisé (Colonne timings d'origine conservée).`);
  }

  return 'success';
}

// ============================================================================
// Main Execution
// ============================================================================
async function main() {
  console.log('🚀 Starting smart embedding & dates generation process...');
  const prisma = await getPrismaClient();

  try {
    const missingEmbeddingsResult = await prisma.$queryRaw`
      SELECT COUNT(*)::int as count 
      FROM events 
      WHERE embedding IS NULL AND is_ignored = false
    `;
    
    const totalMissing = missingEmbeddingsResult[0]?.count || 0;
    console.log(`📊 Found ${totalMissing} events pending evaluation.`);

    if (totalMissing === 0) {
      console.log('✅ All valid events already have embeddings. Nothing to do!');
      return;
    }

    const totalBatches = Math.ceil(totalMissing / BATCH_SIZE);
    console.log(`📦 Will process in ${totalBatches} batches of ${BATCH_SIZE} events each.\n`);

    const prepModel = genAI.getGenerativeModel({ 
      model: PREPROCESSING_MODEL,
      generationConfig: { 
        responseMimeType: "application/json",
        responseSchema: responseSchema
      }
    });
    const embedModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      console.log(`\n🔄 Batch ${batchIdx + 1}/${totalBatches} - Fetching events...`);

      // ⚠️ UPDATE ICI : Ajout de e.ignore_reason as "ignoreReason" dans le SELECT
      const eventsBatch = await prisma.$queryRaw`
        SELECT 
          e.uid as "id", e.title_fr as "titleFr", e.description_fr as "descriptionFr",
          e.category as "category", e.daterange_fr as "dateRangeFr", e.firstdate_begin as "firstDateBegin",
          e.lastdate_end as "lastDateEnd", e.timings as "timings", e.ignore_reason as "ignoreReason",
          l.location_name as "locationName", l.location_district as "locationDistrict", 
          l.location_city as "locationCity", l.location_coordinates as "locationCoordinates"
        FROM events e
        LEFT JOIN locations l ON e.location_uid = l.location_uid
        WHERE e.embedding IS NULL AND e.is_ignored = false
        ORDER BY e.uid ASC
        LIMIT ${BATCH_SIZE}
      `;

      if (eventsBatch.length === 0) break;

      let stats = { processed: 0, ignored: 0, failed: 0 };

      for (const event of eventsBatch) {
        try {
          const result = await processEvent(event, prisma, prepModel, embedModel);
          if (result === 'success') stats.processed++;
          if (result === 'ignored') stats.ignored++;
        } catch (err) {
          stats.failed++;
          console.error(`❌ Failed to process event ${event.id}:`, err.message);
        }
      }

      console.log(`Batch ${batchIdx + 1}/${totalBatches} completed. Success: ${stats.processed}, Ignored: ${stats.ignored}, Failures: ${stats.failed}`);
      if (batchIdx < totalBatches - 1) await sleep(2000);
    }

    console.log('🎉 Smart embedding generation process completed successfully!');

  } catch (error) {
    console.error('💥 An error occurred in the script:', error);
  } finally {
    await disconnect();
  }
}

main();