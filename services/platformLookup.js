/**
 * Platform Lookup Service
 * 
 * Handles searching for job postings across multiple recruitment platforms.
 * Probes company URLs, validates responses, parses job offers, and aggregates results.
 * 
 * Supported platforms:
 * - SmartRecruiters: JSON API
 * - Workable: JSON API
 * - Teamtailor: RSS feeds
 * - TalentView: Custom JSON API
 */

const { fetchWithTimeout } = require('../lib/http');
const { extractOffersFromBody, isValidResponse } = require('../lib/parsers');
const PREDEFINED_COMPANIES = require('../config/companies');

// ============================================================================
// Constants
// ============================================================================

// Delay between request batches to avoid rate limiting
const BATCH_DELAY_MS = 300;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep helper for batch processing delays
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise} Resolves after the specified delay
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


/**
 * Test if a URL contains valid job posting data
 * 
 * Fetches the URL and validates the response:
 * - HTTP status must be 2xx
 * - Response body must pass generic validation (substantial content)
 * 
 * @param {string} url - URL to probe
 * @param {string} platform - Platform name (for logging)
 * @param {number} timeout - Request timeout in milliseconds
 * @returns {Promise<object>} { ok: boolean, text?: string, error?: string }
 */
async function probeUrl(url, platform, timeout) {
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'JobFinder/1.0' },
      timeout
    });

    if (response && response.ok) {
      const text = await response.text();
      
      // Validate response content is substantial
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

/**
 * Process a single company slug: probe its URL and collect results
 * 
 * @param {string} slug - Company slug to look up
 * @param {number} timeout - Request timeout in milliseconds
 * @param {function} progress - Optional callback for progress updates
 * @returns {Promise<object>} Lookup result with structure:
 *   - found: boolean
 *   - slug: string
 *   - platform?: string
 *   - url?: string
 *   - body?: string
 *   - errors?: array
 */
async function processSlug(slug, timeout, progress) {
  const lowerSlug = String(slug || '').toLowerCase();
  const errors = [];

  // Check if this company is in our predefined list
  if (PREDEFINED_COMPANIES[lowerSlug]) {
    const config = PREDEFINED_COMPANIES[lowerSlug];
    const result = await probeUrl(config.url, config.platform, timeout);

    if (result.ok) {
      if (typeof progress === 'function') {
        progress({
          slug,
          platform: config.platform,
          state: 'found',
          url: config.url
        });
      }

      return {
        slug,
        found: true,
        platform: config.platform,
        url: config.url,
        body: result.text
      };
    }

    if (result.error) {
      errors.push(`${config.platform}: ${result.error}`);
    }
  }

  // Company not found or URL probe failed
  if (typeof progress === 'function') {
    progress({ slug, state: 'not_found' });
  }

  return { slug, found: false, errors };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Lookup an array of company slugs and fetch their job postings
 * 
 * Normalizes input, processes slugs concurrently (with batching to avoid rate limits),
 * parses job offers from responses, and formats results for Gemini API consumption.
 * 
 * @param {array|string} slugs - Company slugs to look up (array or newline-separated string)
 * @param {object} options - Configuration options
 *   - timeout: Request timeout in ms (default: 8000)
 *   - concurrency: Max concurrent requests per batch (default: 2)
 *   - onProgress: Callback function(event) for progress updates
 *   - showProgress: Log progress to console if onProgress not provided (default: false)
 * 
 * @returns {Promise<object>} {
 *   lookupResults: array of { slug, status, url? }
 *   promptAppend: formatted string of job offers for AI prompt
 * }
 */
module.exports.lookupSlugs = async function lookupSlugs(slugs, options = {}) {
  const timeout = options.timeout || 8000;
  const onProgress = options.onProgress || null;

  // Normalize input: convert to array of unique slugs
  const normalized = Array.isArray(slugs)
    ? slugs.map(s => String(s || '').trim()).filter(Boolean)
    : String(slugs || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // Helper to report progress
  const writeProgress = (info) => {
    if (onProgress) {
      onProgress(info);
    } else if (options.showProgress) {
      console.log(`${info.slug} - ${info.state} (${info.platform || 'N/A'})`);
    }
  };

  const results = [];
  const concurrency = options.concurrency || 2;

  // Process slugs in batches to avoid overwhelming remote servers
  // Each batch includes up to `concurrency` concurrent requests
  for (let i = 0; i < normalized.length; i += concurrency) {
    const batch = normalized.slice(i, i + concurrency);

    // Execute batch concurrently
    const batchPromises = batch.map(slug => {
      writeProgress({ slug, state: 'looking', platform: 'auto-detect' });
      return processSlug(slug, timeout, writeProgress)
        .catch(err => ({ slug, found: false, error: err.message }));
    });

    results.push(...(await Promise.all(batchPromises)));

    // Pause between batches (except after the last batch)
    if (i + concurrency < normalized.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Format results summary
  const lookupResults = results.map(r => {
    if (!r.found) {
      let status = 'URL not found';
      if (r.error) {
        status = `Error: ${r.error}`;
      } else if (r.errors && r.errors.length > 0) {
        status = `API failures: ${r.errors.join('; ')}`;
      }
      return { slug: r.slug, status };
    }
    return { slug: r.slug, status: `found on ${r.platform}`, url: r.url };
  });

  // Format job offers for AI prompt
  let promptAppend = '';

  for (const r of results) {
    if (r.found) {
      // Try to extract structured job offers
      const offers = extractOffersFromBody(r.platform, r.body, r.url, r.slug);

      if (offers.length > 0) {
        // Format extracted offers
        const formattedOffers = offers
          .map(o => `- ${o.title} (${o.location}) ==> ${o.url}`)
          .join('\n');
        promptAppend += `\n\nJob openings at ${r.slug} via ${r.platform}:\n${formattedOffers}`;
      } else {
        // Fallback: include raw content snippet if parsing failed
        const snippet = (r.body || '').slice(0, 3000);
        promptAppend += `\n\nRaw content from ${r.platform} for ${r.slug} (${r.url}):\n${snippet}`;
      }
    }
  }

  // Append lookup summary
  const summary = lookupResults
    .map(r => `${r.slug}: ${r.status}${r.url ? ' -> ' + r.url : ''}`)
    .join('\n');

  if (summary) {
    promptAppend += `\n\nURL lookup summary:\n${summary}`;
  }

  return { lookupResults, promptAppend };
};
