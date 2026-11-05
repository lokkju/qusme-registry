import { main, snapshotCommand } from '../src/commands.ts';
import { layout } from '../src/layout.ts';

process.exitCode = await main(snapshotCommand, layout(), process.argv.slice(2));
