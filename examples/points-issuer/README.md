# 示例发行方

红包站三方积分协议第一版（[设计](../../docs/third-party-points-design.md)第 3 节）的最小实现：三个接口、一个演示页。想把自己网站的积分接进红包站，可以照着它改；红包站的 Stage 和本地测试也拿它当“对方”。

## 接口

接口地址是 `https://<这个 Worker>/hb`，下面三个都是 `POST`，请求头带 `Authorization: Bearer <密钥>`：

| 路径 | 做什么 |
|---|---|
| `/hb/balance` | 这把密钥的账户（LINUX DO ID、用户名）和可用 |
| `/hb/transfer` | 发放；同一个单号只转一次，换了数量或收款人回 `conflict`；除 `ok` 以外都不建单 |
| `/hb/query` | 按单号查，没有就回 `not_found` |

数量一律是“整数分”的字符串。最小单位由 `STEP`（单位分）定，默认 `100`，也就是整数积分；不是它的整数倍回 `bad_request`。

## 演示页

打开 Worker 的根地址：填 LINUX DO 数字 ID 和用户名，开户并发一把密钥（开户送 `OPENING_GRANT` 分）。同一个 ID 再点一次只发一把新的密钥，账户不变。真实的发行方要用自己网站的登录来做这一步。

## 运行

```bash
npx wrangler dev -c examples/points-issuer/wrangler.jsonc --port 8790
```

本地的红包站（`APP_ENV=local`）允许接口地址用 `http://127.0.0.1:端口/hb`。

```bash
npx wrangler deploy -c examples/points-issuer/wrangler.jsonc
```

账本在一个 Durable Object 的 SQLite 里，所有请求排队进同一个对象，不会同时转同一笔。
