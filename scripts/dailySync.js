/**
 * Orchestrateur Global (Pipeline CRON)
 * 1. Nettoyage des événements passés dans la base
 * 2. Récupération des nouveaux événements (syncEvents.js)
 * 3. Calcul des vecteurs IA (generate-embeddings.js)
 */

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { spawn } = require('child_process');
const { getPrismaClient, disconnect } = require('../lib/prismaClient');

// ============================================================================
// ÉTAPE 1 : Nettoyage de la base de données
// ============================================================================
async function cleanPastEvents() {
  console.log('\n======================================================');
  console.log('🧹 ÉTAPE 1 : Nettoyage des événements passés');
  console.log('======================================================');
  
  const prisma = await getPrismaClient();
  try {
    const result = await prisma.events.deleteMany({
      where: {
        Horaires_ISO: {
          lt: new Date().toISOString()
        }
      }
    });
    console.log(`✅ Nettoyage terminé : ${result.count} événements obsolètes supprimés.`);
  } catch (error) {
    console.error(`❌ Erreur lors du nettoyage :`, error.message);
    throw error;
  } finally {
    await disconnect();
  }
}

// ============================================================================
// Utilitaire pour exécuter un script Node.js comme un sous-processus
// ============================================================================
function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    console.log('\n======================================================');
    console.log(`▶️  Lancement du script : ${scriptPath}`);
    console.log('======================================================\n');
    
    // stdio: 'inherit' permet de brancher les logs du sous-script directement dans notre terminal actuel
    const childProcess = spawn('node', [scriptPath], { stdio: 'inherit' });

    childProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Le script ${scriptPath} s'est arrêté avec une erreur (Code ${code})`));
      }
    });
  });
}

// ============================================================================
// Fonction Principale (L'Orchestrateur)
// ============================================================================
async function main() {
  console.log('🚀 DÉMARRAGE DU PIPELINE DE SYNCHRONISATION QUOTIDIEN');
  const startTime = Date.now();

  try {
    // 1. On efface ce qui est périmé
    await cleanPastEvents();

    // 2. On aspire les nouveautés OpenAgenda et Ticketmaster
    await runScript('scripts/syncEvents.js');
    await runScript('scripts/syncTicketmaster.js');

    // 3. On calcule les embeddings Gemini pour les nouveautés
    await runScript('scripts/generate-embeddings.js');

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    console.log('\n======================================================');
    console.log(`🎉 PIPELINE COMPLET TERMINÉ AVEC SUCCÈS (Temps: ${duration} min)`);
    console.log('======================================================\n');

  } catch (error) {
    console.log('\n======================================================');
    console.error('💥 ERREUR CRITIQUE DANS LE PIPELINE :');
    console.error(error.message);
    console.log('======================================================\n');
    process.exit(1); // Signale au CRON que la tâche a échoué
  }
}

main();