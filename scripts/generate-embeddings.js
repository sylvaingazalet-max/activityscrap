/**
 * Generate Embeddings for Events using Google Gemini API
 * and update the database via Prisma and PostgreSQL vector extensions.
 *
 * This script processes events in batches to avoid memory overloading
 * and to respect API rate limits.
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
const BATCH_SIZE = 50;
const EMBEDDING_MODEL = 'gemini-embedding-2'; // Modèle Gemini recommandé pour les embeddings

// Check for API key
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Error: GEMINI_API_KEY is not defined in your environment variables.');
  process.exit(1);
}

// Initialize Gemini SDK
const genAI = new GoogleGenerativeAI(apiKey);

/**
 * Simple utility sleep function
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format the text context from event and location fields to generate a high-quality embedding
 */
function buildTextContext(event) {
  const parts = [];

  if (event.titleFr) parts.push(`Titre: ${event.titleFr.trim()}`);
  
  // Utilisation de la description courte en priorité, sinon la longue
  const description = event.descriptionFr || event.longDescriptionFr;
  if (description) parts.push(`Description: ${description.trim()}`);
  
  if (event.category) parts.push(`Catégorie: ${event.category.trim()}`);

  // Construction des infos du lieu
  const locationParts = [];
  if (event.locationName) locationParts.push(event.locationName.trim());
  if (event.locationDistrict) locationParts.push(`Quartier ${event.locationDistrict.trim()}`);
  if (event.locationCity) locationParts.push(event.locationCity.trim());
  
  if (locationParts.length > 0) {
    parts.push(`Lieu: ${locationParts.join(', ')}`);
  }

  return parts.join('\n\n');
}

/**
 * Generate embedding with automatic retry and exponential backoff on 429
 */
async function embedWithRetry(model, textToEmbed, retries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.embedContent({
        content: { parts: [{ text: textToEmbed }] },
        outputDimensionality: 768
      });
      return result.embedding.values;
    } catch (err) {
      const errMsg = err.message || '';
      const isRateLimit = errMsg.includes('429') || 
                          errMsg.toLowerCase().includes('rate limit') || 
                          errMsg.toLowerCase().includes('too many requests') || 
                          errMsg.toLowerCase().includes('quota');
      
      if (isRateLimit && attempt < retries) {
        console.warn(`⚠️ Rate limited (429) on attempt ${attempt}/${retries}. Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
        delayMs *= 2; // exponential backoff
      } else {
        throw err; // non-rate limit or last attempt error, propagate
      }
    }
  }
}

/**
 * Main Execution Function
 */
async function main() {
  console.log('🚀 Starting embedding generation script with robust rate limiting...');
  const prisma = await getPrismaClient();

  try {
    // 1. Fetch count of events without an embedding
    console.log('🔍 Checking database for events needing embedding...');
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

    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

    // Process batch by batch
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      console.log(`🔄 Batch ${batchIdx + 1}/${totalBatches} - Fetching ${BATCH_SIZE} events...`);

      // Jointure SQL pour récupérer les infos de l'événement ET de son lieu
      const eventsBatch = await prisma.$queryRaw`
        SELECT 
          e.uid as "id",
          e.title_fr as "titleFr",
          e.description_fr as "descriptionFr",
          e.longdescription_fr as "longDescriptionFr",
          e.category as "category",
          l.location_name as "locationName",
          l.location_district as "locationDistrict",
          l.location_city as "locationCity"
        FROM events e
        LEFT JOIN locations l ON e.location_uid = l.location_uid
        WHERE e.embedding IS NULL
        ORDER BY e.uid ASC
        LIMIT ${BATCH_SIZE}
      `;

      if (eventsBatch.length === 0) {
        console.log('ℹ️ No more events to process. Finishing.');
        break;
      }

      console.log(`🤖 Generating embeddings sequentially to avoid limits...`);

      let processedInBatch = 0;
      let failedInBatch = 0;

      for (const event of eventsBatch) {
        const eventId = event.id; // Déjà en string !
        const textToEmbed = buildTextContext(event);

        if (!textToEmbed.trim()) {
          console.log(`⚠️ Event ${eventId} has no textual content. Skipping.`);
          continue;
        }

        try {
          const embedding = await embedWithRetry(model, textToEmbed);

          if (!embedding || embedding.length === 0) {
            throw new Error('Empty embedding received from Google Gemini API');
          }

          const embeddingString = `[${embedding.join(',')}]`;

          // UPDATE sécurisé avec l'ID en String
          await prisma.$executeRawUnsafe(
            'UPDATE events SET embedding = $1::vector WHERE uid = $2',
            embeddingString,
            eventId
          );

          processedInBatch++;
        } catch (err) {
          failedInBatch++;
          console.error(`❌ Failed to process event ${eventId}:`, err.message);
        }
      }

      console.log(`✅ Batch ${batchIdx + 1}/${totalBatches} completed. Success: ${processedInBatch}, Failures: ${failedInBatch}`);

      // Wait 2000ms between batches
      if (batchIdx < totalBatches - 1) {
        console.log(`💤 Sleeping for 2000ms to stay under Gemini RPM limits...`);
        await sleep(2000);
      }
    }

    console.log('🎉 Embedding generation process completed!');

  } catch (error) {
    console.error('💥 An error occurred in the script:', error);
  } finally {
    await disconnect();
  }
}

main();