# 代码判定红包 · 开发包

在自己电脑上写、测代码判定红包的代码（`judge.js`）用的工具。这个目录用 MIT 许可（见 `LICENSE`），和仓库其余部分的 AGPL 分开：照着这里写的代码不受牵连。

- `judge.d.ts`：代码协议第一版的类型（收到什么、返回什么、`tools`、`tests.json` 的一条）。
- `runtime/`：沙箱里和代码一起跑的那部分，网站上用的是同一份。

协议和规则见仓库的 `docs/programmable-hongbao-design.md` 第 4、5 节。本地测试命令、模板和给 AI 的说明还在做。
