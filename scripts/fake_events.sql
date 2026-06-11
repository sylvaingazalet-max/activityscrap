-- 1. Création d'un lieu fictif (nécessaire pour la contrainte de clé étrangère)
INSERT INTO locations (location_uid, location_name, location_district)
VALUES ('loc_honeypot', 'Hors Périmètre', 'N/A')
ON CONFLICT (location_uid) DO NOTHING;

-- 2. Insertion du leurre "Restauration"
INSERT INTO events (
    uid, title_fr, description_fr, longdescription_fr,
    location_uid, timings, canonicalurl, daterange_fr, conditions_fr
) VALUES (
    'honeypot_resto',
    'Restaurant, Manger, Dîner, Déjeuner, Gastronomie, Pizzeria, Burger, Fast-food',
    'Ceci est un leurre sémantique pour capter les requêtes liées à la restauration.',
    'Ne pas afficher. Utilisé pour intercepter les requêtes de restaurants, repas, faim, manger.',
    'loc_honeypot',
    -- Timings infinis pour passer les filtres de date de gemini.js
    '[{"begin": "2020-01-01T00:00:00Z", "end": "2030-12-31T23:59:59Z"}]'::jsonb,
    '',
    'Toujours',
    'N/A'
) ON CONFLICT (uid) DO NOTHING;

-- 3. Insertion du leurre "Bar / Soirée"
INSERT INTO events (
    uid, title_fr, description_fr, longdescription_fr,
    location_uid, timings, canonicalurl, daterange_fr, conditions_fr
) VALUES (
    'honeypot_bar',
    'Bar, Boire un verre, Pub, Cocktails, Bière, Apéro, Soirée étudiante, Club',
    'Ceci est un leurre sémantique pour capter les requêtes liées aux bars et à la boisson.',
    'Ne pas afficher. Utilisé pour intercepter les requêtes de pubs, bières, cocktails, boire un coup.',
    'loc_honeypot',
    '[{"begin": "2020-01-01T00:00:00Z", "end": "2030-12-31T23:59:59Z"}]'::jsonb,
    '',
    'Toujours',
    'N/A'
) ON CONFLICT (uid) DO NOTHING;