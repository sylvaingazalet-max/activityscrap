/**
 * Event Parsers
 *
 * This module provides parsers for extracting event information from various
 * city website content. Content is fetched via JinaAI which returns clean
 * markdown-formatted text.
 *
 * Event Format:
 * {
 *   title: string - Event name
 *   date: string - Event date/time
 *   location: string - Event location
 *   category: string - Event category (Concert, Exposition, etc.)
 *   description: string - Event description
 *   url: string - Link to event details
 * }
 *
 * Parsing Strategy:
 * 1. Try markdown parsing first (JinaAI returns markdown by default)
 * 2. Fallback to generic text parsing if markdown parsing returns no results
 * 3. Validate response is substantial before processing
 */

const logger = require('./logger');
const contextLog = logger.createLogger('lib/parsers');

const MAX_EVENTS_EXTRACT = 200;

/**
 * Generic validation: check if response body is substantial enough
 * @param {string} text - Response body text
 * @returns {boolean} True if response appears to contain valid data
 */
function isValidResponse(text) {
  const isValid = typeof text === 'string' && text.trim().length > 100;

  if (!isValid) {
    contextLog.debug('Invalid response detected', {
      isString: typeof text === 'string',
      length: text ? text.trim().length : 0
    });
  }

  return isValid;
}

/**
 * Extract events from markdown-formatted content (from JinaAI)
 *
 * Parses event information from markdown content, looking for common event
 * patterns like dates, titles, and descriptions.
 *
 * @param {string} text - Markdown content from JinaAI
 * @param {string} sourceUrl - Source URL for fallback
 * @returns {array} Array of event objects
 */
function parseMarkdownEvents(text, sourceUrl) {
  const events = [];

  if (!text || typeof text !== 'string') {
    contextLog.debug('No text provided for markdown parsing');
    return events;
  }

  // Split by common event delimiters (headers, horizontal rules)
  const lines = text.split('\n');
  let currentEvent = null;

  contextLog.debug('Starting markdown parsing', { lineCount: lines.length });

  for (let i = 0; i < lines.length && events.length < MAX_EVENTS_EXTRACT; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) continue;

    // Look for event headers (markdown headers)
    if (line.startsWith('##') || line.startsWith('###')) {
      // Save previous event if exists
      if (currentEvent && currentEvent.title) {
        events.push(currentEvent);
      }

      // Start new event
      currentEvent = {
        title: line.replace(/^#+\s*/, '').trim(),
        date: '',
        location: '',
        category: '',
        description: '',
        url: sourceUrl
      };
      continue;
    }

    if (!currentEvent) {
      currentEvent = {
        title: '',
        date: '',
        location: '',
        category: '',
        description: '',
        url: sourceUrl
      };
    }

    // Look for date patterns (common formats)
    if (line.match(/\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4}/)) {
      currentEvent.date = line.match(/[\d\s\/\-]+/)[0];
    }

    // Look for location indicators
    if (line.match(/📍|location|lieu|adresse|venue/i)) {
      currentEvent.location = line.replace(/📍|location|lieu|adresse|venue|\*\*|\*|:/gi, '').trim();
    }

    // Look for category/type indicators
    if (line.match(/\[.*\]|•|○/) && !currentEvent.category) {
      const categoryMatch = line.match(/\[([^\]]+)\]/);
      if (categoryMatch) {
        currentEvent.category = categoryMatch[1];
      }
    }

    // Build description from remaining lines
    if (currentEvent.title && line.length > 10 && !line.startsWith('##')) {
      if (currentEvent.description.length < 200) {
        currentEvent.description += (currentEvent.description ? ' ' : '') + line;
      }
    }
  }

  // Add last event if exists
  if (currentEvent && currentEvent.title) {
    events.push(currentEvent);
  }

  const filteredEvents = events.filter(e => e.title && e.title.length > 0);
  contextLog.debug('Markdown parsing completed', {
    eventsFound: filteredEvents.length,
    maxExtract: MAX_EVENTS_EXTRACT
  });

  return filteredEvents;
}

/**
 * Extract events from HTML-like structures (fallback)
 * Looks for common event indicators in unformatted text
 *
 * @param {string} text - Raw text content
 * @param {string} sourceUrl - Source URL for fallback
 * @returns {array} Array of event objects
 */
function parseGenericEvents(text, sourceUrl) {
  const events = [];

  // Split by common line breaks and punctuation
  const lines = text.split(/\n|;\|/);

  contextLog.debug('Starting generic parsing', { lineCount: lines.length });

  for (let i = 0; i < Math.min(MAX_EVENTS_EXTRACT, lines.length); i++) {
    const line = lines[i].trim();

    // Skip short or empty lines
    if (line.length < 5) continue;

    // Look for lines that might be event titles
    // (not too long, no common word indicators)
    if (line.length < 100 && !line.match(/^(the|and|or|but|this|that|about|from|with)/i)) {
      events.push({
        title: line,
        date: '',
        location: '',
        category: 'Event',
        description: '',
        url: sourceUrl
      });

      if (events.length >= MAX_EVENTS_EXTRACT) break;
    }
  }

  contextLog.debug('Generic parsing completed', { eventsFound: events.length });
  return events;
}

/**
 * Main parser function: extract events from website content
 *
 * Implements fallback strategy:
 * 1. First tries markdown parsing (best for JinaAI extracted content)
 * 2. If no events found, falls back to generic text parsing
 *
 * @param {string} text - Content from JinaAI (markdown formatted)
 * @param {string} sourceUrl - Source URL
 * @returns {array} Array of event objects
 */
module.exports.extractEventsFromBody = function extractEventsFromBody(text, sourceUrl) {
  if (!text || typeof text !== 'string') {
    contextLog.debug('Empty or invalid text provided for extraction');
    return [];
  }

  contextLog.debug('Starting event extraction', {
    sourceUrl,
    textLength: text.length
  });

  // Try markdown parsing first (JinaAI returns markdown)
  const markdownEvents = parseMarkdownEvents(text, sourceUrl);
  if (markdownEvents.length > 0) {
    contextLog.info('Events extracted via markdown parser', {
      count: markdownEvents.length,
      sourceUrl
    });
    return markdownEvents;
  }

  // Fallback: generic text parsing
  contextLog.debug('Markdown parsing returned no results, trying generic parser');
  const genericEvents = parseGenericEvents(text, sourceUrl);

  if (genericEvents.length > 0) {
    contextLog.info('Events extracted via generic parser', {
      count: genericEvents.length,
      sourceUrl
    });
  } else {
    contextLog.warn('No events extracted from content', { sourceUrl });
  }

  return genericEvents;
};

/**
 * Legacy export for compatibility with existing code
 * Maps old function names to new ones
 */
module.exports.extractOffersFromBody = function(platform, text, url, slug) {
  // Convert to events
  return module.exports.extractEventsFromBody(text, url);
};

module.exports.isValidResponse = isValidResponse;
