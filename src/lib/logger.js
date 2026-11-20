'use strict';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let currentLevel = LEVELS[process.env.LOG_LEVEL] !== undefined ? LEVELS[process.env.LOG_LEVEL] : LEVELS.info;

function setLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

function write(level, stream, args) {
  if (LEVELS[level] > currentLevel) return;
  // eslint-disable-next-line no-console
  console[stream](...args);
}

const log = {
  setLevel,
  error: (...args) => write('error', 'error', args),
  warn: (...args) => write('warn', 'warn', args),
  info: (...args) => write('info', 'log', args),
  debug: (...args) => write('debug', 'log', args)
};

module.exports = log;
