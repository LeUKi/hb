import { app } from "./app";

export { ActivityDO, MerchantDO } from "./durable-objects";

import { handleQueueMessage } from "./queue";
import { runScheduled } from "./scheduled";

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    await Promise.all(
      batch.messages.map((message) => handleQueueMessage(message, env)),
    );
  },

  async scheduled(event, env, ctx) {
    await runScheduled(event, env, ctx);
  },
} satisfies ExportedHandler<CloudflareEnv, unknown>;
