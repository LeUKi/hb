// npm run simulate: the people in simulate.json (or a file given) claim one by one; --seed changes the seed.

import { main } from "./lib/main.mjs";
import { simulateCommand } from "./lib/simulate.mjs";

await main(simulateCommand);
