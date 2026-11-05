import { main, publishEventsCommand } from '../src/commands.ts';
import { layout } from '../src/layout.ts';

process.exitCode = await main(publishEventsCommand, layout(), process.argv.slice(2));
