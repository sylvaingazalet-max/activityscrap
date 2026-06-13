const path = require('path');
const dotenv = require('dotenv');
const { Readable } = require('stream');
const readline = require('readline');
const { getPrismaClient, disconnect } = require('../../lib/prismaClient');

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const OA_API_KEY = process.env.OPENAGENDA_API_KEY;

async function main() {
  console.log('🚀 ÉTAPE 1 : Recherche des agendas (Geo + Mots-clés)...');
  const prisma = await getPrismaClient();
  const agendasMap = new Map();

  // 1.A. Recherche Spatiale
  const LILLE_LON = 3.0572;
  const LILLE_LAT = 50.6292;
  const whereClause = `within_distance(location_coordinates, geom'POINT(${LILLE_LON} ${LILLE_LAT})', 15km)`;
  const odsUrl = `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/exports/jsonl?where=${encodeURIComponent(whereClause)}`;

  try {
    const responseOds = await fetch(odsUrl);
    if (responseOds.ok) {
      const rl = readline.createInterface({ input: Readable.fromWeb(responseOds.body) });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const uid = ev.originagenda_uid || ev.agenda_uid;
          const title = ev.originagenda_title || ev.agenda_title;
          if (uid) agendasMap.set(String(uid), { uid: String(uid), title: title || 'Sans titre', description: '' });
        } catch (e) {}
      }
    }
  } catch (err) { console.error('⚠️ Erreur recherche spatiale:', err.message); }

  // 1.B. Recherche Mots-Clés
  const keywords = ['lille', 'roubaix', 'tourcoing', "villeneuve d'ascq", 'mel', 'marcq-en-baroeul', 'euratechnologies', 'metropole lilloise'];
  for (const keyword of keywords) {
    let hasMore = true;
    let afterCursor = [];
    while (hasMore) {
      const url = new URL('https://api.openagenda.com/v2/agendas');
      url.searchParams.append('search', keyword);
      url.searchParams.append('size', '50');
      if (afterCursor.length > 0) afterCursor.forEach(c => url.searchParams.append('after[]', c));

      try {
        const res = await fetch(url.toString(), { headers: { 'key': OA_API_KEY } });
        if (!res.ok) break;
        const data = await res.json();
        
        (data.agendas || []).forEach(ag => {
          const uidStr = String(ag.uid);
          if (agendasMap.has(uidStr)) agendasMap.get(uidStr).description = ag.description || '';
          else agendasMap.set(uidStr, { uid: uidStr, title: ag.title, description: ag.description || '' });
        });

        if (data.after && data.after.length > 0) afterCursor = data.after;
        else hasMore = false;
      } catch (err) { hasMore = false; }
    }
  }

  console.log(`✅ ${agendasMap.size} agendas détectés. Sauvegarde en BDD...`);

  let newCount = 0;
  for (const ag of agendasMap.values()) {
    // createMany n'est pas idéal ici car on veut skip les doublons proprement.
    // L'astuce : on fait un create, et on ignore l'erreur si l'ID existe déjà.
    try {
      const exists = await prisma.openAgenda.findUnique({ where: { uid: ag.uid } });
      if (!exists) {
        await prisma.openAgenda.create({
          data: { uid: ag.uid, title: ag.title, description: ag.description, status: 'PENDING' }
        });
        newCount++;
      }
    } catch (e) { /* Ignorer silencieusement */ }
  }

  console.log(`🎉 Terminé ! ${newCount} NOUVEAUX agendas ajoutés en attente de tri.`);
  await disconnect();
}

main();