#!/usr/bin/env node

// The `wairon` binary: clean up after a self-update, then parse argv with the command tree
// that ./program.ts defines (cli_portal).
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { cleanStaleBinary } from '../commands/update.js';
import { buildProgram } from './program.js';

// Clean up any .old binary left over from a previous Windows self-update
cleanStaleBinary();

const program = buildProgram();

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Whatever a command throws reaches the user as ONE line: a WaironError's
    // message as it is, any other error's message the same way. The stack is a
    // bug report's business, printed only when WAIRON_DEBUG is set.
    if (err instanceof WaironError) {
      logger.error(err.message);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message || String(err));
      if (process.env.WAIRON_DEBUG && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  }
}

main();
