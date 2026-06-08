const chrono = require('chrono-node');
const logger = require('./logger'); 

/**
 * Extrait l'intention temporelle via le LLM, puis utilise chrono-node
 * uniquement pour finaliser le traitement (calculer les dates exactes).
 *
 * @param {string} prompt - Le prompt brut de l'utilisateur
 * @param {Date} targetDateRef - La date de référence (aujourd'hui) calée sur la bonne timezone
 * @param {Object} genAI - L'instance GoogleGenerativeAI
 * @returns {Object} { startOfDay, endOfDay, cleanedPrompt, searchForEmbedding }
 */
async function parseTemporalPrompt(prompt, targetDateRef, genAI) {
  const contextLog = logger.createLogger('lib/temporalParser');
  contextLog.info('▶️ DÉBUT DU CALL LLM pour extraction textuelle...');

  let extractedTimeText = null;
  let cleanedPrompt = prompt;

  // ============================================================================
  // ÉTAPE 1 : Séparation Sémantique stricte (Gemini)
  // ============================================================================
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const systemPrompt = `
    Tu es un expert en analyse de texte. Tu as DEUX missions strictes :
    1. Isoler l'expression temporelle textuelle (NE CALCULE AUCUNE DATE, ne renvoie pas de format ISO).
    2. Condenser l'intention de l'utilisateur en mots-clés simples pour un moteur de recherche (supprime les verbes inutiles, les pronoms, etc.).
    
    Exemple 1 : "je veux écouter de la musique vendredi prochain"
    Réponse attendue : { "extracted_time_text": "vendredi prochain", "cleaned_prompt": "musique concert" }

    Exemple 2 : "trouve moi un bar sympa pour boire un coup ce soir"
    Réponse attendue : { "extracted_time_text": "ce soir", "cleaned_prompt": "bar boire" }

    Exemple 3 : "aller au musée"
    Réponse attendue : { "extracted_time_text": null, "cleaned_prompt": "musée" }

    Phrase à analyser : "${prompt}"
    `;

    const result = await model.generateContent(systemPrompt);
    const parsedJson = JSON.parse(result.response.text());
    
    extractedTimeText = parsedJson.extracted_time_text;
    cleanedPrompt = parsedJson.cleaned_prompt || prompt;
    
    contextLog.info(`✅ RETOUR LLM (Texte extrait) : "${extractedTimeText}" | (Prompt nettoyé) : "${cleanedPrompt}"`);

  } catch (err) {
    // Si l'IA plante, on désactive le filtrage par date (recherche sémantique pure)
    contextLog.error('⚠️ Erreur LLM lors de l\'extraction temporelle. Pas de filtrage temporel.', err.message);
    extractedTimeText = null; 
    cleanedPrompt = prompt;
  }

  // ============================================================================
  // ÉTAPE 2 : Finalisation du traitement (Chrono-node)
  // ============================================================================
  let startOfDay = null;
  let endOfDay = null;

  // Chrono-node n'intervient QUE si l'IA a détecté et extrait une vraie entité temporelle
  if (extractedTimeText) {
    contextLog.info(`🧮 Finalisation avec chrono-node FR sur : "${extractedTimeText}"`);
    
    const parsedDates = chrono.fr.parse(extractedTimeText, targetDateRef, { forwardDate: true });

    if (parsedDates && parsedDates.length > 0) {
      const parsed = parsedDates[0];
      const startDate = parsed.start.date();
      const endDate = parsed.end ? parsed.end.date() : new Date(startDate);
      
      if (!parsed.end) {
        endDate.setHours(23, 59, 59, 999);
      }

      startOfDay = startDate.toISOString();
      endOfDay = endDate.toISOString();

      contextLog.info(`✅ DATES CALCULÉES :\n  - Début : ${startOfDay}\n  - Fin : ${endOfDay}`);
    } else {
      contextLog.warn(`⚠️ Chrono-node n'a pas pu traduire l'expression : "${extractedTimeText}". Pas de filtrage par date.`);
    }
  }

  return {
    startOfDay,
    endOfDay,
    cleanedPrompt,
    searchForEmbedding: cleanedPrompt 
  };
}

module.exports = { parseTemporalPrompt };