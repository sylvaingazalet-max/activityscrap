/**
 * Logging Utility
 *
 * Centralized logging module providing structured logging with context information.
 * Supports different log levels and automatic formatting.
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('message', { key: 'value' });
 *   logger.error('error message', error);
 */

/**
 * Get current timestamp in ISO format
 * @returns {string} ISO format timestamp
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Format log entry with context
 * @param {string} level - Log level (INFO, ERROR, WARN, DEBUG)
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object|Error} data - Additional data or error
 * @returns {object} Formatted log object
 */
function formatLogEntry(level, context, message, data) {
  const entry = {
    timestamp: getTimestamp(),
    level,
    context,
    message
  };

  if (data instanceof Error) {
    entry.error = {
      message: data.message,
      stack: data.stack
    };
  } else if (data) {
    entry.data = data;
  }

  return entry;
}

/**
 * Log at INFO level
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Optional data
 */
function info(context, message, data) {
  const entry = formatLogEntry('INFO', context, message, data);
  console.log(JSON.stringify(entry));
}

/**
 * Log at ERROR level
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {Error|object} error - Error object or data
 */
function error(context, message, error) {
  const entry = formatLogEntry('ERROR', context, message, error);
  console.error(JSON.stringify(entry));
}

/**
 * Log at WARN level
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Optional data
 */
function warn(context, message, data) {
  const entry = formatLogEntry('WARN', context, message, data);
  console.warn(JSON.stringify(entry));
}

/**
 * Log at DEBUG level (only in development)
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Optional data
 */
function debug(context, message, data) {
  if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
    const entry = formatLogEntry('DEBUG', context, message, data);
    console.debug(JSON.stringify(entry));
  }
}

/**
 * Create a scoped logger for a specific context
 * @param {string} context - Context/module name
 * @returns {object} Logger object with context pre-filled
 */
function createLogger(context) {
  return {
    info: (message, data) => info(context, message, data),
    error: (message, err) => error(context, message, err),
    warn: (message, data) => warn(context, message, data),
    debug: (message, data) => debug(context, message, data)
  };
}

module.exports = {
  info,
  error,
  warn,
  debug,
  createLogger,
  getTimestamp
};
