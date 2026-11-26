#!/usr/bin/env node
import { EXIT } from './exit-codes.ts';
import { main } from './main.ts';

try {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} catch (error) {
  // An unexpected error means the command did not run. That is never a pass.
  console.error(`gotreceipts: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT.CANNOT_RUN;
}
