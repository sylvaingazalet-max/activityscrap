/**
 * Generate Embeddings for Events using Google Gemini API
 *
 * PIPELINE HYBRIDE :
 * 1. Gemini 2.5 Flash Lite : Analyse l'événement, génère un résumé sémantique 
 * pur (sans dates) et répare le champ 'timings' si celui-ci est vide ou malformé.
 * 2. Gemini Embedding 2 : Vectorise le résumé condensé.
 * 3. PostgreSQL : Sauvegarde le vecteur et met à jour le 'timings' si réparé.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getPrismaClient, disconnect } = require('../lib/prismaClient');

// ============================================================================
// Configuration
// ============================================================================
const BATCH_SIZE = 25; // Réduit un peu car 2 appels IA par événement
const EMBEDDING_MODEL = 'gemini-embedding-2';
const PREPROCESSING_MODEL = 'gemini-2.5-flash-lite';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Error: GEMINI_API_KEY is not defined in your environment variables.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fonction générique pour appeler l'API Gemini avec Retry (gère les 429)
 */
async function callAIWithRetry(actionFn, retries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await actionFn();
    } catch (err) {
      const errMsg = err.message || '';
      const isRateLimit = errMsg.includes('429') || 
                          errMsg.toLowerCase().includes('rate limit') || 
                          errMsg.toLowerCase().includes('quota');
      
      if (isRateLimit && attempt < retries) {
        console.warn(`⚠️ Rate limited (429) on attempt ${attempt}/${retries}. Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
        delayMs *= 2; 
      } else {
        throw err;
      }
    }
  }
}

/**
 * Main Execution Function
 */
async function main() {
  console.log('🚀 Starting smart embedding generation script...');
  const prisma = await getPrismaClient();

  try {
    const missingEmbeddingsResult = await prisma.$queryRaw`
      SELECT COUNT(*)::int as count 
      FROM events 
      WHERE embedding IS NULL
    `;
    
    const totalMissing = missingEmbeddingsResult[0]?.count || 0;
    console.log(`📊 Found ${totalMissing} events with missing embeddings.`);

    if (totalMissing === 0) {
      console.log('✅ All events already have embeddings. Nothing to do!');
      return;
    }

    const totalBatches = Math.ceil(totalMissing / BATCH_SIZE);
    console.log(`📦 Will process in ${totalBatches} batches of ${BATCH_SIZE} events each.\n`);

    const prepModel = genAI.getGenerativeModel({ 
      model: PREPROCESSING_MODEL,
      generationConfig: { responseMimeType: "application/json" }
    });
    const embedModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      console.log(`\n🔄 Batch ${batchIdx + 1}/${totalBatches} - Fetching events...`);

      // On récupère désormais les dates et timings pour le LLM
      const eventsBatch = await prisma.$queryRaw`
        SELECT 
          e.uid as "id",
          e.title_fr as "titleFr",
          e.description_fr as "descriptionFr",
          e.category as "category",
          e.daterange_fr as "dateRangeFr",
          e.firstdate_begin as "firstDateBegin",
          e.lastdate_end as "lastDateEnd",
          e.timings as "timings",
          l.location_name as "locationName",
          l.location_district as "locationDistrict",
          l.location_city as "locationCity"
        FROM events e
        LEFT JOIN locations l ON e.location_uid = l.location_uid
        WHERE e.embedding IS NULL
        ORDER BY e.uid ASC
        LIMIT ${BATCH_SIZE}
      `;

      if (eventsBatch.length === 0) break;

      let processedInBatch = 0;
      let failedInBatch = 0;

      for (const event of eventsBatch) {
        const eventId = event.id;
        
        // --- ETAPE 1 : PREPARATION VIA LLM ---
        const eventDataForAI = {
          titre: event.titleFr,
          description: event.descriptionFr,
          categorie: event.category,
          lieu: `${event.locationName || ''} ${event.locationDistrict || ''} ${event.locationCity || ''}`.trim(),
          daterange_texte: event.dateRangeFr,
          date_debut: event.firstDateBegin ? event.firstDateBegin.toISOString() : null,
          date_fin: event.lastDateEnd ? event.lastDateEnd.toISOString() : null,
          timings_actuels: event.timings ? JSON.stringify(event.timings) : null
        };

        const systemPrompt = `Tu es un expert en nettoyage de données événementielles. Année de référence : 2026.
Voici les données brutes d'un événement :
${JSON.stringify(eventDataForAI, null, 2)}

TACHE 1 - Condenser pour le moteur de recherche (embedding) :
Génère une phrase simple contenant uniquement les mots-clés sémantiques (thème, type d'activité, lieu, ambiance, public). 
RÈGLE ABSOLUE : SUPPRIME TOUTES LES DATES, JOURS, MOIS, HEURES OU ANNÉES de ce texte condensé.

TACHE 2 - Réparation du format horaire (timings) :
Regarde le champ "timings_actuels". 
S'il contient déjà un tableau JSON valide avec des dates, ou si les informations fournies ne permettent pas de déduire une date, renvoie STRICTEMENT "null" pour la clé "inferred_timings".
S'il est vide, "null", "[]" ou illogique, déduis les dates à partir des autres champs (daterange, description, date_debut) et renvoie un tableau au format [{"begin": "YYYY-MM-DDTHH:MM:SS+02:00", "end": "YYYY-MM-DDTHH:MM:SS+02:00"}].

Tu DOIS répondre STRICTEMENT avec ce JSON :
{
  "condensed_text": "Mots clés sémantiques sans aucune notion de temps...",
  "inferred_timings": [{"begin": "...", "end": "..."}] | null
}`;

        try {
          // Appel 1 : Flash Lite
          const prepResult = await callAIWithRetry(() => prepModel.generateContent(systemPrompt));
          const parsedData = JSON.parse(prepResult.response.text());
          
          if (!parsedData.condensed_text) throw new Error("LLM returned empty condensed text");

          // Appel 2 : Génération de l'embedding sur le texte purgé
          const embedResult = await callAIWithRetry(() => embedModel.embedContent({
            content: { parts: [{ text: parsedData.condensed_text }] },
            outputDimensionality: 768
          }));

          const embeddingString = `[${embedResult.embedding.values.join(',')}]`;

          // --- ETAPE 3 : MISE A JOUR BASE DE DONNEES ---
          if (parsedData.inferred_timings && Array.isArray(parsedData.inferred_timings) && parsedData.inferred_timings.length > 0) {
            // Le LLM a corrigé les dates : on met à jour les DEUX champs
            console.log(`  [INFO] Event ${eventId} : Timings réparés et Vectorisés.`);
            await prisma.$executeRawUnsafe(
              'UPDATE events SET embedding = $1::vector, timings = $3::jsonb WHERE uid = $2',
              embeddingString,
              eventId,
              JSON.stringify(parsedData.inferred_timings)
            );
          } else {
            // Les timings étaient bons ou non réparables : on ne met à jour QUE l'embedding
            console.log(`  [INFO] Event ${eventId} : Vectorisé (Timings inchangés).`);
            await prisma.$executeRawUnsafe(
              'UPDATE events SET embedding = $1::vector WHERE uid = $2',
              embeddingString,
              eventId
            );
          }

          processedInBatch++;
        } catch (err) {
          failedInBatch++;
          console.error(`❌ Failed to process event ${eventId}:`, err.message);
        }
      }

      console.log(`✅ Batch ${batchIdx + 1}/${totalBatches} completed. Success: ${processedInBatch}, Failures: ${failedInBatch}`);

      if (batchIdx < totalBatches - 1) {
        await sleep(2000);
      }
    }

    console.log('🎉 Smart embedding generation process completed!');

  } catch (error) {
    console.error('💥 An error occurred in the script:', error);
  } finally {
    await disconnect();
  }
}

main();