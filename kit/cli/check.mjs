// npm run check: the rows the site shows when it deploys this code.
import { checkCommand } from "./lib/check.mjs";
import { main } from "./lib/main.mjs";

await main(checkCommand);
