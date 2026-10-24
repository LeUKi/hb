// npm test: every test in tests.json; `npm test -- 名字` runs only those whose names have it.

import { main } from "./lib/main.mjs";
import { testCommand } from "./lib/test.mjs";

await main(testCommand);
