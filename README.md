🧭 La Boussole de Lille - Système de Recommandation d'Événements par IACe projet est un moteur de recherche et de recommandation intelligent d'événements culturels et de sorties à Lille. S'appuyant sur les données de la Mairie de Lille, d'OpenAgenda, de Ticketmaster, de DataTourisme et d'Eventbrite, il permet aux utilisateurs de trouver des activités via des requêtes en langage naturel (ex: "un concert gratuit pour sortir avec des amis ce samedi soir"), tout en appliquant des filtres temporels stricts issus de l'interface utilisateur.  📖 Vue d'Ensemble du ProjetLa Boussole de Lille réinvente la découverte d'événements en combinant la précision d'une recherche par calendrier et la puissance de la recherche sémantique vectorielle.  Le cycle complet de l'application s'articule autour de quatre grands axes :  Moissonnage et Normalisation multi-sources : Récupération automatisée des flux d'événements depuis plusieurs plateformes majeures avec dédoublonnement et stockage dans une base PostgreSQL.  Enrichissement Sémantique et Vectorisation : Analyse des descriptions par un grand modèle de langage (LLM) pour extraire l'ambiance, le public cible, et normaliser la temporalité, suivie d'une génération d'embeddings vectoriels à 768 dimensions.  Recherche Hybride au Runtime : Calcul à la volée de l'embedding de la requête utilisateur, puis exécution d'une requête SQL brute combinant une similarité cosinus (via pgvector) et un filtrage temporel strict sur les créneaux horaires stockés en JSONB.  Restitution Fluide et Streamée : Envoi des résultats au client en temps réel via des Server-Sent Events (SSE) avec une interface web optimisée et transparente.  🛠️ Stack TechnologiqueBackend : Node.js / Serverless API Route Handler.  Base de Données : PostgreSQL enrichi de l'extension pgvector pour la recherche de similarité.  ORM : Prisma ORM pour la modélisation du schéma, les transactions et les requêtes brutes complexes ($queryRaw).  Intelligence Artificielle :  Google Gemini 2.5 Flash Lite : Choisi pour sa rapidité et son coût optimisé lors de la phase d'analyse sémantique et de structuration des métadonnées temporelles.  Google Gemini Embedding 2 : Utilisé pour générer des représentations vectorielles de 768 dimensions (indexation des documents et traitement des requêtes).  Analyse Temporelle Repli : chrono-node (variante française) pour interpréter les dates textuelles complexes en cas de besoin.  Frontend : Vanilla HTML5 / JavaScript moderne (ES6) / CSS3. Léger, ultra-rapide, sans framework, s'appuyant sur Flatpickr pour la gestion native des calendriers.  📁 Structure du ProjetPlaintext├── api/
│   └── gemini.js                 # Handler principal d'API hybride directe (Serverless, SSE, pgvector)
├── json/
│   └── openAgendasFiltered.json  # Configuration des agendas locaux OpenAgenda ciblés
├── lib/
│   ├── http.js                   # Client fetch HTTP générique avec gestion fine des timeouts
│   ├── logger.js                 # Logger JSON structuré par contexte pour le debug de production
│   ├── prismaClient.js           # Initialisation dynamique et singleton du client Prisma
│   └── validators.js             # Validateurs de payload de requêtes entrantes
├── prisma/
│   └── schema.prisma             # Schéma de base de données PostgreSQL (Modèles Event, Location, PointOfInterest)
├── public/
│   └── index.html                # Interface web interactive ("La Boussole de Lille")
├── scripts/
│   ├── generate-embeddings.js    # Pipeline asynchrone de prétraitement LLM et de vectorisation
│   ├── syncALLopenagenda.js      # Script de synchronisation native OpenAgenda API v2
│   ├── syncdatatourisme.js       # Extracteur et décompacteur de flux d'objets DataTourisme (ZIP)
│   ├── syncTicketMaster.js       # Synchroniseur d'événements géolocalisés Ticketmaster (rayon 30km)
│   └── eventbrite/
│       ├── 1_extractOrganizers.js # Extraction des organisateurs Eventbrite ciblés
│       ├── 2_syncEventbrite.js    # Moissonnage final et insertion des événements Eventbrite
│       └── raw_events.json        # Fichier tampon pour le stockage temporaire des URLs scrapées
└── methodo.txt                   # Mode opératoire détaillé pour le moissonnage Eventbrite "Sniper"
🚀 Installation et Démarrage Rapide1. PrérequisUn serveur PostgreSQL avec l'extension pgvector installée et activée (CREATE EXTENSION vector;).  Node.js (version 18+ recommandée).  2. Installation des DépendancesÀ la racine de votre projet, installez l'ensemble des paquets requis :  Bashnpm install
3. Configuration de l'EnvironnementCréez un fichier .env à la racine du projet et complétez les variables suivantes :  Code snippet# Connexion Base de Données
DATABASE_URL="postgresql://utilisateur:mot_de_passe@localhost:5432/lille_events?schema=public"

# Clés d'API tierces
GEMINI_API_KEY="AIzaSy..."
OPENAGENDA_API_KEY="votre_cle_openagenda"
APIKEY_DATATOURISME="votre_cle_datatourisme"
TICKETMASTER_CONSUMER_KEY="votre_cle_ticketmaster"

# Paramètres d'environnement
NODE_ENV="development"
ALLOW_INSECURE_TLS="true"
4. Initialisation de la Base de DonnéesAppliquez le schéma Prisma à votre instance PostgreSQL :  Bashnpx prisma db push
5. Lancement des Scripts de SynchronisationAlimentez votre base de données en exécutant un ou plusieurs scripts de collecte :  Bash# Moissonnage OpenAgenda
node scripts/syncALLopenagenda.js

# Moissonnage Ticketmaster
node scripts/syncTicketMaster.js

# Moissonnage DataTourisme
node scripts/syncdatatourisme.js
6. Génération des Embeddings par l'IAUne fois les données brutes insérées, lancez le pipeline d'enrichissement sémantique et de vectorisation :  Bashnode scripts/generate-embeddings.js
7. Démarrage de l'ApplicationLancez votre serveur local (par exemple via Vercel CLI ou un serveur Node de développement) pour exposer l'API et servir le fichier public index.html.  🔄 Stratégies de Collecte et SynchronisationChaque plateforme source dispose d'un mécanisme d'ingestion dédié, adapté à ses contraintes d'API :  OpenAgenda (syncALLopenagenda.js) : Consomme de manière itérative l'API v2 native en transmettant des curseurs d'historique (after[]). Il intègre une protection amont excluant automatiquement les événements passés ou ne disposant pas de titres valides.  Ticketmaster (syncTicketMaster.js) : Interroge les événements dans un rayon de 30 km autour du centre de Lille (50.6292,3.0572). Gère de manière transparente un système d'upsert découplé (Lieux d'abord, Événements ensuite) et applique une pause de 300ms entre les pages pour respecter le quota strict de 5 requêtes par seconde.  DataTourisme (syncdatatourisme.js) : Télécharge à la volée une archive ZIP volumineuse, la décompresse en mémoire et traite de manière séquentielle chaque fichier JSON. Il effectue un tri sémantique natif : si l'objet contient des marqueurs temporels, il est classé comme EVENT, sinon il est orienté vers la table des Lieux d'intérêt (PointOfInterest).  Eventbrite (methodo.txt) : Procédure "Sniper" semi-automatisée. Un script JavaScript est exécuté manuellement dans la console d'un navigateur pour aspirer les identifiants d'événements lillois à l'écran. Ces données alimentent raw_events.json, qui est ensuite traité par deux scripts Node.js successifs pour extraire les profils d'organisateurs et injecter leurs catalogues respectifs en base.  🧭 Fonctionnalités Avancées de l'Interface  Le frontend de La Boussole de Lille embarque des mécaniques poussées de filtrage et d'UX :  Filtrage Temporel Flexible : Propose 3 modes d'affichage (Peu importe, Jour précis, Période) synchronisés avec Flatpickr, permettant d'adresser des contraintes strictes à l'API.  Pagination Fluide "Voir Plus" : Les résultats ne sont pas affichés d'un coup afin d'éviter la surcharge cognitive. Un système de lots par paquets de 3 événements (BATCH_SIZE = 3) est injecté dynamiquement lors du clic sur le bouton d'action.  Sécurité Anti-Honeypot : Si un utilisateur saisit une requête orientée uniquement vers la recherche de bars ou de restaurants (activités purement commerciales permanentes), le backend renvoie des identifiants spécifiques (honeypot_resto, honeypot_bar). L'interface intercepte ces identifiants pour masquer la liste classique et afficher un encadré pédagogique orientant l'utilisateur vers des guides locaux spécialisés.  Transparence Environnementale : Une section dédiée affiche l'empreinte carbone estimée de chaque requête vectorielle (0,01 à 0,05 g de CO2) et de l'intégration d'un événement (0,1 à 0,2 g de CO2), valorisant l'architecture sobre basée sur des modèles "Lite".  