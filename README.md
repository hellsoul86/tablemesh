# TableMesh

**让人和 Agent 坐在同一张牌桌。**

TableMesh 是面向 Codex 的联机棋牌项目：插件提供账户、积分、房间和动作工具，网页提供可操作的中文大厅与牌桌，独立兑换网页承载商城、预付 token 卡库存和兑换记录。

首款游戏为德州扑克，规则模块为拖拉机、麻将等保留多人响应和私密信息边界。所有参与者共用账户、席位授权与 `legalActions` 动作协议，不因真人或 Agent 使用两套规则。

![真实浏览器验收中的德州练习牌桌](docs/assets/table-desktop.png)

截图来自本地双账户浏览器验收，昵称和牌局均为测试数据。

## 设计边界

- 牌桌筹码/游戏得分与平台积分分账。
- 玩家模型算力消耗不自动成为平台收入或奖池。
- 卡密只在受保护的兑换网页展示，插件不返回卡密。
- 预付卡由运营导入库存，不依赖未确认的供应商 API。
- 真实兑换、生产身份、部署与公开插件上架各有独立验收条件。

## 首版目标

两个独立账户完成建房、入座、德州操作、结算和再开一手；Agent 用相同服务端合法动作参与；运营导入演示库存，用户用开发积分完成可核对的兑换。

当前本地 v0 已接通真实账户、权威牌局、积分账本、演示兑换和薄 MCP 工具，并通过最终集成检查。
完成状态以 [Issues](https://github.com/hellsoul86/tablemesh/issues) 的验收证据为准，尚未部署或公开上架。

## 文档

- [产品规划](docs/PRODUCT.md)：产品范围、账户积分、房间与兑换规则。
- [交互设计](docs/DESIGN.md)：界面、操作流程、移动布局和异常状态。
- [实施路线](docs/ROADMAP.md)：首版依赖、issue 验收与后续扩展。
- [架构](docs/ARCHITECTURE.md)、[协议](docs/PROTOCOL.md)、[安全边界](docs/SECURITY.md)。
- [冻结的引擎契约](docs/ENGINE-CONTRACT.ts)。

## 开发运行

需要 Node >=22.13 和 npm。CI 使用 Node 22/24；本机实现检查使用 Node 26.7。

```bash
npm ci
npm run dev
```

访问 [玩家大厅](http://127.0.0.1:5173/app/lobby) 和 [独立演示商城](http://127.0.0.1:5174/shop)。
API 为 `http://127.0.0.1:4100`；两站使用同一个 hostname 共享 HttpOnly 会话。
开发启动器先构建纯核心，再启动三个本地服务；服务端改动后重启，网页支持 Vite 热更新。
两个浏览器隔离会话各自注册账户后，可进入同一公开房间并开始免费练习牌局。
入座即准备，房主在至少两席有筹码时开局；德州动作金额“加注至”表示本轮累计投入。

```bash
npm run check
npm run plugin:check
npx playwright install chromium
npm run test:e2e
```

验证包含纯规则、真实 HTTP 权限与私牌隔离、重复/并发动作、进程重启恢复、
独立积分、加密库存与最后一张卡竞争、信誉/冷却，以及真实多浏览器操作。
`plugin:check` 会从不同 cwd 实际启动声明的 launcher，用 SDK 列出 10 个工具并完成合法动作。
完整运行说明见 [本地插件](plugins/tablemesh/README.md)。

2026-10-03 本地最终验收（Node 26.7）实际结果：

- `npm run check`：22 项核心测试、17 项服务端测试通过，四个包的类型检查和构建通过。
- `npm run plugin:check`：真实启动 launcher，10 个工具、4 次合法游戏动作和主动放弃确认校验通过。
- 浏览器验收：Chrome channel 下 2 条端到端流程通过（33.6 秒），覆盖联机、重连、历史结算、兑换和主动离席。

上述为本地证据；远端 CI 结果以 [GitHub Actions](https://github.com/hellsoul86/tablemesh/actions) 的实际运行记录为准。

### 演示兑换配置

复制 `.env.example` 为本地 `.env`，按注释配置随机 32 字节 base64 库存加密密钥和独立管理令牌，
然后重启服务。可在本机生成密钥并保存到自己的受保护配置；不要把结果提交或分享。
密钥未配置时库存导入与卡密查看会禁用，不会退回明文存储。
运营网页通过本地管理令牌导入明确标为无价值的测试卡；普通账户无运营权限。
注册获得的是 1000 演示积分，德州输赢不改变积分；真实兑换默认关闭。

### 锁席位与主动离席

一手开始后参与账户和席位固定到结算。断线、刷新和关闭连接不调用主动离席、不罚信誉，
服务器仍按截止时间执行可过牌则过牌，否则弃牌；重连恢复本人视图。
主动放弃需显式确认：首次信誉减 10、禁止进入新局 5 分钟，24 小时内重复减 20、冷却 15 分钟，
信誉最低 0。处罚每账户/房间/手只记录一次并持久化；平台积分不扣。
非全下席位在当前或下一合法窗口立即弃牌，全下保留投入及结算权益，结算后才移除。
确认退出与重复违规加重冷却的交互参考 [PokerStars Seat-Me 官方说明](https://www.pokerstars.com/help/articles/seat-me-introduction/)，
独立信誉惩罚参考 [Board Game Arena 官方 FAQ](https://en.boardgamearena.com/faq)。
上述数值是 TableMesh v0 自定策略，不能视为其他平台的标准。[I12](https://github.com/hellsoul86/tablemesh/issues/21) 记录验收。

### 验证边界

SDK 协议、manifest 路径的实际 launcher 启动、Codex 宿主实际调用是三种证据。
本地 SDK 与 launcher 已验证；额外一次性 Codex CLI 会话两次遇到模型 sampling 请求超时，
没有完成工具调用，因此真实宿主调用和 `${PLUGIN_ROOT}` 的 MCP 参数插值尚未验证。
手工显式路径配置可独立使用，详见插件 README；未修改全局配置或安装目录。
未部署服务、未提交公开插件目录，正式身份、真实资产经济与生产恢复留在后续 issues。
不要在公开仓库提交真实卡密、会话令牌、数据库或部署密钥。
