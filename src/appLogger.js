'use strict';

/**
 * Standard Application Logger
 * Provides structured log outputs prefixed with timestamps, levels, and contextual modules.
 */

const getFormattedTimestamp = () => new Date().toISOString();

const writeLog = (level, context, text, payload) => {
  const prefix = `[${getFormattedTimestamp()}] [${level}] [${context}] ${text}`;
  if (payload !== undefined) {
    const formattedPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    console.log(`${prefix} - Data: ${formattedPayload}`);
  } else {
    console.log(prefix);
  }
};

module.exports = {
  info: (context, text, payload) => writeLog('INFO', context, text, payload),
  warn: (context, text, payload) => writeLog('WARN', context, text, payload),
  error: (context, text, payload) => writeLog('ERROR', context, text, payload),
};
