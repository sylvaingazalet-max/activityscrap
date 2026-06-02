/**
 * HTTP Utilities
 * 
 * Provides fetch wrapper with timeout support.
 * Useful for ensuring API calls don't hang indefinitely.
 */

/**
 * Fetch with timeout support
 * 
 * Wraps the native fetch() function with an AbortController to enforce timeouts.
 * If the request takes longer than the specified timeout, it's aborted.
 * 
 * @param {string} url - URL to fetch
 * @param {object} opts - Fetch options
 *   - timeout: Timeout in milliseconds (default: 10000)
 *   - method: HTTP method (default: GET)
 *   - headers: Request headers
 *   - body: Request body
 *   - other: Any standard fetch() options
 * 
 * @returns {Promise<Response>} Fetch response object
 * @throws {Error} If request times out or fetch fails
 */
module.exports.fetchWithTimeout = async function fetchWithTimeout(url, opts = {}) {
  const timeout = opts.timeout || 10000;

  // Create abort controller for timeout support
  // (AbortController is available in modern Node.js and browsers)
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;

  // Setup timeout to abort the request
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    // Perform the fetch with the abort signal
    const res = await fetch(url, { ...opts, signal });

    // Clear the timeout on success
    if (timer) clearTimeout(timer);

    return res;
  } catch (err) {
    // Clear the timeout on error
    if (timer) clearTimeout(timer);

    // Re-throw the error (could be timeout or network error)
    throw err;
  }
};
