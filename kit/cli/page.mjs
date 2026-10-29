// npm run page: the 假红包页 for page/ (or a folder given, like examples/number-bomb); --cooldown, --port, --live.

import { main } from "./lib/main.mjs";
import { pageCommand } from "./lib/page.mjs";

await main(pageCommand);
