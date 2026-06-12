process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const https = require('https');
const fs = require('fs');

const EB_TOKEN = process.env.EVENTBRITE_PRIVATE_TOKEN;

// On pointe directement sur les fichiers dans le même dossier que ce script
const RAW_EVENTS_FILE = path.join(__dirname, 'raw_events.json');
const ORGANIZERS_FILE = path.join(__dirname, 'eventbrite.json');

function extractEventId(url) {
  try {
    const cleanUrl = url.split('?')[0].replace(/\/$/, '');
    const parts = cleanUrl.split('-');
    return parts[parts.length - 1];
  } catch (e) {
    return null;
  }
}

function fetchOrganizerData(eventId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.eventbriteapi.com',
      path: `/v3/events/${eventId}/?expand=organizer`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${EB_TOKEN}` },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Erreur de parsing JSON")); }
        } else {
          reject(new Error(`Statut HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

async function main() {
  if (!EB_TOKEN) {
    console.error("❌ EVENTBRITE_PRIVATE_TOKEN manquant dans le .env");
    return;
  }

  if (!fs.existsSync(RAW_EVENTS_FILE)) {
    console.error(`❌ Fichier ${RAW_EVENTS_FILE} introuvable.`);
    return;
  }

  const eventUrls = JSON.parse(fs.readFileSync(RAW_EVENTS_FILE, 'utf-8'));
  console.log(`🔎 Analyse de ${eventUrls.length} événements depuis raw_events.json...\n`);

  let existingOrganizers = [];
  if (fs.existsSync(ORGANIZERS_FILE)) {
    existingOrganizers = JSON.parse(fs.readFileSync(ORGANIZERS_FILE, 'utf-8'));
  }
  const organizersMap = new Map(existingOrganizers.map(org => [org.id, org]));
  let newAdded = 0;

  for (const url of eventUrls) {
    const eventId = extractEventId(url);
    if (!eventId) continue;

    try {
      const data = await fetchOrganizerData(eventId);
      
      if (data.organizer) {
        const orgId = data.organizer.id;
        if (!organizersMap.has(orgId)) {
          organizersMap.set(orgId, {
            id: orgId,
            name: data.organizer.name,
            url: data.organizer.url
          });
          console.log(`✅ NOUVEAU : ${data.organizer.name} (ID: ${orgId})`);
          newAdded++;
        } else {
          console.log(`ℹ️ Déjà connu : ${data.organizer.name}`);
        }
      }
    } catch (err) {
      console.error(`💥 Erreur pour l'événement ${eventId} :`, err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  fs.writeFileSync(ORGANIZERS_FILE, JSON.stringify(Array.from(organizersMap.values()), null, 2), 'utf-8');
  console.log(`\n🎉 Terminé ! ${newAdded} nouveaux organisateurs ajoutés à eventbrite.json.`);
}

main();