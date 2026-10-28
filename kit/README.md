# 代码判定红包 · 开发包

在自己电脑上写、测代码判定红包的代码（`judge.js`）用的工具。这个目录用 MIT 许可（见 `LICENSE`），和仓库其余部分的 AGPL 分开：照着这里写的代码不受牵连。

## 怎么开始

先装好 Node.js 22 或更新的版本，然后：

```sh
npx degit LeUKi/hb/kit 我的红包
cd 我的红包
npm install
npm test
```

不用 degit 也行：下载仓库的压缩包，取出里面的 `kit` 目录，进去运行 `npm install`。

`npm install` 只装 `wrangler`（版本和网站一致）。四个命令靠它自带的 Miniflare 在本地起 workerd：兼容日期、`nodejs_compat`、外层和 `tools` 都和线上一样。代码导出 `network` 才能联网；测试里的请求拿 `tests.json` 写的返回，从不真的联网，`npm run simulate -- --live` 才真的发出去。本地不限 CPU，每次判定超过 1 秒算超时，超过 50 毫秒的标“慢”（线上每次判定只有 50 毫秒 CPU）。

## 四个命令

- `npm test`：跑 `tests.json`，每条一行，`console` 的输出跟在下面。`npm test -- 名字` 只跑名字里含这几个字的。
- `npm run check`：照网站部署时的规则查一遍，最后写“可以去网站部署了”或“还不能开放”，还有代码指纹，和网站上展开代码时显示的对得上。
- `npm run simulate`：让 `simulate.json` 里的人依次来领，看钱怎么发出去。`npm run simulate -- --seed 别的` 换一个种子，`--live` 让联网的请求真的发出去。
- `npm run replay -- judge-records-xxx.json`：红包结束后，用网站上下载的完整记录逐条重放核对。

失败时退出码都不是 0，脚本和 AI 都能据此判断。

## 文件

- `judge.js`、`tests.json`、`simulate.json`：模板，一个能跑通的示例玩法（猜暗号），改成你自己的。
- `tests.schema.json`、`simulate.schema.json`：两个 JSON 的格式，编辑器据此补全、标错。
- `judge.d.ts`、`modules.d.ts`、`jsconfig.json`：类型。`tools` 和能用的 Node 模块，编辑器和 AI 都看得到。
- `AGENTS.md`：完整的规则和常见错误，给 AI 也给人看。`.claude/skills/` 和 `.cursor/rules/` 只是指向它。
- `runtime/`：沙箱里和代码一起跑的那部分，网站上用的是同一份。
- `cli/`：四个命令。

## 写完以后

`npm test` 和 `npm run check` 都过了，就去网站发红包：选“代码判定”，在第 2 步“判定器”选“自己写一个”，起个名字，贴上 `judge.js` 和 `tests.json`。用 AI 写也一样：告诉它你的玩法，让它照 `AGENTS.md` 写，两个命令都过了再贴。

开发包按协议版本发布，这一份是第三版（第二版加上参数，第二版是第一版加上联网；兼容日期 2026-09-01 + `nodejs_compat`），也能重放第一、二版开放的红包（`runtime/frozen/`）。协议的来龙去脉见仓库的 `docs/programmable-hongbao-design.md` 第 4、5、9 节，参数见 `docs/judge-square-design.md` 第 3–5 节。
