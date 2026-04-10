import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Simple leveled logger for CLI output
// ---------------------------------------------------------------------------

export type LogLevel = 'silent' | 'info' | 'verbose';

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  if (currentLevel === 'silent') return false;
  if (currentLevel === 'info') return level === 'info';
  return true; // verbose: log everything
}

export const logger = {
  info(message: string): void {
    if (shouldLog('info')) {
      console.log(chalk.cyan('ℹ') + '  ' + message);
    }
  },

  success(message: string): void {
    if (shouldLog('info')) {
      console.log(chalk.green('✔') + '  ' + message);
    }
  },

  warn(message: string): void {
    if (shouldLog('info')) {
      console.warn(chalk.yellow('⚠') + '  ' + chalk.yellow(message));
    }
  },

  error(message: string): void {
    // Errors always surface regardless of level
    console.error(chalk.red('✖') + '  ' + chalk.red(message));
  },

  verbose(message: string): void {
    if (shouldLog('verbose')) {
      console.log(chalk.gray('·') + '  ' + chalk.gray(message));
    }
  },

  /**
   * Print a blank line — use sparingly for visual separation.
   */
  blank(): void {
    if (currentLevel !== 'silent') console.log();
  },

  /**
   * Print a section header.
   */
  header(title: string): void {
    if (currentLevel !== 'silent') {
      console.log();
      console.log(chalk.bold.white(title));
      console.log(chalk.gray('─'.repeat(title.length)));
    }
  },
};
