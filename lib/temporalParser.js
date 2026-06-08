const chrono = require('chrono-node');
const logger = require('../lib/logger');

/**
 * Extrait les dates et HEURES d'une phrase en langage naturel.
 * Tente d'abord une extraction fine via Gemini 2.5 Flash Lite.
 * En cas d'échec ou d'indisponibilité de l'API, bascule sur chrono-node en fallback local.
 *
 * @param {string} prompt - La requête de l'utilisateur
 * @param {Date} targetDateRef - La date de référence (aujourd'hui par défaut)
 * @param {object} genAI - L'instance GoogleGenerativeAI (optionnelle pour permettre le fallback direct)
 * @returns {Promise<object>} { startOfDay, endOfDay, cleanedPrompt, searchForEmbedding }
 */
async function parseTemporalPrompt(prompt, targetDateRef = new Date(), genAI = null) {
  const contextLog = logger.createLogger('lib/temporalParser');
  
  // Normalisation préalable pour aider les parseurs
  const normalizedPrompt = prompt.replace(/week-end/gi, 'weekend');

  // ============================================================================
  // 1. TENTATIVE PRINCIPALE : IA (Gemini 2.5 Flash Lite)
  // ============================================================================
  if (genAI) {
    try {
      contextLog.info('▶️ DÉBUT DU CALL LLM (Gemini Flash Lite) pour extraction temporelle...');
      
      const todayStr = targetDateRef.toISOString();
      const systemPrompt = `Tu es un expert en analyse sémantique et extraction d'entités temporelles.
Aujourd'hui, nous sommes le ${todayStr} (Format UTC).
Analyse la requête utilisateur suivante : "${normalizedPrompt}"

1. Identifie toute notion de date ou de période temporelle (ex: "demain", "ce weekend", "ce soir", "samedi après-midi").
2. Déduis la date ET L'HEURE de début et de fin exactes de cette période.
   - Si on dit "ce soir", le début doit être vers 18:00:00 et la fin à 23:59:59.
   - Si on dit "ce matin", le début est vers 08:00:00 et la fin vers 12:00:00.
   - Si aucune heure spécifique n'est sous-entendue (ex: "demain", "le 15 août"), mets 00:00:00 et 23:59:59.
3. Retire strictement ces informations temporelles de la phrase pour ne garder que l'intention sémantique.

Tu DOIS répondre STRICTEMENT avec le format JSON suivant :
{
  "start": "Date et heure ISO (ex: 2026-06-08T18:00:00.000Z) ou null s'il n'y a aucune précision de date",
  "end": "Date et heure ISO (ex: 2026-06-08T23:59:59.999Z) ou null s'il n'y a aucune précision de date",
  "searchForEmbedding": "La requête nettoyée de ses marqueurs de temps"
}`;

      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-lite",
        generationConfig: { responseMimeType: "application/json" }
      });

      const result = await model.generateContent(systemPrompt);
      const parsed = JSON.parse(result.response.text());

      const startOfDay = parsed.start ? new Date(parsed.start) : null;
      const endOfDay = parsed.end ? new Date(parsed.end) : null;
      
      const searchForEmbedding = parsed.searchForEmbedding?.trim().length > 1 
        ? parsed.searchForEmbedding 
        : normalizedPrompt;

      contextLog.info(`✅ RETOUR LLM :
  - Début : ${startOfDay ? startOfDay.toISOString() : 'Aucun'}
  - Fin : ${endOfDay ? endOfDay.toISOString() : 'Aucun'}
  - Script restant : "${searchForEmbedding}"`);
      
      return {
        startOfDay,
        endOfDay,
        cleanedPrompt: searchForEmbedding,
        searchForEmbedding
      };
    } catch (error) {
      contextLog.error(`❌ ERREUR LLM : ${error.message}`);
      // On ne throw pas l'erreur, on laisse le code continuer vers le fallback
    }
  } else {
    contextLog.warn('⚠️ Instance genAI non fournie, passage direct au fallback chrono-node');
  }

  // ============================================================================
  // 2. FALLBACK LOCAL : chrono-node
  // ============================================================================
  contextLog.info('▶️ DÉBUT DU PARSING LOCAL (chrono-node)...');
  
  let startOfDay = null;
  let endOfDay = null;
  let cleanedPrompt = normalizedPrompt;

  try {
    const parsedDates = chrono.fr.parse(normalizedPrompt, targetDateRef);

    if (parsedDates.length > 0) {
      const timeMatch = parsedDates[0];
      const detectedDate = timeMatch.start.date();
      
      startOfDay = new Date(detectedDate);
      
      // Fallback très basique pour chrono-node
      if (normalizedPrompt.toLowerCase().includes('soir')) {
        startOfDay.setHours(18, 0, 0, 0);
      } else {
        startOfDay.setHours(0, 0, 0, 0);
      }
      
      endOfDay = new Date(detectedDate);
      endOfDay.setHours(23, 59, 59, 999);

      if (timeMatch.end) {
        const detectedEndDate = timeMatch.end.date();
        endOfDay = new Date(detectedEndDate);
        endOfDay.setHours(23, 59, 59, 999);
      }

      // Nettoyage de la requête
      cleanedPrompt = normalizedPrompt.replace(timeMatch.text, '').replace(/\s+/g, ' ').trim();
    }
  } catch (err) {
    contextLog.error(`❌ ERREUR CHRONO-NODE : ${err.message}`);
  }

  // Fallback ultime : si le nettoyage a tout vidé
  const searchForEmbedding = cleanedPrompt.length > 1 ? cleanedPrompt : normalizedPrompt;

  contextLog.info(`✅ RETOUR CHRONO-NODE :
  - Début : ${startOfDay ? startOfDay.toISOString() : 'Aucun'}
  - Fin : ${endOfDay ? endOfDay.toISOString() : 'Aucun'}
  - Script restant : "${searchForEmbedding}"`);

  return {
    startOfDay,
    endOfDay,
    cleanedPrompt,
    searchForEmbedding
  };
}

module.exports = { parseTemporalPrompt };