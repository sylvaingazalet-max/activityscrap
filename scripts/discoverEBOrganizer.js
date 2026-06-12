const fs = require('fs');

// Étape 1 : On contourne le blocage de l'antivirus/VPN local qui modifie les certificats SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function main() {
  console.log('🔎 Recherche des profils Eventbrite Lillois via Bing (Mode Débogage)...');
  console.log('---------------------------------------------------------------------------\n');

  // On demande les 50 premiers résultats sur Bing pour maximiser les profils trouvés
  const searchUrl = 'https://www.bing.com/search?q=site:eventbrite.fr+Lille&count=50';

  try {
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      }
    });

    if (!response.ok) {
      throw new Error(`Bing a répondu avec un statut : ${response.status}`);
    }

    const html = await response.text();
    
    // 💾 SAUVEGARDE DU HTML POUR ANALYSE
    fs.writeFileSync('bing_debug.html', html);
    console.log("💾 Code source de la page sauvegardé sous 'bing_debug.html' dans ton dossier actuel.");
    console.log("---------------------------------------------------------------------------\n");
    
    // Sécurité au cas où Bing afficherait un CAPTCHA global
    if (html.includes("To continue, please type the characters")) {
      console.log("❌ Bing demande un CAPTCHA visuel. Le réseau bloque la requête automatisée.");
      return;
    }

    // Expression régulière pour capturer les slugs de profils, même si Bing injecte du gras <strong> au milieu
    const organizerRegex = /eventbrite\.fr\/o\/([a-zA-Z0-9-<>_]+)/gi;
    const matches = html.match(organizerRegex) || [];
    
    const discoveredOrganizers = new Map();

    for (const match of matches) {
      // Nettoyage des balises HTML parasites (comme les <strong> mis par Bing sur les mots-clés)
      const cleanMatch = match.replace(/<[^>]*>/g, ''); 
      
      // Extraction de l'ID numérique situé après le dernier tiret
      const idMatch = cleanMatch.match(/-(\d+)/);
      
      if (idMatch) {
        const organizerId = idMatch[1];
        const slug = cleanMatch.split('/o/')[1].replace(`-${organizerId}`, '');
        
        // Formatage cosmétique pour rendre le nom lisible (Ex: "euratechnologies" -> "Euratechnologies")
        const organizerName = slug.split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');

        discoveredOrganizers.set(organizerId, {
          id: organizerId,
          name: decodeURIComponent(organizerName),
          url: `https://www.eventbrite.fr/o/${slug}-${organizerId}`
        });
      }
    }

    const finalResult = Array.from(discoveredOrganizers.values());

    if (finalResult.length === 0) {
      console.log("⚠️ Aucun profil extrait.");
      console.log(`ℹ️ Taille de la page reçue : ${html.length} caractères. (Si < 5000, Bing a bloqué l'accès).`);
      console.log("👉 Ouvre 'bing_debug.html', cherche 'eventbrite' et regarde comment Bing a formaté les URL !");
      return;
    }

    console.log(`🎉 Victoire ! ${finalResult.length} structures lilloises identifiées :`);
    console.log(`-------------------------------------------------------------------\n`);
    console.log(JSON.stringify(finalResult, null, 2));

  } catch (error) {
    console.error('💥 Erreur lors du scan :', error.message);
  }
}

main();