const { fetchWithTimeout } = require('../lib/http');

module.exports.generateContent = async function generateContent(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const e = new Error('GEMINI_API_KEY is not configured');
    e.status = 500;
    throw e;
  }

  // Correction : gemini-2.5-flash n'existe pas. Utilisation de gemini-1.5-flash.
  const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const timeout = options.timeout || 20000;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [
        { parts: [ { text: prompt } ] }
      ]
    }),
    timeout
  });

  const rawBody = await res.text();
  let data = null;
  try { data = JSON.parse(rawBody); } catch (_) { data = null; }

  if (!res.ok) {
    const err = new Error('Gemini API error');
    err.status = res.status;
    err.raw = data || rawBody;
    throw err;
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.candidates?.[0]?.content?.[0]?.text || rawBody;
  return { text, raw: data || rawBody };
};
