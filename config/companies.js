/**
 * Event Sources Configuration
 *
 * Centralized configuration for scraping events from multiple official websites.
 * Each source is configured with:
 * - name: Human-readable name for logging and display
 * - source: Organization name
 * - url: Target URL to scrape (supports pagination via (offset) placeholder)
 * - parser: Parser type to use ('jina' for JinaAI extraction)
 * - timeout: Request timeout in milliseconds
 *
 * Usage:
 * - New sources can be added here and will automatically be picked up by lookupSlugs()
 * - The system handles pagination via (offset) placeholder in URLs
 * - Each source is fetched concurrently (with rate limiting)
 *
 * Future Enhancement:
 * - Load from environment variables or database for dynamic configuration
 * - Support for authentication if sources require it
 */

module.exports = {
  // ============================================================================
  // Lille Events
  // ============================================================================
  // Main source for events in Lille, France
  lille: {
    name: 'Lille Events',
    source: 'Ville de Lille (Official)',
    url: 'https://www.lille.fr/Evenements/(offset)/0',
    parser: 'jina',
    timeout: 10000,
    enabled: true,
    description: 'Official city events from Lille municipality'
  },

  // Additional offset for pagination testing
  lilleOffset10: {
    name: 'Lille Events (Page 2)',
    source: 'Ville de Lille (Official)',
    url: 'https://www.lille.fr/Evenements/(offset)/10',
    parser: 'jina',
    timeout: 10000,
    enabled: false, // Set to true to enable pagination
    description: 'Official city events from Lille municipality (page 2, offset 10)'
  },

  lilleOffset20: {
    name: 'Lille Events (Page 3)',
    source: 'Ville de Lille (Official)',
    url: 'https://www.lille.fr/Evenements/(offset)/20',
    parser: 'jina',
    timeout: 10000,
    enabled: false, // Set to true to enable pagination
    description: 'Official city events from Lille municipality (page 3, offset 20)'
  },

  // ============================================================================
  // Future Event Sources (Templates for expansion)
  // ============================================================================
  // These are template configurations ready to be enabled when sources are added

  // Paris Events - Template
  /*
  paris: {
    name: 'Paris Events',
    source: 'Ville de Paris (Official)',
    url: 'https://www.paris.fr/pages/evenements-loisirs-58',
    parser: 'jina',
    timeout: 10000,
    enabled: false,
    description: 'Official city events from Paris municipality'
  },

  // Brussels Events - Template
  brussels: {
    name: 'Bruxelles Events',
    source: 'Ville de Bruxelles (Official)',
    url: 'https://www.bruxelles.be/agenda-des-activites',
    parser: 'jina',
    timeout: 10000,
    enabled: false,
    description: 'Official city events from Brussels municipality'
  },

  // Antwerp Events - Template
  antwerp: {
    name: 'Antwerpen Events',
    source: 'Stad Antwerpen (Official)',
    url: 'https://www.antwerpen.be/agenda',
    parser: 'jina',
    timeout: 10000,
    enabled: false,
    description: 'Official city events from Antwerp municipality'
  },
  */
};
