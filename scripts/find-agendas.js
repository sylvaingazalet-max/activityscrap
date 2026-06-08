const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

// Chargement des variables d'environnement
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const isLocalDev = process.env.NODE_ENV !== 'production';
const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' || isLocalDev;

if (allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Liste des mots-clés pour la recherche
const keywords = ['lille', 'roubaix', 'tourcoing', "villeneuve d'ascq", 'mel'];

async function fetchAgendas() {
  // Utilisation d'une Map pour dé-doublonner facilement grâce à l'UID
  const uniqueAgendas = new Map();

  for (const keyword of keywords) {
    console.log(`\n🔍 Recherche des agendas pour le mot-clé : "${keyword}"...`);
    
    // Logique de pagination et d'appel conservée
    let hasMore = true;
    let afterCursor = [];
    
    while (hasMore) {
      const url = new URL('https://api.openagenda.com/v2/agendas');
      url.searchParams.append('search', keyword);
      url.searchParams.append('size', '50');
      
      if (afterCursor && afterCursor.length > 0) {
        afterCursor.forEach(cursor => url.searchParams.append('after[]', cursor));
      }

      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'key': process.env.OPENAGENDA_API_KEY,
            'Content-Type': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(`Erreur HTTP: ${response.status} - ${response.statusText}`);
        }

        const data = await response.json();
        
        // Traitement des données : extraction et dé-doublonnage
        const agendas = data.agendas || [];
        agendas.forEach(agenda => {
          if (!uniqueAgendas.has(agenda.uid)) {
            uniqueAgendas.set(agenda.uid, {
              uid: agenda.uid,
              title: agenda.title,
              description: agenda.description,
              slug: agenda.slug
            });
          }
        });

        console.log(`  -> ${agendas.length} agendas récupérés sur cette page (Total uniques temporaire: ${uniqueAgendas.size})`);

        // Gestion de la pagination (selon ta structure)
        if (data.after && data.after.length > 0) {
          afterCursor = data.after;
        } else {
          hasMore = false;
        }
      } catch (error) {
        console.error(`❌ Erreur lors de la récupération pour le mot-clé "${keyword}":`, error);
        hasMore = false; // Interrompre la boucle while pour ce mot-clé en cas d'erreur
      }
    }
  }

  // Conversion de la Map en tableau pour l'export JSON
  const finalAgendasList = Array.from(uniqueAgendas.values());

  // Génération du fichier agendas_lille.json
  const outputPath = path.resolve(process.cwd(), 'agendas_lille.json');
  fs.writeFileSync(outputPath, JSON.stringify(finalAgendasList, null, 2), 'utf-8');

  console.log(`\n✅ Terminé ! ${finalAgendasList.length} agendas uniques trouvés.`);
  console.log(`📂 Le fichier a été généré avec succès ici : ${outputPath}`);
}

// Lancement du script
fetchAgendas();