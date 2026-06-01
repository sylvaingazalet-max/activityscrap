const { fetchWithTimeout } = require('../lib/http');

const PLATFORMS = {
  SmartRecruiters: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=30`,
  Workable: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=false`, 
  Greenhouse: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
  Lever: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
  Teamtailor: (slug) => `https://${slug}.teamtailor.com/jobs.rss`
};

const PREDEFINED_COMPANIES = {
  kiabi: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/kiabi/postings?country=fr&region=Hauts-de-France&limit=200' },
  exotec: { platform: 'Workable', url: 'https://apply.workable.com/api/v1/widget/accounts/exotec?details=false' },
  boulanger: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/boulanger/postings?country=fr&region=Hauts-de-France&limit=200' },
  inpost: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/inpost/postings?country=fr&region=Hauts-de-France&limit=200' },
  adeo: { platform: 'Teamtailor', url: 'https://adeo.teamtailor.com/jobs.rss' },
  norauto: { platform: 'Teamtailor', url: 'https://norauto.teamtailor.com/jobs.rss' },
  ankama: { platform: 'Teamtailor', url: 'https://ankama.teamtailor.com/jobs.rss' },
  jules: { platform: 'TalentView', url: 'https://api.talentview.io/funnel/v2/companies/jules-recrutement/campaigns?company_website_id=1668&display_mode=list&location[lat]=50.624378&location[lon]=3.0678588&location[city]=Lille&location[iso_country]=FR&distance=50&offset_start=1' },
  laredoute: { platform: 'TalentView', url: 'https://api.talentview.io/funnel/v2/companies/laredoute-talent/campaigns?company_website_id=2261&display_mode=list&location[lat]=50.624378&location[lon]=3.0678588&location[city]=Lille&location[iso_country]=FR&distance=50&offset_start=1' },
  bricorama: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/bricorama/postings?country=fr&region=Hauts-de-France&limit=200' },
  sgs: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/SGS/postings?country=fr&region=Hauts-de-France&limit=200' },
  soprasteria: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/SopraSteria1/postings?country=fr&region=Hauts-de-France&limit=200' },
  hmgroup: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/HMGroup/postings?country=fr&region=Hauts-de-France&limit=200' },
  inetum: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Inetum2/postings?country=fr&region=Hauts-de-France&limit=200' },
  keyence: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/KEYENCEFRANCE/postings?country=fr&region=Hauts-de-France&limit=200' },
  amplhire: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/AmplHire/postings?country=fr&region=Hauts-de-France&limit=200' },
  expeditors: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Expeditors/postings?country=fr&region=Hauts-de-France&limit=200' },
  voyageprive: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/VoyagePriv/postings?country=fr&region=Hauts-de-France&limit=200' },
  rituals: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Rituals1/postings?country=fr&region=Hauts-de-France&limit=200' },
  covea: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/COVEA1/postings?country=fr&region=Hauts-de-France&limit=200' },
  teamwork: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/TeamworkCorporate/postings?country=fr&region=Hauts-de-France&limit=200' },
  spiebatignolles: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Spie-batignolles/postings?country=fr&region=Hauts-de-France&limit=200' },
  evoriel: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/EVORIEL/postings?country=fr&region=Hauts-de-France&limit=200' },
  courir: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Courir/postings?country=fr&region=Hauts-de-France&limit=200' },
  accorhotels: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/AccorHotel/postings?country=fr&region=Hauts-de-France&limit=200' },
  mazars: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/MAZARS/postings?country=fr&region=Hauts-de-France&limit=200' },
  lapeyre: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/LAPEYRE/postings?country=fr&region=Hauts-de-France&limit=200' },
  alten: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/ALTEN/postings?country=fr&region=Hauts-de-France&limit=200' },
  nexton: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/NEXTON/postings?country=fr&region=Hauts-de-France&limit=200' },
  citech: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/CITECH/postings?country=fr&region=Hauts-de-France&limit=200' },
  kaufmanbroad: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/KaufmanBroad/postings?country=fr&region=Hauts-de-France&limit=200' },
  loxam: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Loxam/postings?country=fr&region=Hauts-de-France&limit=200' },
  acton: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/ACT-ON/postings?country=fr&region=Hauts-de-France&limit=200' },
  artelia: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Artelia/postings?country=fr&region=Hauts-de-France&limit=200' },
  nexity: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Nexity/postings?country=fr&region=Hauts-de-France&limit=200' },
  lesaffre: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Lesaffre/postings?country=fr&region=Hauts-de-France&limit=200' },
  mousquetaires: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/GroupementMousquetaires/postings?country=fr&region=Hauts-de-France&limit=200' },
  veolia: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/VeoliaEnvironnementSA/postings?country=fr&region=Hauts-de-France&limit=200' },
  meilleurtaux: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Meilleurtaux/postings?country=fr&region=Hauts-de-France&limit=200' },
  advens: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/ADVENS/postings?country=fr&region=Hauts-de-France&limit=200' },
  xplor: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Xplor/postings?country=fr&region=Hauts-de-France&limit=200' },
  devoteam: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Devoteam/postings?country=fr&region=Hauts-de-France&limit=200' },
  sia: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Sia/postings?country=fr&region=Hauts-de-France&limit=200' },
  magellan: { platform: 'SmartRecruiters', url: 'https://api.smartrecruiters.com/v1/companies/Magellan/postings?country=fr&region=Hauts-de-France&limit=200' }
};

// Generic validation rule: consider response valid if body length > 100 characters.
function isValidResponse(text) {
  return typeof text === 'string' && text.trim().length > 100;
}

async function probeUrl(url, platform, timeout) {
  try {
    const r = await fetchWithTimeout(url, { method: 'GET', headers: { 'User-Agent': 'JobFinder/1.0' }, timeout });
    if (r && r.ok) {
      const text = await r.text();
      // Use generic length-based validator instead of platform-specific checks
      if (!isValidResponse(text)) {
        return { ok: false };
      }
      return { ok: true, text };
    }
    return { ok: false };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function processSlug(slug, timeout, progress) {
  const lowerSlug = String(slug || '').toLowerCase();
  const errors = [];

  if (PREDEFINED_COMPANIES[lowerSlug]) {
    const config = PREDEFINED_COMPANIES[lowerSlug];
    const r = await probeUrl(config.url, config.platform, timeout);
    if (r.ok) {
      if (typeof progress === 'function') progress({ slug, platform: config.platform, state: 'found', url: config.url });
      return { slug, found: true, platform: config.platform, url: config.url, body: r.text };
    }
    if (r.error) errors.push(`${config.platform}: ${r.error}`);
  }

  for (const [platform, fn] of Object.entries(PLATFORMS)) {
    const candidate = fn(slug);
    const r = await probeUrl(candidate, platform, timeout);
    if (r.ok) {
      if (typeof progress === 'function') progress({ slug, platform, state: 'found', url: candidate });
      return { slug, found: true, platform, url: candidate, body: r.text };
    }
    if (r.error) errors.push(`${platform}: ${r.error}`);
  }

  if (typeof progress === 'function') progress({ slug, state: 'not_found' });
  return { slug, found: false, errors };
}

// Try to extract structured offers from a platform response body.
function extractOffersFromBody(platform, text, candidateUrl, slug) {
  const offers = [];
  if (!text || typeof text !== 'string') return offers;

  // try JSON parse
  try {
    const data = JSON.parse(text);
    // Specific recognition for SmartRecruiters and other JSON-based platforms
    let list = [];
    if (platform === 'SmartRecruiters') {
      list = data.content || [];
    } else if (platform === 'Workable') {
      list = data.jobs || [];
    } else if (platform === 'TalentView') {
      list = Array.isArray(data) ? data : (data.data || []);
    } else {
      list = data.content || data.jobs || data.postings || (Array.isArray(data) ? data : []);
    }

    if (Array.isArray(list) && list.length > 0) {
      // We process up to 100 jobs to give Gemini a complete view while keeping the prompt clean
      for (let i = 0; i < Math.min(100, list.length); i++) {
        const item = list[i];
        const title = item.name || item.title || item.jobTitle || item.name?.trim?.() || '';
        const company = (item.company && (item.company.name || item.company.identifier)) || (item.entity && item.entity.name) || slug;
        let loc = (item.location && (item.location.fullLocation || item.location.city || item.location.region)) || (item.location && typeof item.location === 'string' ? item.location : '') || '';
        if (!loc) {
          // Fallback pour Workable et autres : city, state, country à la racine
          loc = [item.city, item.state, item.country].filter(Boolean).join(', ');
        }
        if (!loc && item.address) {
          // Fallback for TalentView: city, country inside address object
          loc = [item.address.city, item.address.country].filter(Boolean).join(', ');
        }
        let url = item.url || item.ref || item.absolute_url || candidateUrl;
        if (platform === 'TalentView' && item.slug) {
          const tvMatch = candidateUrl.match(/\/companies\/([^/]+)/);
          const tvSubdomain = tvMatch ? tvMatch[1] : 'talentview';
          url = `https://${tvSubdomain}.talentview.io/jobs/${item.slug}?source=carriere&utm_source=carriere`;
        }
        offers.push({ company: company || slug, title: title || '(titre inconnu)', location: loc || '(localisation inconnue)', url: url || candidateUrl });
      }
      return offers;
    }
  } catch (err) {
    // not JSON, continue to RSS/text fallback
  }

  // RSS / Teamtailor specific parsing using regex for lightweight extraction
  if (platform === 'Teamtailor' || text.includes('<rss') || text.includes('<item')) {
    const itemParts = text.split(/<item[^>]*>/i);
    for (let i = 1; i < Math.min(101, itemParts.length); i++) {
      const part = itemParts[i];
      // Extract title (handles potential CDATA)
      const titleMatch = part.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
      // Extract link
      const linkMatch = part.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/i);
      // Extract Teamtailor specific locations (city/country)
      const cityMatch = part.match(/<tt:city>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/tt:city>/i);
      const countryMatch = part.match(/<tt:country>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/tt:country>/i);

      if (titleMatch) {
        const title = titleMatch[1].trim();
        const link = linkMatch ? linkMatch[1].trim() : candidateUrl;
        const loc = [cityMatch?.[1], countryMatch?.[1]].filter(Boolean).map(s => s.trim()).join(', ');

        offers.push({
          company: slug,
          title: title,
          location: loc || '(voir la page)',
          url: link
        });
      }
    }
    if (offers.length > 0) return offers;
  }

  // Fallback for other large text content
  if (text.length > 200) {
    offers.push({ company: slug, title: '(offres disponibles)', location: '(voir la page)', url: candidateUrl });
  }
  return offers;
}

/**
 * Lookup an array of slugs. Returns { lookupResults, promptAppend }
 */
module.exports.lookupSlugs = async function lookupSlugs(slugs, options = {}) {
  const timeout = options.timeout || 8000;
  const onProgress = options.onProgress || null;

  const normalized = Array.isArray(slugs)
    ? slugs.map(s => String(s || '').trim()).filter(Boolean)
    : String(slugs || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const writeProgress = (info) => {
    if (onProgress) {
      onProgress(info);
    } else if (options.showProgress) {
      console.log(`${info.slug} - ${info.state} (${info.platform || 'N/A'})`);
    }
  };

  // Process all lookups in parallel to avoid Vercel timeouts and improve performance
  const lookupPromises = normalized.map(async (slug) => {
    try {
      writeProgress({ slug, state: 'looking', platform: 'auto-detect' });
      return await processSlug(slug, timeout, writeProgress);
    } catch (err) {
      return { slug, found: false, error: err.message };
    }
  });

  const results = await Promise.all(lookupPromises);

  const lookupResults = results.map(r => {
    if (!r.found) {
      let status = 'URL non trouvée';
      if (r.error) status = `Erreur: ${r.error}`;
      else if (r.errors && r.errors.length > 0) status = `Échecs API: ${r.errors.join('; ')}`;
      return { slug: r.slug, status };
    }
    return { slug: r.slug, status: `found on ${r.platform}`, url: r.url };
  });

  let promptAppend = '';
  for (const r of results) {
    if (r.found) {
      const offers = extractOffersFromBody(r.platform, r.body, r.url, r.slug);
      if (offers.length > 0) {
        const formattedOffers = offers.map(o => `- ${o.title} (${o.location}) ==> ${o.url}`).join('\n');
        promptAppend += `\n\nPostes ouverts chez ${r.slug} via ${r.platform}:\n${formattedOffers}`;
      } else {
        // Fallback: if parsing fails, send a snippet of the raw content
        const snippet = (r.body || '').slice(0, 3000);
        promptAppend += `\n\nContenu brut extrait de ${r.platform} pour ${r.slug} (${r.url}):\n${snippet}`;
      }
    }
  }

  const summary = lookupResults.map(r => `${r.slug}: ${r.status}${r.url ? ' -> ' + r.url : ''}`).join('\n');
  if (summary) promptAppend += `\n\nRésumé des recherches d'URL:\n${summary}`;

  return { lookupResults, promptAppend };
};
