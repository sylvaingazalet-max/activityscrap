const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MONTHS_MAP = {
  'janvier': '01', 
  'février': '02', 'fevrier': '02', 
  'mars': '03', 
  'avril': '04',
  'mai': '05', 
  'juin': '06', 
  'juillet': '07', 
  'août': '08', 'aout': '08',
  'septembre': '09', 
  'octobre': '10', 
  'novembre': '11', 
  'décembre': '12', 'decembre': '12'
};

/**
 * Extrait toutes les dates uniques au format YYYY-MM-DD d'un événement
 */
function extractDates(event) {
  const uniqueDates = new Set();
  const isoField = event.Horaires_ISO;
  const textField = event.Horaires_d_taill_s___FR;

  // 1. Extraction en priorité depuis les horaires ISO
  if (isoField) {
    // CORRECTION ICI : Retrait des \b pour ne pas être bloqué par le "T" de la date ISO
    const isoRegex = /\d{4}-\d{2}-\d{2}/g;
    let match;
    while ((match = isoRegex.exec(isoField)) !== null) {
      uniqueDates.add(match[0]);
    }
  }

  // 2. Fallback : Si l'ISO est vide ou null, on lit la colonne de texte détaillé
  if (uniqueDates.size === 0 && textField) {
    const textRegex = /(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+(\d{4})/gi;
    let match;
    
    while ((match = textRegex.exec(textField)) !== null) {
      const day = match[1].padStart(2, '0');
      const monthStr = match[2].toLowerCase();
      const month = MONTHS_MAP[monthStr];
      const year = match[3];
      
      if (month) {
        uniqueDates.add(`${year}-${month}-${day}`);
      }
    }
  }

  return Array.from(uniqueDates).sort();
}

async function main() {
  console.log("🚀 Début du traitement des dates et du statut 'passé'...");
  
  // Calcul de la date du jour (YYYY-MM-DD sur le fuseau de Paris)
  // 'en-CA' force le format YYYY-MM-DD
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  console.log(`📅 Date de référence (Aujourd'hui) : ${todayStr}`);

  const allEvents = await prisma.events.findMany({
    select: {
      Identifiant: true,
      Horaires_ISO: true,
      Horaires_d_taill_s___FR: true,
      dates_valides: true,
      est_passe: true // On récupère le statut actuel
    }
  });

  console.log(`📦 ${allEvents.length} événements trouvés en base. Traitement en cours...`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const event of allEvents) {
    const datesCalculated = extractDates(event);
    
    // Détermination de la péremption de l'événement
    let isPastCalculated = false;
    
    if (datesCalculated.length > 0) {
      // Le tableau est trié chronologiquement, la dernière date est donc la date de fin
      const derniereDateEvent = datesCalculated[datesCalculated.length - 1];
      isPastCalculated = derniereDateEvent < todayStr;
    } else {
      // S'il n'y a aucune date récupérable, on le taggue comme passé pour le sortir des recos
      isPastCalculated = true;
    }

    // Vérifie si on a vraiment besoin de faire un UPDATE en base de données
    const alreadyUpToDate = 
      event.dates_valides.length === datesCalculated.length &&
      event.dates_valides.every((val, index) => val === datesCalculated[index]) &&
      event.est_passe === isPastCalculated;

    if (!alreadyUpToDate) {
      await prisma.events.update({
        where: { Identifiant: event.Identifiant },
        data: {
          dates_valides: datesCalculated,
          est_passe: isPastCalculated
        }
      });
      updatedCount++;
    } else {
      skippedCount++;
    }

    if ((updatedCount + skippedCount) % 100 === 0) {
      console.log(`⏳ Progression : ${updatedCount + skippedCount}/${allEvents.length} traités...`);
    }
  }

  console.log("--------------------------------------------------");
  console.log(`✅ Script terminé avec succès !`);
  console.log(`🔄 Événements mis à jour : ${updatedCount}`);
  console.log(`⏭️ Événements déjà à jour (ignorés) : ${skippedCount}`);
  console.log("--------------------------------------------------");
}

main()
  .catch((e) => {
    console.error("❌ Erreur critique :", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });