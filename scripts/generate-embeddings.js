/**
 * Generate Embeddings for Events using Google Gemini API & Chrono-node
 *
 * PIPELINE HYBRIDE SÉCURISÉ :
 * 1. Gemini 2.5 Flash Lite : Analyse sémantique (enrichissement) + Extraction temporelle brute (Structured Output).
 * 2. Tri par priorités (6 Règles) : Utilisation des champs structurés (Begin/End) avant de basculer sur Chrono-node.
 * 3. Gemini Embedding 2 : Vectorise les mots-clés et l'ambiance enrichis.
 * 4. PostgreSQL : Sauvegarde le vecteur, met à jour 'timings' et génère un 'daterange_fr' de secours si manquant.
 */

const path = require('path');
const dotenv = require('dotenv');
const chrono = require('chrono-node');

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { getPrismaClient, disconnect } = require('../lib/prismaClient');

// ============================================================================
// Configuration
// ============================================================================
const BATCH_SIZE = 25;
const EMBEDDING_MODEL = 'gemini-embedding-2';
const PREPROCESSING_MODEL = 'gemini-2.5-flash-lite';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Error: GEMINI_API_KEY is not defined in your environment variables.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

// ============================================================================
// Schéma Strict JSON (Structured Outputs)
// ============================================================================
const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    condensed_text: { 
      type: SchemaType.STRING, 
      description: "Tags, ambiance, cadre, public cible et contexte sémantique enrichi pour l'indexation vectorielle."
    },
    extracted_time_text: { type: SchemaType.STRING, nullable: true },
    is_recurring: { type: SchemaType.BOOLEAN },
    specific_dates: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      nullable: true,
      description: "Uniquement pour des dates isolées ou éparses (ex: '30 mai et 20 juin'). Format des éléments: YYYY-MM-DD. Laisse vide si récurrent."
    },
    recurrence_rule: {
      type: SchemaType.OBJECT,
      nullable: true,
      properties: {
        weekdays: { 
          type: SchemaType.ARRAY, 
          items: { type: SchemaType.INTEGER },
          description: "0=Dimanche, 1=Lundi, 2=Mardi, 3=Mercredi, 4=Jeudi, 5=Vendredi, 6=Samedi"
        },
        start_time: { type: SchemaType.STRING, nullable: true, description: "Format HH:MM" },
        end_time: { type: SchemaType.STRING, nullable: true, description: "Format HH:MM" }
      }
    }
  },
  required: ["condensed_text", "is_recurring"]
};

// ============================================================================
// Utilitaires
// ============================================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fonction générique pour appeler l'API Gemini avec Retry (gère les 429 et 503)
 */
async function callAIWithRetry(actionFn, retries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await actionFn();
    } catch (err) {
      const errMsg = err.message || '';
      const isRecoverableError = errMsg.includes('429') || 
                                 errMsg.includes('503') ||
                                 errMsg.toLowerCase().includes('rate limit') || 
                                 errMsg.toLowerCase().includes('quota') ||
                                 errMsg.toLowerCase().includes('overloaded');
      
      if (isRecoverableError && attempt < retries) {
        console.warn(`⚠️ API Overloaded (${errMsg.substring(0, 30)}...). Attempt ${attempt}/${retries}. Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
        delayMs *= 2; 
      } else {
        throw err;
      }
    }
  }
}

/**
 * Génère un tableau de timings pour les événements récurrents
 */
function expandRecurrence(globalStartDate, globalEndDate, weekdays, startTime, endTime) {
  const timings = [];
  const current = new Date(globalStartDate);
  const end = new Date(globalEndDate);

  const startH = startTime ? parseInt(startTime.split(':')[0], 10) : 0;
  const startM = startTime ? parseInt(startTime.split(':')[1], 10) : 0;
  
  const endH = endTime ? parseInt(endTime.split(':')[0], 10) : 23;
  const endM = endTime ? parseInt(endTime.split(':')[1], 10) : 59;

  let safeCounter = 0; 
  const MAX_DAYS = 730;

  while (current <= end && safeCounter < MAX_DAYS) {
    if (weekdays.includes(current.getDay())) {
      const beginDate = new Date(current);
      beginDate.setHours(startH, startM, 0, 0);
      
      const endDate = new Date(current);
      endDate.setHours(endH, endM, 59, 999);

      timings.push({
        begin: beginDate.toISOString(),
        end: endDate.toISOString()
      });
    }
    current.setDate(current.getDate() + 1);
    safeCounter++;
  }

  return timings;
}

/**
 * Génère un daterange_fr formaté propre (ex: "du 14/05/2024 10h au 14/05/2024 12h")
 * Limite à 3 éléments max pour ne pas polluer.
 */
function generateDateRangeFrString(timings) {
  if (!timings || !Array.isArray(timings) || timings.length === 0) return null;

  const formatPart = (isoString) => {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '??/??/???? ??h';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hour = String(d.getHours()).padStart(2, '0');
    return `${day}/${month}/${year} ${hour}h`;
  };

  const maxItems = Math.min(timings.length, 3);
  const parts = [];

  for (let i = 0; i < maxItems; i++) {
    const t = timings[i];
    if (t.begin && t.end) {
      parts.push(`du ${formatPart(t.begin)} au ${formatPart(t.end)}`);
    } else if (t.begin) {
      parts.push(`le ${formatPart(t.begin)}`);
    }
  }

  let result = parts.join(', ');
  if (timings.length > 3) {
    result += ' ...';
  }

  return result;
}

// ============================================================================
// Main Execution Function
// ============================================================================
async function main() {
  console.log('🚀 Starting smart embedding & dates generation process...');
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
      generationConfig: { 
        responseMimeType: "application/json",
        responseSchema: responseSchema
      }
    });
    const embedModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      console.log(`\n🔄 Batch ${batchIdx + 1}/${totalBatches} - Fetching events...`);

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
        
        // ============================================================================
        // --- ETAPE 1 : PREPARATION VIA LLM (Sémantique) ---
        // ============================================================================
        const eventDataForAI = {
          titre: event.titleFr,
          description: event.descriptionFr,
          categorie: event.category,
          lieu: `${event.locationName || ''} ${event.locationDistrict || ''} ${event.locationCity || ''}`.trim(),
          daterange_texte: event.dateRangeFr,
          date_debut_reference: event.firstDateBegin,
          timings_actuels: event.timings ? JSON.stringify(event.timings) : null
        };

        const systemPrompt = `Tu es un expert en recommandation d'événements et en indexation sémantique. Ton rôle est d'enrichir le contexte d'un événement pour optimiser sa recherche vectorielle par des utilisateurs finaux.

Voici les données brutes de l'événement :
${JSON.stringify(eventDataForAI, null, 2)}

TACHE 1 - Enrichissement sémantique des mots-clés (condensed_text) :
Génère une suite logique de mots-clés, synonymes, tags et concepts sémantiques larges. Explicite impérativement l'ambiance, le cadre physique, le public cible et la nature de l'expérience.
⚠️ RÈGLE CRUCIALE : SUPPRIME TOUTES LES DATES, HEURES, JOURS DE LA SEMAINE OU ANNÉES de ce champ.

TACHE 2 - Extraction temporelle brute (extracted_time_text) :
Si "timings_actuels" contient déjà des dates valides (et pas un bloc immense de plusieurs jours/semaines), renvoie null.
Sinon, extrait fidèlement l'expression exacte de la date depuis le texte brut pour traitement ultérieur.

TACHE 3 - Temporalité fine (is_recurring, recurrence_rule, specific_dates) :
Analyse 'daterange_texte' et 'date_debut_reference' pour scinder la temporalité dans un de ces cas précis :
- CAS 1 (Période Longue Continue) : Si l'événement dure des semaines/mois entiers (ex: 'du 14 nov au 19 juin') sans précision, mets is_recurring=true et force weekdays avec TOUS les jours: [0, 1, 2, 3, 4, 5, 6].
- CAS 2 (Récurrence Ciblée) : S'il se répète certains jours (ex: 'les mercredis', 'certains jeudis'), mets is_recurring=true et donne le(s) jour(s) exact(s) dans weekdays. RÈGLE ABSOLUE POUR LES INDEX : 0=Dimanche, 1=Lundi, 2=Mardi, 3=Mercredi, 4=Jeudi, 5=Vendredi, 6=Samedi. Ne te trompe pas (ex: Mercredi = 3, pas 2).
- CAS 3 (Dates Éparses Isolées) : S'il s'agit de dates précises (ex: '30 mai et 20 juin'), mets is_recurring=false, laisse recurrence_rule vide (sauf les heures) et liste ces dates dans 'specific_dates' au format YYYY-MM-DD. Déduis l'année grâce à date_debut_reference.
- Dans TOUS LES CAS : Précise 'start_time' et 'end_time' (Format HH:MM) dans recurrence_rule si l'heure est déduite des timings_actuels ou du texte.`;

        try {
          const prepResult = await callAIWithRetry(() => prepModel.generateContent(systemPrompt));
          const parsedData = JSON.parse(prepResult.response.text());
          
          if (!parsedData.condensed_text) throw new Error("LLM returned empty condensed text");

          // ============================================================================
          // --- ETAPE 2 : CALCUL DES DATES SELON LES 6 RÈGLES DE PRIORITÉ ---
          // ============================================================================
          let calculatedTimings = null;
          let hasValidTimings = false;

          if (event.timings && Array.isArray(event.timings) && event.timings.length > 0) {
            hasValidTimings = true;
            for (const t of event.timings) {
              const durationHours = (new Date(t.end).getTime() - new Date(t.begin).getTime()) / (1000 * 60 * 60);
              if (durationHours > 24) { 
                hasValidTimings = false;
                break;
              }
            }
          }

          if (hasValidTimings) {
            console.log(`  [RÈGLE 1] Event ${eventId} : Timings actuels valides et courts conservés.`);
            calculatedTimings = null;
          } 
          else if (event.firstDateBegin && event.lastDateEnd && 
                   ((new Date(event.lastDateEnd).getTime() - new Date(event.firstDateBegin).getTime()) / (1000 * 60 * 60) <= 24)) {
            console.log(`  [RÈGLE 2] Event ${eventId} : Utilisation du couple Begin/End court issu des colonnes.`);
            calculatedTimings = [{
              begin: new Date(event.firstDateBegin).toISOString(),
              end: new Date(event.lastDateEnd).toISOString()
            }];
          } 
          else if (event.firstDateBegin && !event.lastDateEnd) {
            console.log(`  [RÈGLE 3] Event ${eventId} : Uniquement firstDateBegin présent. Création d'un créneau de +3h.`);
            const startDate = new Date(event.firstDateBegin);
            const endDate = new Date(startDate.getTime() + (3 * 60 * 60 * 1000));
            calculatedTimings = [{
              begin: startDate.toISOString(),
              end: endDate.toISOString()
            }];
          } 
          else {
            const extractedText = parsedData.extracted_time_text;
            const isValidExtractedText = extractedText && extractedText !== "null" && extractedText !== "[]" && extractedText.trim() !== "";

            if (isValidExtractedText || event.dateRangeFr) {
              const rule = parsedData.recurrence_rule || {};
              
              if (parsedData.specific_dates && parsedData.specific_dates.length > 0) {
                calculatedTimings = [];
                const startH = rule.start_time ? parseInt(rule.start_time.split(':')[0], 10) : 0;
                const startM = rule.start_time ? parseInt(rule.start_time.split(':')[1], 10) : 0;
                const endH = rule.end_time ? parseInt(rule.end_time.split(':')[0], 10) : 23;
                const endM = rule.end_time ? parseInt(rule.end_time.split(':')[1], 10) : 59;
                
                for (const dStr of parsedData.specific_dates) {
                  const dateObj = new Date(dStr);
                  if (isNaN(dateObj.getTime())) continue; 
                  
                  const beginDate = new Date(dateObj);
                  beginDate.setHours(startH, startM, 0, 0);
                  
                  const endDate = new Date(dateObj);
                  endDate.setHours(endH, endM, 59, 999);
                  
                  calculatedTimings.push({ begin: beginDate.toISOString(), end: endDate.toISOString() });
                }
              } 
              else if (parsedData.is_recurring && rule.weekdays) {
                const referenceDate = event.firstDateBegin ? new Date(event.firstDateBegin) : new Date();
                const parsedDates = chrono.fr.parse(extractedText || event.dateRangeFr, referenceDate);
                
                if (parsedDates && parsedDates.length > 0) {
                  const parsed = parsedDates[0];
                  const globalStart = parsed.start.date();
                  const globalEnd = parsed.end ? parsed.end.date() : new Date(globalStart.getTime() + (180 * 24 * 60 * 60 * 1000)); 

                  calculatedTimings = expandRecurrence(globalStart, globalEnd, rule.weekdays, rule.start_time, rule.end_time);
                }
              } 
              else {
                const referenceDate = event.firstDateBegin ? new Date(event.firstDateBegin) : new Date();
                const parsedDates = chrono.fr.parse(extractedText || event.dateRangeFr, referenceDate);

                if (parsedDates && parsedDates.length > 0) {
                  calculatedTimings = parsedDates.map(parsed => {
                    const startDate = parsed.start.date();
                    if (!parsed.start.isCertain('hour') && rule.start_time) {
                      startDate.setHours(parseInt(rule.start_time.split(':')[0]), parseInt(rule.start_time.split(':')[1]), 0, 0);
                    }

                    const endDate = parsed.end ? parsed.end.date() : new Date(startDate);
                    if (!parsed.end) {
                      if (!parsed.start.isCertain('hour') && !rule.end_time) {
                        endDate.setHours(23, 59, 59, 999);
                      } else if (rule.end_time) {
                        endDate.setHours(parseInt(rule.end_time.split(':')[0]), parseInt(rule.end_time.split(':')[1]), 59, 999);
                      } else {
                        endDate.setHours(startDate.getHours() + 3);
                      }
                    } else if (!parsed.end.isCertain('hour') && rule.end_time) {
                      endDate.setHours(parseInt(rule.end_time.split(':')[0]), parseInt(rule.end_time.split(':')[1]), 59, 999);
                    }
                    
                    return { begin: startDate.toISOString(), end: endDate.toISOString() };
                  });
                }
              }
            }

            if (!calculatedTimings || calculatedTimings.length === 0) {
              if (event.timings && event.timings.length > 0) {
                console.log(`  [RÈGLE 5] Event ${eventId} : Échec texte. Conservation des timings larges d'origine.`);
                calculatedTimings = null; 
              } else if (event.firstDateBegin && event.lastDateEnd) {
                console.log(`  [RÈGLE 5] Event ${eventId} : Échec texte. Conversion du couple Begin/End large historique.`);
                calculatedTimings = [{
                  begin: new Date(event.firstDateBegin).toISOString(),
                  end: new Date(event.lastDateEnd).toISOString()
                }];
              }
            }
          }

          // ============================================================================
          // --- ETAPE 3 : GÉNÉRATION DE L'EMBEDDING ---
          // ============================================================================
          console.log(`  [DEBUG] Texte sémantique envoyé à l'embedding (ID: ${eventId}) : "${parsedData.condensed_text}"`);
          const embedResult = await callAIWithRetry(() => embedModel.embedContent({
            content: { parts: [{ text: parsedData.condensed_text }] },
            outputDimensionality: 768
          }));

          const embeddingString = `[${embedResult.embedding.values.join(',')}]`;

          // ============================================================================
          // --- ETAPE 4 : MISE A JOUR BASE DE DONNEES ET DATERANGE_FR ---
          // ============================================================================
          
          // Récupération des timings finaux pour générer le daterange s'il manque
          const finalTimings = (calculatedTimings && calculatedTimings.length > 0) ? calculatedTimings : event.timings;
          let generatedDateRangeFr = null;

          // Génération du daterange_fr s'il est vide/null dans les données d'origine
          if ((!event.dateRangeFr || event.dateRangeFr.trim() === '') && finalTimings && finalTimings.length > 0) {
            generatedDateRangeFr = generateDateRangeFrString(finalTimings);
            console.log(`  [INFO] Event ${eventId} : daterange_fr généré -> "${generatedDateRangeFr}"`);
          }

          // Mise à jour de la base de données selon 4 scénarios (avec/sans timings calculés, avec/sans daterange_fr généré)
          if (calculatedTimings && calculatedTimings.length > 0) {
            console.log(`  [INFO] Event ${eventId} : Timings mis à jour (Nbr: ${calculatedTimings.length}) et Vectorisé.`);
            if (generatedDateRangeFr) {
              await prisma.$executeRawUnsafe(
                'UPDATE events SET embedding = $1::vector, timings = $3::jsonb, daterange_fr = $4 WHERE uid = $2',
                embeddingString, eventId, JSON.stringify(calculatedTimings), generatedDateRangeFr
              );
            } else {
              await prisma.$executeRawUnsafe(
                'UPDATE events SET embedding = $1::vector, timings = $3::jsonb WHERE uid = $2',
                embeddingString, eventId, JSON.stringify(calculatedTimings)
              );
            }
          } else {
            console.log(`  [INFO] Event ${eventId} : Vectorisé (Colonne timings d'origine conservée).`);
            if (generatedDateRangeFr) {
              await prisma.$executeRawUnsafe(
                'UPDATE events SET embedding = $1::vector, daterange_fr = $3 WHERE uid = $2',
                embeddingString, eventId, generatedDateRangeFr
              );
            } else {
              await prisma.$executeRawUnsafe(
                'UPDATE events SET embedding = $1::vector WHERE uid = $2',
                embeddingString, eventId
              );
            }
          }

          processedInBatch++;
        } catch (err) {
          failedInBatch++;
          console.error(`❌ Failed to process event ${eventId}:`, err.message);
        }
      }

      console.log(`Batch ${batchIdx + 1}/${totalBatches} completed. Success: ${processedInBatch}, Failures: ${failedInBatch}`);

      // Pause entre les batchs pour respecter les quotas
      if (batchIdx < totalBatches - 1) {
        await sleep(2000);
      }
    }

    console.log('🎉 Smart embedding generation process completed successfully!');

  } catch (error) {
    console.error('💥 An error occurred in the script:', error);
  } finally {
    await disconnect();
  }
}

main();