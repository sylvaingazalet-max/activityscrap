const { validatePayload } = require('../lib/validators');
const { lookupSlugs } = require('../services/platformLookup');
const { generateContent } = require('../services/geminiClient');

module.exports = async (req, res) => {
  console.log('api/gemini started', { method: req.method });
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const validationError = validatePayload(req.body);
  if (validationError) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: validationError }));
    return;
  }

  // Set headers for Server-Sent Events
  res.writeHead(200, { 
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const { prompt, companies } = req.body || {};

  // For local testing only: allow skipping TLS validation with env flag
  const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true' && process.env.NODE_ENV !== 'production';
  if (allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log('api/gemini: local insecure TLS enabled');
  }

  let finalPrompt = prompt;
  const progressEvents = [];

  if (companies) {
    try {
      // Collect progress events
      const onProgress = (event) => {
        progressEvents.push(event);
        res.write(`data: ${JSON.stringify({ type: 'progress', data: event })}\n\n`);
      };

      const { lookupResults, promptAppend } = await lookupSlugs(companies, { 
        concurrency: 3, 
        timeout: 8000,
        onProgress 
      });
      finalPrompt += promptAppend || '';
      console.log('platform lookup summary', lookupResults);
    } catch (err) {
      console.error('platform lookup failed', err);
      finalPrompt += `\n\n⚠️ Erreur lors de la récupération des données entreprises : ${err.message}\n`;
    }
  }

  try {
    // Temporairement désactivé pour le développement local : 
    // On renvoie le prompt construit au lieu d'appeler l'API Gemini.
    // const { text, raw } = await generateContent(finalPrompt);
    // res.write(`data: ${JSON.stringify({ type: 'result', data: { result: text, raw } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'result', data: { result: "--- DEBUG PROMPT ---\n" + finalPrompt } })}\n\n`);
  } catch (err) {
    console.error('api/gemini error', err);
    res.write(`data: ${JSON.stringify({ type: 'error', data: { error: err.message || String(err) } })}\n\n`);
  }

  res.end();
};
