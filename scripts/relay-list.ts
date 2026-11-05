import { main, relayListCommand } from '../src/commands.ts';
import { layout } from '../src/layout.ts';

process.exitCode = await main(relayListCommand, layout(), process.argv.slice(2));
