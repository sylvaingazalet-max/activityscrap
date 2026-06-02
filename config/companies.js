/**
 * Predefined company configurations for job posting lookups
 * 
 * Each entry maps a company slug to its recruitment platform and API endpoint.
 * The URL patterns vary by platform (SmartRecruiters, Workable, Teamtailor, TalentView).
 * 
 * Filters applied:
 * - country: France (fr)
 * - region: Hauts-de-France
 * - limit: 200 postings max per company
 */

module.exports = {
  // ============================================================================
  // SmartRecruiters Platform Companies
  // ============================================================================
  // SmartRecruiters uses JSON API with standardized endpoints
  kiabi: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/kiabi/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  boulanger: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/boulanger/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  inpost: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/inpost/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  bricorama: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/bricorama/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  sgs: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/SGS/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  soprasteria: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/SopraSteria1/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  hmgroup: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/HMGroup/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  inetum: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Inetum2/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  keyence: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/KEYENCEFRANCE/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  amplhire: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/AmplHire/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  expeditors: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Expeditors/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  voyageprive: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/VoyagePriv/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  rituals: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Rituals1/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  covea: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/COVEA1/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  teamwork: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/TeamworkCorporate/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  spiebatignolles: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Spie-batignolles/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  evoriel: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/EVORIEL/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  courir: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Courir/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  accorhotels: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/AccorHotel/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  mazars: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/MAZARS/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  lapeyre: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/LAPEYRE/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  alten: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/ALTEN/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  nexton: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/NEXTON/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  citech: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/CITECH/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  kaufmanbroad: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/KaufmanBroad/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  loxam: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Loxam/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  acton: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/ACT-ON/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  artelia: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Artelia/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  nexity: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Nexity/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  lesaffre: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Lesaffre/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  mousquetaires: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/GroupementMousquetaires/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  veolia: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/VeoliaEnvironnementSA/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  meilleurtaux: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Meilleurtaux/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  advens: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/ADVENS/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  xplor: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Xplor/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  devoteam: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Devoteam/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  sia: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Sia/postings?country=fr&region=Hauts-de-France&limit=200'
  },
  magellan: {
    platform: 'SmartRecruiters',
    url: 'https://api.smartrecruiters.com/v1/companies/Magellan/postings?country=fr&region=Hauts-de-France&limit=200'
  },

  // ============================================================================
  // Workable Platform Companies
  // ============================================================================
  // Workable uses its own JSON API with different response structure
  exotec: {
    platform: 'Workable',
    url: 'https://apply.workable.com/api/v1/widget/accounts/exotec?details=false'
  },

  // ============================================================================
  // Teamtailor Platform Companies
  // ============================================================================
  // Teamtailor provides RSS feeds for job postings
  adeo: {
    platform: 'Teamtailor',
    url: 'https://adeo.teamtailor.com/jobs.rss'
  },
  norauto: {
    platform: 'Teamtailor',
    url: 'https://norauto.teamtailor.com/jobs.rss'
  },
  ankama: {
    platform: 'Teamtailor',
    url: 'https://ankama.teamtailor.com/jobs.rss'
  },

  // ============================================================================
  // TalentView Platform Companies
  // ============================================================================
  // TalentView uses a custom API with location-based parameters
  jules: {
    platform: 'TalentView',
    url: 'https://api.talentview.io/funnel/v2/companies/jules-recrutement/campaigns?company_website_id=1668&display_mode=list&location[lat]=50.624378&location[lon]=3.0678588&location[city]=Lille&location[iso_country]=FR&distance=50&offset_start=1'
  },
  laredoute: {
    platform: 'TalentView',
    url: 'https://api.talentview.io/funnel/v2/companies/laredoute-talent/campaigns?company_website_id=2261&display_mode=list&location[lat]=50.624378&location[lon]=3.0678588&location[city]=Lille&location[iso_country]=FR&distance=50&offset_start=1'
  }
};
