const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

// ============================================================================
// Contournement TLS pour le développement local
// ============================================================================
const isLocalDev = process.env.NODE_ENV !== 'production';
const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' || isLocalDev;

if (allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

async function main() {
  const API_KEY = process.env.OPENAGENDA_API_KEY;
  if (!API_KEY) {
    console.error("Clé OPENAGENDA_API_KEY introuvable dans le .env");
    return;
  }

  const AGENDA_SLUG = 'ville-de-lille';

  try {
    // 1. Récupérer l'UID de l'agenda de Lille
    console.log(`🔍 1. Recherche de l'UID pour "${AGENDA_SLUG}"...`);
    const agendaRes = await fetch(`https://api.openagenda.com/v2/agendas?slug=${AGENDA_SLUG}`, {
      headers: { 'key': API_KEY }
    });
    const agendaData = await agendaRes.json();
    const agendaUid = agendaData.agendas[0].uid;
    console.log(`✅ UID trouvé : ${agendaUid}\n`);

    // 2. Récupérer 2 événements avec TOUTES les infos
    const url = new URL(`https://api.openagenda.com/v2/agendas/${agendaUid}/events`);
    url.searchParams.append('size', '20'); // On limite à 2 pour ne pas inonder le terminal
    
    // Ajout des champs détaillés
    const includes = [
      'location', 
      'timings', 
      'conditions', 
      'longDescription', 
      'keywords', 
      'registration', 
      'age',
      'accessibility'
    ];
    includes.forEach(inc => url.searchParams.append('include[]', inc));

    console.log('🔗 2. URL appelée :', url.toString());
    console.log('⏳ Récupération des données lourdes en cours...\n');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'key': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
        throw new Error(`Erreur ${response.status} : ${await response.text()}`);
    }

    const data = await response.json();
    
    // Affichage brut dans le terminal
    console.log(JSON.stringify(data.events, null, 2));
    
  } catch (error) {
    console.error('💥 Erreur lors du test :', error);
  }
}

main();