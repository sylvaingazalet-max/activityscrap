/**
 * Database Initialization and Management
 *
 * Handles Prisma client initialization with logging.
 * Maintains connection for future use even if not currently needed.
 *
 * Usage:
 *   const { getPrismaClient, getConnectionStatus } = require('../lib/prismaClient');
 *   const prisma = getPrismaClient();
 */

const logger = require('./logger');
const contextLog = logger.createLogger('lib/prismaClient');

let prismaClient = null;
let connectionStatus = 'not-initialized';

/**
 * Initialize Prisma client if not already initialized
 * @returns {Promise<object>} Prisma client instance
 */
async function initializePrismaClient() {
  if (prismaClient) {
    contextLog.debug('Prisma client already initialized');
    return prismaClient;
  }

  try {
    contextLog.info('Initializing Prisma client');

    // Dynamically require Prisma client
    // This allows the module to be imported even if Prisma is not yet installed
    // eslint-disable-next-line global-require
    const { PrismaClient } = require('@prisma/client');

    prismaClient = new PrismaClient({
      log: [
        {
          emit: 'event',
          level: 'query'
        },
        {
          emit: 'event',
          level: 'info'
        },
        {
          emit: 'event',
          level: 'warn'
        },
        {
          emit: 'event',
          level: 'error'
        }
      ]
    });

    // Set up logging for Prisma queries
    prismaClient.$on('query', (e) => {
      contextLog.debug('Prisma Query', {
        query: e.query,
        duration: `${e.duration}ms`
      });
    });

    prismaClient.$on('error', (e) => {
      contextLog.error('Prisma Error', e);
    });

    prismaClient.$on('warn', (e) => {
      contextLog.warn('Prisma Warning', e);
    });

    // Test connection
    await prismaClient.$queryRaw`SELECT 1`;

    connectionStatus = 'connected';
    contextLog.info('Prisma client initialized and connected successfully');

    return prismaClient;
  } catch (err) {
    connectionStatus = 'error';
    contextLog.error('Failed to initialize Prisma client', err);
    throw err;
  }
}

/**
 * Get Prisma client instance (initializes if needed)
 * @returns {Promise<object>} Prisma client instance
 */
async function getPrismaClient() {
  if (!prismaClient) {
    await initializePrismaClient();
  }
  return prismaClient;
}

/**
 * Get Prisma client synchronously (returns null if not initialized)
 * @returns {object|null} Prisma client instance or null
 */
function getPrismaClientSync() {
  return prismaClient;
}

/**
 * Get database connection status
 * @returns {string} Connection status: 'not-initialized', 'connected', 'error'
 */
function getConnectionStatus() {
  return connectionStatus;
}

/**
 * Disconnect Prisma client
 */
async function disconnect() {
  if (prismaClient) {
    try {
      contextLog.info('Disconnecting Prisma client');
      await prismaClient.$disconnect();
      connectionStatus = 'disconnected';
      contextLog.info('Prisma client disconnected successfully');
    } catch (err) {
      contextLog.error('Error disconnecting Prisma client', err);
      throw err;
    }
  }
}

module.exports = {
  getPrismaClient,
  getPrismaClientSync,
  getConnectionStatus,
  initializePrismaClient,
  disconnect
};
