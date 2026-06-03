/**
 * Event Lookup Service
 *
 * Handles fetching events from multiple configured event sources using JinaAI.
 * JinaAI extracts clean, structured content from web pages without needing direct URL fetching.
 *
 * Supported Sources:
 * - Lille Events: https://www.lille.fr/Evenements/
 * - Additional sources can be configured via config/companies.js
 */

const { fetchWithJinaAI } = require('../lib/http');
const { extractEventsFromBody, isValidResponse } = require('../lib/parsers');
const CONFIG = require('../config/companies');
const logger = require('../lib/logger');

const contextLog = logger.createLogger('services/platformLookup');

// ============================================================================
// Constants
// ============================================================================

// JinaAI endpoint for content extraction
const JINA_AI_ENDPOINT = 'https://r.jina.ai/';

// Maximum concurrent requests to avoid overwhelming sources
const MAX_CONCURRENT_REQUESTS = 3;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Fetch events from a single source using JinaAI for content extraction
 *
 * JinaAI provides clean markdown content from web pages,
 * making it easy to parse and extract structured data without direct fetching.
 *
 * @param {object} source - Source configuration object
 *   - name: Human-readable name
 *   - url: URL to fetch events from
 *   - timeout: Request timeout in milliseconds
 * @param {number} timeout - Request timeout override
 * @param {function} progress - Optional callback for progress updates
 * @returns {Promise<object>} {
 *   ok: boolean,
 *   sourceName: string,
 *   sourceUrl: string,
 *   text?: string,
 *   error?: string
 * }
 */
async function fetchEventFromSingleSource(source, timeout, progress) {
  const sourceName = source.name || 'Unknown Source';

  try {
    contextLog.debug('Fetching from source', { sourceName, url: source.url });

    if (typeof progress === 'function') {
      progress({ state: 'fetching', source: sourceName });
    }

    // Use JinaAI to extract clean content
    const response = await fetchWithJinaAI(source.url, {
      timeout: timeout || source.timeout || 8000
    });

    if (response && response.ok) {
      const text = await response.text();

      // Validate response content is substantial
      if (!isValidResponse(text)) {
        contextLog.warn('Invalid response from source', {
          sourceName,
          contentLength: text ? text.length : 0
        });
        return { ok: false, sourceName, sourceUrl: source.url };
      }

      contextLog.info('Successfully fetched from source', {
        sourceName,
        contentLength: text.length
      });

      return { ok: true, sourceName, sourceUrl: source.url, text };
    }

    contextLog.warn('HTTP error from source', {
      sourceName,
      status: response ? response.status : 'unknown'
    });
    return { ok: false, sourceName, sourceUrl: source.url };
  } catch (err) {
    contextLog.error('Error fetching from source', {
      sourceName,
      error: err.message
    });
    return {
      ok: false,
      sourceName,
      sourceUrl: source.url,
      error: err.message || String(err)
    };
  }
}

/**
 * Fetch events from multiple sources concurrently
 *
 * Manages concurrent requests to avoid overwhelming the sources,
 * while collecting results from all available sources.
 *
 * @param {array} sources - Array of source configuration objects
 * @param {number} timeout - Request timeout in milliseconds
 * @param {function} progress - Optional progress callback
 * @returns {Promise<array>} Array of fetch results
 */
async function fetchFromMultipleSources(sources, timeout, progress) {
  const results = [];

  contextLog.info('Fetching from multiple sources', {
    sourceCount: sources.length,
    timeout
  });

  // Process sources in batches to limit concurrency
  for (let i = 0; i < sources.length; i += MAX_CONCURRENT_REQUESTS) {
    const batch = sources.slice(i, i + MAX_CONCURRENT_REQUESTS);
    const batchResults = await Promise.all(
      batch.map(source => fetchEventFromSingleSource(source, timeout, progress))
    );
    results.push(...batchResults);
  }

  return results;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch and aggregate events from all configured sources
 *
 * Retrieves events from multiple configured sources and extracts
 * structured event information, then aggregates results.
 *
 * @param {any} unused - Parameter kept for compatibility but not used
 * @param {object} options - Configuration options
 *   - timeout: Request timeout in ms (default: 8000)
 *   - onProgress: Callback function(event) for progress updates
 *   - showProgress: Log progress to console if onProgress not provided (default: false)
 *   - sources: Array of specific sources to use (default: all from config)
 *
 * @returns {Promise<object>} {
 *   events: array of extracted events with structure { title, date, description, url, category }
 *   promptAppend: formatted string of events for AI prompt
 *   sources: array of source metadata
 * }
 */
module.exports.lookupSlugs = async function lookupSlugs(unused, options = {}) {
  const timeout = options.timeout || 8000;
  const onProgress = options.onProgress || null;

  // Helper to report progress
  const writeProgress = (info) => {
    if (onProgress) {
      onProgress(info);
    } else if (options.showProgress) {
      contextLog.info('Progress', info);
    }
  };

  try {
    // Get sources to use
    let sources = options.sources || getAllConfiguredSources();

    if (!sources || sources.length === 0) {
      contextLog.warn('No sources configured');
      writeProgress({ state: 'warning', message: 'No event sources configured' });
      return { events: [], promptAppend: '', sources: [] };
    }

    contextLog.info('Lookup starting', { sourceCount: sources.length });
    writeProgress({ state: 'starting', sourceCount: sources.length });

    // Fetch from all sources concurrently (with rate limiting)
    const fetchResults = await fetchFromMultipleSources(sources, timeout, writeProgress);

    // Process results and extract events from successful responses
    const allEvents = [];
    const sourceMetadata = [];

    for (const result of fetchResults) {
      if (result.ok && result.text) {
        const events = extractEventsFromBody(result.text, result.sourceUrl);
        allEvents.push(...events);

        sourceMetadata.push({
          name: result.sourceName,
          url: result.sourceUrl,
          eventCount: events.length,
          status: 'success'
        });

        contextLog.info('Extracted events from source', {
          sourceName: result.sourceName,
          eventCount: events.length
        });

        writeProgress({
          state: 'found',
          source: result.sourceName,
          eventCount: events.length
        });
      } else {
        sourceMetadata.push({
          name: result.sourceName,
          url: result.sourceUrl,
          eventCount: 0,
          status: 'failed',
          error: result.error
        });

        contextLog.warn('Failed to fetch from source', {
          sourceName: result.sourceName,
          error: result.error
        });

        writeProgress({
          state: 'failed',
          source: result.sourceName,
          error: result.error
        });
      }
    }

    // Format events for AI prompt
    let promptAppend = '';

    if (allEvents && allEvents.length > 0) {
      const formattedEvents = allEvents
        .slice(0, 50) // Limit to first 50 events for prompt size
        .map(e => {
          const parts = [`- ${e.title}`];
          if (e.date) parts.push(`(Date: ${e.date})`);
          if (e.category) parts.push(`[${e.category}]`);
          if (e.location) parts.push(`📍 ${e.location}`);
          return parts.join(' ');
        })
        .join('\n');

      promptAppend = `\n\nUpcoming Events (${allEvents.length} total from ${sourceMetadata.filter(s => s.status === 'success').length} source(s)):\n${formattedEvents}`;

      if (allEvents.length > 50) {
        promptAppend += `\n\n... and ${allEvents.length - 50} more events`;
      }

      contextLog.info('Lookup completed successfully', {
        totalEvents: allEvents.length,
        sourcesSuccess: sourceMetadata.filter(s => s.status === 'success').length
      });
    } else {
      promptAppend = '\n\nNo events currently found from any configured sources.';
      contextLog.warn('No events found from any source');
    }

    return { events: allEvents, promptAppend, sources: sourceMetadata };
  } catch (err) {
    contextLog.error('Lookup failed with error', err);
    throw err;
  }
};

/**
 * Get all configured event sources from config
 *
 * Reads configuration and returns array of all enabled configured sources
 *
 * @returns {array} Array of source configuration objects (enabled only)
 */
function getAllConfiguredSources() {
  if (!CONFIG || typeof CONFIG !== 'object') {
    contextLog.warn('Configuration not available or invalid');
    return [];
  }

  const sources = [];

  // Iterate through all config entries and collect enabled sources
  for (const [key, source] of Object.entries(CONFIG)) {
    if (source && typeof source === 'object' && source.name && source.url) {
      // Only include sources that are explicitly enabled or don't have an enabled flag
      const isEnabled = source.enabled !== false; // Default to true if not specified

      if (isEnabled) {
        sources.push({
          name: source.name,
          url: source.url,
          timeout: source.timeout,
          parser: source.parser,
          key: key
        });
      }
    }
  }

  contextLog.debug('Loaded configured sources', { count: sources.length });
  return sources;
}

/**
 * Get a specific source by key
 * @param {string} sourceKey - Key of the source in config
 * @returns {object|null} Source configuration or null
 */
module.exports.getSource = function(sourceKey) {
  if (!CONFIG || !CONFIG[sourceKey]) {
    return null;
  }
  return CONFIG[sourceKey];
};

/**
 * Get all available sources
 * @returns {array} Array of all configured sources
 */
module.exports.getAllSources = function() {
  return getAllConfiguredSources();
};
