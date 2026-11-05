import { main, validateCommand } from '../src/commands.ts';
import { layout } from '../src/layout.ts';

process.exitCode = await main(validateCommand, layout(), process.argv.slice(2));
