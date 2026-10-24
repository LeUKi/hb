// npm run replay -- judge-records-xxx.json: the full records, judged again and compared.

import { main } from "./lib/main.mjs";
import { replayCommand } from "./lib/replay.mjs";

await main(replayCommand);
