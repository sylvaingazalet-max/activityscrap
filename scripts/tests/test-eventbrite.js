const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

const { getPrismaClient, disconnect } = require('../../lib/prismaClient');
const EB_TOKEN = process.env.EVENTBRITE_PRIVATE_TOKEN;

function extractEventbriteId(text) {
  if (!text) return null;
  const regex = /eventbrite\.(?:fr|com)\/e\/(?:.*-)?(\d+)/i;
  const match = text.match(regex);
  return match ? match[1] : null;
}

async function getOrganizerFromEvent(eventId) {
  const url = `https://www.eventbriteapi.com/v3/events/${eventId}/?expand=organizer`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${EB_TOKEN}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.organizer ? { id: data.organizer.id, name: data.organizer.name } : null;
  } catch { return null; }
}

async function main() {
  const prisma = await getPrismaClient();
  // On récupère tout pour ne rien rater
  const events = await prisma.event.findMany();
  const ebEventIds = new Set();

  for (const ev of events) {
    // On check l'intégralité de l'objet ligne converti en texte
    const fullText = JSON.stringify(ev);
    const id = extractEventbriteId(fullText);
    if (id) ebEventIds.add(id);
  }

  console.log(`🎯 Nombre d'événements Eventbrite uniques trouvés dans ta BDD : ${ebEventIds.size}`);
  
  const organizers = new Map();
  for (const id of ebEventIds) {
    await new Promise(r => setTimeout(r, 200)); // Rate limit
    const org = await getOrganizerFromEvent(id);
    if (org) organizers.set(org.id, org);
  }

  console.log('\n💼 ORGANISATEURS LILLOIS IDENTIFIÉS :');
  console.log(JSON.stringify(Array.from(organizers.values()), null, 2));
  await disconnect();
}
main();