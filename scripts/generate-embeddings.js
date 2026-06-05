/**
 * Generate Embeddings for Events using Google Gemini API (gemini-embedding-2)
 * and update the database via Prisma and PostgreSQL vector extensions.
 *
 * This script processes events in batches of 50 to avoid memory overloading
 * and to respect API rate limits. It implements sequential processing within 
 * batches, exponential backoff retries, and sleep delays between batches.
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
const EMBEDDING_MODEL = 'gemini-embedding-2'; // Explicitly set as required

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
 * Format the text context from event fields to generate a high-quality embedding
 * Fields used: Title, Subtitle/Teaser (Chapô - FR), Long Description (Description longue - FR), Event Type, and Neighborhood (Quartier)
 */
function buildTextContext(event) {
  const parts = [];

  if (event.Titre___FR) parts.push(`Titre: ${event.Titre___FR.trim()}`);
  if (event.Chap____FR) parts.push(`Résumé: ${event.Chap____FR.trim()}`);
  if (event.Description_longue___FR) parts.push(`Description: ${event.Description_longue___FR.trim()}`);
  if (event.Type_d__v_nement) parts.push(`Type d'événement: ${event.Type_d__v_nement.trim()}`);
  if (event.Lieu__Quartier) parts.push(`Quartier: ${event.Lieu__Quartier.trim()}`);

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

      // Fetch the next batch of events where embedding IS NULL
      const eventsBatch = await prisma.$queryRaw`
        SELECT 
          "Identifiant",
          "Titre - FR" as "Titre___FR",
          "Chapô - FR" as "Chap____FR",
          "Description longue - FR" as "Description_longue___FR",
          "Type d'événement" as "Type_d__v_nement",
          "Lieu: Quartier" as "Lieu__Quartier"
        FROM events
        WHERE embedding IS NULL
        ORDER BY "Identifiant" ASC
        LIMIT ${BATCH_SIZE}
      `;

      if (eventsBatch.length === 0) {
        console.log('ℹ️ No more events to process. Finishing.');
        break;
      }

      console.log(`🤖 Generating embeddings for ${eventsBatch.length} events sequentially to avoid 429 limit...`);

      let processedInBatch = 0;
      let failedInBatch = 0;

      for (const event of eventsBatch) {
        const eventIdString = event.Identifiant.toString(); // BigInt safe string conversion
        const textToEmbed = buildTextContext(event);

        if (!textToEmbed.trim()) {
          console.log(`⚠️ Event ${eventIdString} has no textual content to generate embedding. Skipping.`);
          continue;
        }

        try {
          // Generate embedding with the correct dimension of 768
          const embedding = await embedWithRetry(model, textToEmbed);

          if (!embedding || embedding.length === 0) {
            throw new Error('Empty embedding received from Google Gemini API');
          }

          // Convert to vector string format: '[0.1, -0.2, 0.3...]'
          const embeddingString = `[${embedding.join(',')}]`;

          // Update database using raw SQL with stringified ID casted to bigint for absolute safety
          await prisma.$executeRawUnsafe(
            'UPDATE events SET embedding = $1::vector WHERE "Identifiant" = $2::bigint',
            embeddingString,
            eventIdString
          );

          processedInBatch++;
        } catch (err) {
          failedInBatch++;
          console.error(`❌ Failed to process event ${eventIdString}:`, err.message);
        }
      }

      console.log(`✅ Batch ${batchIdx + 1}/${totalBatches} completed. Success: ${processedInBatch}, Failures: ${failedInBatch}`);

      // Wait 2000ms (2 seconds) between each batch as strictly requested
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
