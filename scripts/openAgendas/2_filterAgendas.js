const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getPrismaClient, disconnect } = require('../../lib/prismaClient');

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ 
  model: 'gemini-2.5-flash',
  generationConfig: { responseMimeType: "application/json" }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callAIWithRetry(actionFn, retries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await actionFn();
    } catch (err) {
      const errMsg = err.message || '';
      if ((errMsg.includes('503') || errMsg.includes('429')) && attempt < retries) {
        console.warn(`  ⚠️ Surcharge API. Tentative ${attempt}/${retries}. Pause...`);
        await sleep(delayMs);
        delayMs *= 2; 
      } else throw err; 
    }
  }
}

async function main() {
  console.log('🧠 ÉTAPE 2 : Filtrage LLM des agendas en attente...');
  const prisma = await getPrismaClient();

  const pendingAgendas = await prisma.openAgenda.findMany({
    where: { status: 'PENDING' },
    select: { uid: true, title: true, description: true }
  });

  if (pendingAgendas.length === 0) {
    console.log('✅ Aucun agenda en attente de tri.');
    await disconnect();
    return;
  }

  console.log(`🔎 Analyse de ${pendingAgendas.length} agendas...`);
  const BATCH_SIZE = 50;

  for (let i = 0; i < pendingAgendas.length; i += BATCH_SIZE) {
    const batch = pendingAgendas.slice(i, i + BATCH_SIZE);
    console.log(`  -> Lot ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} agendas)...`);

    const prompt = `
Tu es un curateur culturel strict pour la métropole lilloise. Ton but est de m'indiquer UNIQUEMENT les identifiants (uid) des agendas que je dois CONSERVER.
EXCLUSION ABSOLUE : Institutionnels non grand public (Pôle Emploi, réunions internes), kermesses d'école, agendas situés hors de la Métropole Lilloise.
INCLUSION : Événements grand public locaux, concerts, théâtres, bars.
LISTE : ${JSON.stringify(batch)}
SORS UNIQUEMENT UN TABLEAU JSON CONTENANT LES "uid" À CONSERVER. Exemple : ["123", "456"]
`;

    try {
      const response = await callAIWithRetry(() => aiModel.generateContent(prompt));
      const uidsToKeep = JSON.parse(response.response.text());
      const keptSet = new Set(Array.isArray(uidsToKeep) ? uidsToKeep.map(String) : []);

      // Mise à jour de la BDD pour ce lot
      for (const ag of batch) {
        const newStatus = keptSet.has(ag.uid) ? 'APPROVED' : 'REJECTED';
        await prisma.openAgenda.update({
          where: { uid: ag.uid },
          data: { status: newStatus }
        });
      }
    } catch (err) {
      console.error(`❌ Erreur LLM sur ce lot :`, err.message);
    }
    
    await sleep(2000); // Respect du rate limit
  }

  console.log('🎉 Tri terminé et sauvegardé en BDD !');
  await disconnect();
}

main();