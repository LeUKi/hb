# lafish的红包站 设计规范

更新：2026-10-15。新界面「夜灯」当天上线（<https://hb.lafi.sh>）。本文件只做入口：规则写在下面各篇里，这里不复述。

## 界面与交互

[外观重构](docs/redesign/README.md) 的八篇就是现行规范：

- [01 功能与界面清单](docs/redesign/01-inventory.md)：每项功能的去留和去处。
- [02 外壳](docs/redesign/02-shell.md)：窗口、顶栏、地址条与指令框、用户卡片、启动加载、动效、焦点与可访问性。
- [03 命令与地址](docs/redesign/03-commands-routes.md)：命令表、路由、表情地址。
- [04 视觉语言](docs/redesign/04-visual.md)：颜色、材质、超椭圆、控件尺寸。
- [05 红包页](docs/redesign/05-hongbao.md)：红包皮与印章、口令区、名单、称号、内嵌图。
- [06 生产改动清单](docs/redesign/06-production.md)：相对旧版本改了哪些业务和接口（取消青春版、名单公开、地址与域名等）。
- [07 其他页面](docs/redesign/07-pages.md)：发红包、红包记录、红包广场、账号资料、商户、付款、尝试统计、网站管理、结果页、帮助。
- [08 落地方案](docs/redesign/08-migration.md)：迁移的阶段和进度。

## 业务与运维

- 业务语义以 [业务规格 v1](docs/business-spec-v1.md) 和共享契约 `packages/contracts` 为准（表情码的编码也在契约里）。
- 网站管理的接口与隐私范围：[管理员后台](docs/admin-operations.md)。
- 维护模式与 D1、DO 的位置：[D1 迁往亚太](docs/d1-apac-migration.md)。
- 生产的付款运维、发布记录和验收证据由站长另外保存，不在仓库里。

## 旧规范

2026-10-15 之前的界面规范（暗色界面、`/account` 登录页、`/my/payments` 工作台、`/e/` 短地址等）随旧界面退役，原文见提交 `f5d4a33` 的 `DESIGN.md`；更早的批次见 [历史修订记录](docs/design-history.md)。
