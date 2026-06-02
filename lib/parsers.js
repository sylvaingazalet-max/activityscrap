/**
 * Job Posting Parsers
 * 
 * This module provides platform-specific parsers for extracting job offers
 * from different recruitment platforms. Each platform returns data in different
 * formats (JSON, RSS, custom structures), so we normalize them all to a common
 * job offer structure.
 * 
 * Job Offer Format:
 * {
 *   company: string - Company name
 *   title: string - Job position title
 *   location: string - Job location
 *   url: string - Link to job posting
 * }
 */

const MAX_OFFERS_PER_SOURCE = 100;

/**
 * Generic validation: check if response body is substantial enough
 * @param {string} text - Response body text
 * @returns {boolean} True if response appears to contain valid data
 */
function isValidResponse(text) {
  return typeof text === 'string' && text.trim().length > 100;
}

/**
 * Extract location from multiple possible fields
 * Tries various location field names used by different platforms
 * 
 * @param {object} item - Job posting object from API
 * @returns {string} Formatted location string
 */
function extractLocation(item) {
  let location = '';

  // Try nested location object with standard fields
  if (item.location) {
    if (typeof item.location === 'object') {
      location = item.location.fullLocation || 
                 item.location.city || 
                 item.location.region || 
                 '';
    } else if (typeof item.location === 'string') {
      location = item.location;
    }
  }

  // Fallback: city, state, country at root level (used by Workable, etc.)
  if (!location) {
    location = [item.city, item.state, item.country]
      .filter(Boolean)
      .join(', ');
  }

  // Fallback: city and country in address object (used by TalentView)
  if (!location && item.address) {
    location = [item.address.city, item.address.country]
      .filter(Boolean)
      .join(', ');
  }

  return location;
}

/**
 * Extract job URL, handling platform-specific URL structures
 * 
 * @param {object} item - Job posting object from API
 * @param {string} platform - Recruitment platform name
 * @param {string} candidateUrl - Fallback URL to use
 * @param {string} slug - Company slug (for TalentView)
 * @returns {string} Job posting URL
 */
function extractUrl(item, platform, candidateUrl, slug) {
  let url = item.url || item.ref || item.absolute_url || candidateUrl;

  // TalentView: construct URL from company subdomain and job slug
  if (platform === 'TalentView' && item.slug) {
    const tvMatch = candidateUrl.match(/\/companies\/([^/]+)/);
    const tvSubdomain = tvMatch ? tvMatch[1] : 'talentview';
    url = `https://${tvSubdomain}.talentview.io/jobs/${item.slug}?source=carriere&utm_source=carriere`;
  }

  return url || candidateUrl;
}

/**
 * Extract job title, trying multiple possible field names
 * @param {object} item - Job posting object from API
 * @returns {string} Job title
 */
function extractTitle(item) {
  const title = item.name || 
                item.title || 
                item.jobTitle || 
                (item.name && item.name.trim?.());
  return (title || '').trim() || '(titre inconnu)';
}

/**
 * Extract company name, handling different API structures
 * @param {object} item - Job posting object from API
 * @param {string} slug - Company slug as fallback
 * @returns {string} Company name
 */
function extractCompany(item, slug) {
  if (item.company && (item.company.name || item.company.identifier)) {
    return item.company.name || item.company.identifier;
  }
  if (item.entity && item.entity.name) {
    return item.entity.name;
  }
  return slug;
}

/**
 * Parse JSON response from recruitment API
 * Handles platform-specific JSON structures: SmartRecruiters, Workable, TalentView
 * 
 * @param {string} text - Raw JSON response
 * @param {string} platform - Platform name (SmartRecruiters, Workable, TalentView)
 * @param {string} candidateUrl - URL to use as fallback
 * @param {string} slug - Company slug
 * @returns {array} Array of job offer objects, or empty array if parsing fails
 */
function parseJsonOffers(text, platform, candidateUrl, slug) {
  const offers = [];
  
  try {
    const data = JSON.parse(text);
    
    // Extract job list based on platform-specific structure
    let jobList = [];
    if (platform === 'SmartRecruiters') {
      jobList = data.content || [];
    } else if (platform === 'Workable') {
      jobList = data.jobs || [];
    } else if (platform === 'TalentView') {
      jobList = Array.isArray(data) ? data : (data.data || []);
    } else {
      // Generic fallback: try common field names
      jobList = data.content || data.jobs || data.postings || (Array.isArray(data) ? data : []);
    }

    // Process up to MAX_OFFERS_PER_SOURCE jobs
    if (Array.isArray(jobList) && jobList.length > 0) {
      for (let i = 0; i < Math.min(MAX_OFFERS_PER_SOURCE, jobList.length); i++) {
        const item = jobList[i];
        offers.push({
          company: extractCompany(item, slug) || slug,
          title: extractTitle(item),
          location: extractLocation(item) || '(localisation inconnue)',
          url: extractUrl(item, platform, candidateUrl, slug)
        });
      }
    }

    return offers;
  } catch (err) {
    // Not valid JSON, return empty to try other parsers
    return [];
  }
}

/**
 * Parse RSS feed response (used by Teamtailor and others)
 * Uses regex to extract job items from XML structure
 * 
 * @param {string} text - Raw RSS XML response
 * @param {string} candidateUrl - URL to use as fallback
 * @param {string} slug - Company slug
 * @returns {array} Array of job offer objects, or empty array if parsing fails
 */
function parseRssOffers(text, candidateUrl, slug) {
  const offers = [];
  
  // Split by RSS item tags
  const itemParts = text.split(/<item[^>]*>/i);
  
  // Start from index 1 (skip header)
  for (let i = 1; i < Math.min(MAX_OFFERS_PER_SOURCE + 1, itemParts.length); i++) {
    const part = itemParts[i];
    
    // Extract title (handles potential CDATA sections)
    const titleMatch = part.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
    
    // Extract link (handles potential CDATA sections)
    const linkMatch = part.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/i);
    
    // Extract Teamtailor-specific location fields
    const cityMatch = part.match(/<tt:city>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/tt:city>/i);
    const countryMatch = part.match(/<tt:country>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/tt:country>/i);

    if (titleMatch) {
      const title = titleMatch[1].trim();
      const link = linkMatch ? linkMatch[1].trim() : candidateUrl;
      const location = [cityMatch?.[1], countryMatch?.[1]]
        .filter(Boolean)
        .map(s => s.trim())
        .join(', ') || '(voir la page)';

      offers.push({
        company: slug,
        title: title,
        location: location,
        url: link
      });
    }
  }

  return offers;
}

/**
 * Main parser function: extract job offers from any response format
 * Tries JSON parsing first, then RSS, then generic text fallback
 * 
 * @param {string} platform - Recruitment platform name
 * @param {string} text - Raw response body
 * @param {string} candidateUrl - URL to use as fallback
 * @param {string} slug - Company slug
 * @returns {array} Array of job offer objects
 */
module.exports.extractOffersFromBody = function extractOffersFromBody(platform, text, candidateUrl, slug) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  // Try JSON parsing first (SmartRecruiters, Workable, TalentView)
  const jsonOffers = parseJsonOffers(text, platform, candidateUrl, slug);
  if (jsonOffers.length > 0) {
    return jsonOffers;
  }

  // Try RSS parsing (Teamtailor and others)
  if (platform === 'Teamtailor' || text.includes('<rss') || text.includes('<item')) {
    const rssOffers = parseRssOffers(text, candidateUrl, slug);
    if (rssOffers.length > 0) {
      return rssOffers;
    }
  }

  // Generic fallback: if we have substantial content, return placeholder
  if (text.length > 200) {
    return [{
      company: slug,
      title: '(offres disponibles)',
      location: '(voir la page)',
      url: candidateUrl
    }];
  }

  return [];
};

module.exports.isValidResponse = isValidResponse;
