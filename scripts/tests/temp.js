/**
 * Vectorisation spécifique pour les événements "Leurres" (Honeypots).
 * * Ce script bypasse Gemini 2.5 Flash Lite et Chrono-node car les timings
 * et les mots-clés optimaux sont déjà codés en dur dans la base de données.
 * Il attaque directement Gemini Embedding 2.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getPrismaClient, disconnect } = require('../../lib/prismaClient');

// ============================================================================
// Configuration
// ============================================================================
const EMBEDDING_MODEL = 'gemini-embedding-2';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Error: GEMINI_API_KEY is not defined in your environment variables.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

// ============================================================================
// Main Execution Function
// ============================================================================
async function main() {
  console.log('🚀 Lancement de la vectorisation des leurres (Honeypots)...');
  const prisma = await getPrismaClient();

  try {
    // On cible uniquement nos deux leurres
    const honeypotEvents = await prisma.$queryRaw`
      SELECT 
        uid as "id", 
        title_fr as "titleFr", 
        description_fr as "descriptionFr"
      FROM events 
      WHERE uid IN ('honeypot_resto', 'honeypot_bar')
    `;

    if (honeypotEvents.length === 0) {
      console.log('⚠️ Aucun événement leurre trouvé. Avez-vous bien exécuté le script SQL ?');
      return;
    }

    const embedModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

    for (const event of honeypotEvents) {
      console.log(`\n⏳ Traitement du leurre : ${event.id}...`);

      // On concatène simplement le titre et la description qui contiennent nos mots-clés
      const textToEmbed = `${event.titleFr}. ${event.descriptionFr}`;
      console.log(`   [DEBUG] Texte vectorisé : "${textToEmbed}"`);

      try {
        const embedResult = await embedModel.embedContent({
          content: { parts: [{ text: textToEmbed }] },
          taskType: 'RETRIEVAL_DOCUMENT', 
          outputDimensionality: 768
        });

        const embeddingString = `[${embedResult.embedding.values.join(',')}]`;

        // Mise à jour de la base de données (uniquement la colonne embedding)
        await prisma.$executeRawUnsafe(
          'UPDATE events SET embedding = $1::vector WHERE uid = $2',
          embeddingString, 
          event.id
        );

        console.log(`✅ ${event.id} vectorisé et sauvegardé avec succès !`);
      } catch (err) {
        console.error(`❌ Échec de la vectorisation pour ${event.id}:`, err.message);
      }
    }

    console.log('\n🎉 Vectorisation des leurres terminée ! Votre filtre est opérationnel.');

  } catch (error) {
    console.error('💥 Une erreur inattendue est survenue :', error);
  } finally {
    await disconnect();
  }
}

main();