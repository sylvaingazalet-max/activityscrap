/**
 * Découverte des agendas OpenAgenda via Opendatasoft.
 * Utilise la recherche spatiale (rayon autour de Lille) pour lister 
 * tous les agendas actifs dans la zone et compter leurs événements.
 */

const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const { Readable } = require('stream');
const readline = require('readline');

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

// ============================================================================
// Contournement TLS pour le développement local
// ============================================================================
const isLocalDev = process.env.NODE_ENV !== 'production';
const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' || isLocalDev;

if (allowInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠️ Mode développement local : Vérification TLS désactivée');
}

// ============================================================================
// Configuration
// ============================================================================
const BASE_URL = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/exports/jsonl';

// Coordonnées de Lille (Rayon 15km)
const LILLE_LON = 3.0572;
const LILLE_LAT = 50.6292;
const DISTANCE = '15km';

// ============================================================================
// Fonction Principale
// ============================================================================

async function discoverAgendas() {
  console.log(`🚀 Démarrage du radar à agendas (Rayon de ${DISTANCE} autour de Lille)...`);
  
  // Utilisation d'une Map pour agréger et compter les événements par agenda
  const agendasMap = new Map();

  try {
    const whereClause = `within_distance(location_coordinates, geom'POINT(${LILLE_LON} ${LILLE_LAT})', ${DISTANCE})`;
    const targetUrl = `${BASE_URL}?where=${encodeURIComponent(whereClause)}`;

    console.log(`📡 Connexion au flux Opendatasoft en cours...`);
    const response = await fetch(targetUrl);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erreur API Opendatasoft: ${response.status} ${response.statusText}\n🔍 Détail: ${errorText}`);
    }

    const stream = Readable.fromWeb(response.body);
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    let totalEventsAnalyzed = 0;
    let ignoredLines = 0;

    // Lecture du flux ligne par ligne
    for await (const line of rl) {
      if (!line.trim()) continue;

      let odsEvent;
      try {
        odsEvent = JSON.parse(line);
      } catch (parseError) {
        ignoredLines++;
        continue;
      }

      totalEventsAnalyzed++;

      // Extraction des infos de l'agenda d'origine
      const agendaUid = odsEvent.originagenda_uid || odsEvent.agenda_uid;
      const agendaTitle = odsEvent.originagenda_title || odsEvent.agenda_title || 'Agenda sans titre';

      // Si l'événement est rattaché à un agenda identifié
      if (agendaUid) {
        const uidStr = String(agendaUid);
        if (agendasMap.has(uidStr)) {
          // On incrémente le compteur
          agendasMap.get(uidStr).eventCount++;
        } else {
          // On crée l'entrée de l'agenda
          agendasMap.set(uidStr, {
            uid: uidStr,
            title: agendaTitle,
            eventCount: 1
          });
        }
      }
    }

    // Conversion de la Map en tableau et tri par nombre d'événements décroissant
    const sortedAgendasList = Array.from(agendasMap.values()).sort((a, b) => b.eventCount - a.eventCount);

    // Génération du fichier JSON
    const outputPath = path.resolve(process.cwd(), 'agendas_decouverts_lille.json');
    fs.writeFileSync(outputPath, JSON.stringify(sortedAgendasList, null, 2), 'utf-8');

    console.log(`\n🎉 Scan terminé avec succès !`);
    console.log(`📊 Bilan de l'analyse :`);
    console.log(`   - Événements bruts analysés : ${totalEventsAnalyzed}`);
    console.log(`   - Lignes ignorées (erreur parse) : ${ignoredLines}`);
    console.log(`   - 🎯 Nombre d'agendas uniques découverts : ${sortedAgendasList.length}`);
    console.log(`📂 Le fichier d'audit a été généré ici : ${outputPath}`);

  } catch (error) {
    console.error('💥 Erreur critique lors de la découverte:', error);
  }
}

// Lancement du script
discoverAgendas();