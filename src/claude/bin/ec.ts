import { main } from '../src/cli/main.ts';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => { process.stderr.write(String(e instanceof Error ? e.message : e) + '\n'); process.exitCode = 1; },
);
