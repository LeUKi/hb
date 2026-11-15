import { app } from "./app";
import type { ApiBindings } from "./env";

export { ActivityDO, MerchantDO } from "./durable-objects";
// 代码判定联网: the loopback a 联网 红包's 判定器 goes out through.
export { JudgeGateway } from "./judge/gateway";

import { handleNoticeBatch } from "./notices/outbox";
import { handleQueueMessage } from "./queue";
import { runScheduled } from "./scheduled";

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    // 私信通知 have their own queue: one SMTP session a batch.
    if (batch.queue.includes("notices")) {
      await handleNoticeBatch(batch, env);
      return;
    }
    await Promise.all(
      batch.messages.map((message) => handleQueueMessage(message, env)),
    );
  },

  async scheduled(event, env, ctx) {
    await runScheduled(event, env, ctx);
  },
} satisfies ExportedHandler<ApiBindings, unknown>;
