// /api/open/openapi.json: the open API (docs/balance-design.md §16) for
// sites to read or generate code from. The page /help/api says the same in
// words; keep the two together when either changes.
import { BALANCE_LIMITS } from "@hb/contracts";

const amount = {
  type: "string",
  pattern: "^(0|[1-9]\\d{0,13})(\\.\\d{1,2})?$",
  description: 'LDC（1 🐟 = 1 LDC），最多两位小数，比如 "10.00"',
  example: "10.00",
};

const userId = {
  type: "string",
  pattern: "^[1-9][0-9]{0,18}$",
  description: "LINUX DO 数字 ID",
  example: "12345",
};

const transferItem = {
  type: "object",
  additionalProperties: false,
  required: ["outTransferNo", "toUserId", "toUsername", "amount"],
  properties: {
    outTransferNo: {
      type: "string",
      pattern: "^[\\x21-\\x7e]{1,64}$",
      description:
        "转账单号：你自己定的编号，同一个密钥里每笔不同。同一个单号、同样的内容重发，返回原来那笔，不会重复转。",
      example: "order-123",
    },
    toUserId: userId,
    toUsername: {
      type: "string",
      description: "收款人的 LINUX DO 用户名，要和数字 ID 对得上",
      example: "someone",
    },
    destination: {
      type: "string",
      enum: ["balance", "credit"],
      default: "balance",
      description:
        "balance：对方的🐟额，当场到账、不收费；credit：对方的 Credit 账户，和转出一样排队发放（至少 1.00，不超过单笔转出上限，Credit 站可能收分发费）",
    },
    amount,
    remark: {
      type: "string",
      maxLength: BALANCE_LIMITS.transferRemarkMax,
      description: "备注，对方在本站看得到",
    },
  },
};

const party = {
  type: "object",
  required: ["userId", "username"],
  properties: { userId: { type: "string" }, username: { type: "string" } },
};

const transfer = {
  type: "object",
  required: [
    "id",
    "outTransferNo",
    "direction",
    "from",
    "to",
    "destination",
    "amount",
    "remark",
    "status",
    "notSentReason",
    "createdAt",
  ],
  properties: {
    id: {
      type: ["string", "null"],
      description: "本站给的编号，全站唯一；试转时为 null",
    },
    outTransferNo: { type: ["string", "null"] },
    direction: {
      type: "string",
      enum: ["out", "in"],
      description: "相对密钥的主人",
    },
    from: party,
    to: party,
    destination: { type: "string", enum: ["balance", "credit"] },
    amount: { type: "string" },
    remark: { type: ["string", "null"] },
    status: {
      type: "string",
      enum: ["sent", "sending", "not_sent"],
      description:
        "到🐟额的当场就是 sent；到 Credit 的是 sending（发放中）、sent（已发放）或 not_sent（未发出，🐟已退回）",
    },
    notSentReason: {
      type: ["string", "null"],
      enum: ["recipient", "self_payment", "configuration", "validation", null],
    },
    createdAt: { type: "string", format: "date-time" },
    dryRun: { type: "boolean", const: true },
  },
};

const error = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const errors = (codes: string) => ({
  description: codes,
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
});

const json = (schema: unknown, description = "成功") => ({
  description,
  content: { "application/json": { schema } },
});

const transferErrors = {
  "400": errors(
    "INVALID_REQUEST（附 issues）、SELF_TRANSFER、AMOUNT_OUT_OF_RANGE、RECIPIENT_IS_OWNER",
  ),
  "401": errors("INVALID_API_KEY：密钥不对或已停用"),
  "403": errors("TRANSFER_DISABLED、TRANSFER_NOT_ALLOWED、WITHDRAW_DISABLED"),
  "404": errors(
    "RECIPIENT_NOT_FOUND：收款人不存在（要来过本站，数字 ID 和用户名都对得上）",
  ),
  "409": errors(
    "BALANCE_INSUFFICIENT、DAILY_LIMIT_EXCEEDED、OUT_TRANSFER_NO_CONFLICT",
  ),
  "429": errors("RATE_LIMITED，带 Retry-After"),
};

/** The whole document, built once per request (it is small). */
export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "🐟额开放接口",
      version: "1",
      description:
        "开通🐟额 PLUS 的人在🐟额页新建开放接口密钥，用它从自己的服务器转账、查单、看可用和拉流水。只能从服务器调用（不开跨域）。说明见 https://hb.lafi.sh/help/api",
    },
    servers: [{ url: "https://hb.lafi.sh/api/open" }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "Authorization: Bearer hbk_…",
        },
      },
      schemas: { TransferItem: transferItem, Transfer: transfer, Error: error },
    },
    paths: {
      "/balance/transfers": {
        post: {
          summary: "转账",
          description: `每个密钥最近 60 秒最多转 ${BALANCE_LIMITS.apiTransfersPerMinute} 笔；响应带 X-RateLimit-Remaining 和 X-RateLimit-Reset。dryRun 为 true 时只检查、不转。`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/TransferItem" },
                    {
                      type: "object",
                      properties: { dryRun: { type: "boolean" } },
                    },
                  ],
                },
              },
            },
          },
          responses: {
            "200": json({
              type: "object",
              properties: {
                transfer: { $ref: "#/components/schemas/Transfer" },
              },
            }),
            ...transferErrors,
          },
        },
        get: {
          summary: "流水",
          description:
            "转出只有这个密钥转的，转进是别人转给主人🐟额的全部。按时间倒序。",
          parameters: [
            { name: "direction", in: "query", schema: { enum: ["out", "in"] } },
            {
              name: "destination",
              in: "query",
              schema: { enum: ["balance", "credit"] },
            },
            { name: "counterpartUserId", in: "query", schema: userId },
            {
              name: "since",
              in: "query",
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "until",
              in: "query",
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: BALANCE_LIMITS.transferPageMax,
                default: 20,
              },
            },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": json({
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Transfer" },
                },
                nextCursor: { type: ["string", "null"] },
              },
            }),
            "400": errors("INVALID_REQUEST"),
            "401": errors("INVALID_API_KEY"),
            "429": errors("RATE_LIMITED"),
          },
        },
      },
      "/balance/transfers/batch": {
        post: {
          summary: "批量转账",
          description: `一次 1–${BALANCE_LIMITS.transferBatchMax} 笔，按顺序一笔一笔转，各自成败。认证、频率、开关、整体格式不对时整批一个错误，一笔都不转。`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["transfers"],
                  properties: {
                    transfers: {
                      type: "array",
                      minItems: 1,
                      maxItems: BALANCE_LIMITS.transferBatchMax,
                      items: { $ref: "#/components/schemas/TransferItem" },
                    },
                    dryRun: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": json({
              type: "object",
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["outTransferNo"],
                    properties: {
                      outTransferNo: { type: "string" },
                      transfer: { $ref: "#/components/schemas/Transfer" },
                      error: {
                        type: "object",
                        properties: {
                          code: { type: "string" },
                          message: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            }),
            ...transferErrors,
          },
        },
      },
      "/balance/transfers/out/{outTransferNo}": {
        get: {
          summary: "查单（按转账单号）",
          description: "只查这个密钥转的。超时、断线后先查，再决定要不要重发。",
          parameters: [
            {
              name: "outTransferNo",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": json({
              type: "object",
              properties: {
                transfer: { $ref: "#/components/schemas/Transfer" },
              },
            }),
            "401": errors("INVALID_API_KEY"),
            "404": errors("TRANSFER_NOT_FOUND"),
            "429": errors("RATE_LIMITED"),
          },
        },
      },
      "/balance/transfers/{id}": {
        get: {
          summary: "详情（按编号）",
          description: "这个密钥转出的，和别人转给主人的。",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": json({
              type: "object",
              properties: {
                transfer: { $ref: "#/components/schemas/Transfer" },
              },
            }),
            "401": errors("INVALID_API_KEY"),
            "404": errors("TRANSFER_NOT_FOUND"),
            "429": errors("RATE_LIMITED"),
          },
        },
      },
      "/balance": {
        get: {
          summary: "可用",
          responses: {
            "200": json({
              type: "object",
              properties: {
                owner: party,
                available: { type: "string" },
                canTransfer: { type: "boolean" },
                reason: {
                  type: ["string", "null"],
                  enum: ["TRANSFER_DISABLED", "TRANSFER_NOT_ALLOWED", null],
                },
                toCredit: {
                  type: "object",
                  properties: {
                    canTransfer: { type: "boolean" },
                    reason: { type: ["string", "null"] },
                    minAmount: { type: "string" },
                    maxAmount: { type: "string" },
                  },
                },
                apiKey: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    dailyLimit: { type: ["string", "null"] },
                    usedToday: { type: "string" },
                    resetsAt: { type: "string", format: "date-time" },
                  },
                },
              },
            }),
            "401": errors("INVALID_API_KEY"),
            "429": errors("RATE_LIMITED"),
          },
        },
      },
    },
  };
}
