import { keygenCommand, main } from '../src/commands.ts';
import { layout } from '../src/layout.ts';

process.exitCode = await main(keygenCommand, layout(), process.argv.slice(2));
