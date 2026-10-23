# Computer use 集成与内置浏览器控制

- Status: validated scoped local observations; recommendations are not an adopted Decision or a formal Benchmark
- Created: 2026-10-23
- Verified: 2026-10-23
- Source boundary: OpenPI `b4f13995b90eeed5ff8ed03b833c7174d4b2d21a`, Browser Bridge 0.5.0 bytes, Pi 1.2.0, original `@injaneity/pi-computer-use@0.5.1`; six-tool Maka port from `173f1e7397ded73cdfc8f362e89858602e073ef4` with OpenCLI 1.8.6. Download follow-up adds only `allow-downloads` to the shared iframe and rebuilds its frontend.
- Issue: [#169](https://github.com/openpi-dev/openpi/issues/169)
- PR: [#892](https://github.com/openpi-dev/openpi/pull/892)
- Discussion: [#896](https://github.com/openpi-dev/openpi/discussions/896)
- Supersedes: none. This independent public example does not replace historical measurements or adopt a provider choice.
- Evidence: private archive identity `openpi-browser-public-demo-20261023-p7gs101s`; frozen protocol, generated fixture and attachment, native Sessions, receiver events, concurrent-input samples, independent verifier, and before/after download receipts. No screenshots, production addresses, internal business data, provider credentials, or browser profiles are published.

## Problem and ownership

目标是让 OpenPI 的通用 computer use 与内置浏览器可靠配合：表单、检索、
多步修改、上传下载，以及用户同时使用其他标签时的输入隔离。

需要区分三个层次。Pi package 注册模型工具；执行后端决定工具操作原生
桌面、普通 Chrome 还是 OpenPI iframe；UI 展示浏览器、光标动画和执行
结果。加载 package 不会自动把普通顶层页面操作绑定到内置 iframe。

固定的原版 0.5.1 向模型注册 11 个工具，本轮 Maka 移植注册 6 个工具。
这是两个工具接口，不是分别需要 11 个或 6 个外部插件。UI 将它们显示为
一个 computer-use 工具组，也不改变模型看到的工具数量。

本次复用 Pi 原生注册、Session 和模型配置，以及 OpenPI 既有 frame 传输。
不增加第二套 provider、Session 或浏览器控制栈。Session、turn、controller、
document、取消和失效后的副作用不重放，仍由运行时边界负责。

输入隔离与可见光标分别验收。CDP 对绑定页面投递输入，可以测试其他标签
是否保持焦点；光标动画只是反馈。本次没有增加可见虚拟光标，也不据截图
推断其他产品的内部实现。

## Neutral protocol

公开案例是独立的本地“社区活动报名”，所有数据和附件均合成生成。
两组使用相同源码、Bridge 字节、模型配置和任务模板，独立 profile、
工作区及 Chrome；GPT-6.1 Sol / xhigh，关闭 Code Mode。先 Pi，后 Maka，
每组一个新回合，上限 8 分钟、60 次工具调用，均未触及限制。

任务包括空表单校验、中文与富文本、两行备注、实际 Enter 确认搜索、活动
形式菜单、须知复选框和异步就绪。先预览 v1，返回改为 v2，再预览并准确
提交一次；核对完整回执及 SHA256，重开回执并尝试下载 JSON。独立测试
数值预算 42.5、原生语言下拉框和中文文件名的 6 MiB `.txt` 附件上传。

插件公开的 DOM 脚本能力可以使用；提交与上传必须通过页面实际按钮，
禁止直接请求业务接口、调用业务处理函数、改校验或伪造回执。接收端独立
核对精确字段、提交次数、完整上传字节与哈希；下载必须有实际文件。
另一活动标签持续接收精确输入流，采样焦点和活动标签身份。

成功回执的字段为：

```json
{
  "name": "OpenPI 社区活动 #23",
  "description": "周末交流会，主题：浏览器自动化。",
  "notes": "Line 1\n第二行：中文输入",
  "revision": "v2",
  "searchConfirmed": "OpenPI 读书会",
  "application": "online",
  "retain": true
}
```

## Baseline observations

下表是修复下载权限前的冻结对照，不把之后的修复验收回填为基线通过。

| 项目 | 原版 Pi 接口＋内置适配 | Maka 六工具＋同一内置后端 |
| --- | --- | --- |
| 普通表单、回车、异步就绪、两次预览、返回修改 | 通过 | 通过 |
| 准确提交一次、精确回执、重开回执 | 通过 | 通过 |
| 数字框、原生下拉框 | 通过公开 JS 回退 | 未通过 |
| 实际上传 | 6,291,456 字节，接收哈希一致 | 文件填充被拒绝，上传 0 次 |
| 下载落盘 | 未通过，sandbox 阻止 | 未通过，同样被阻止 |
| 另一标签输入、焦点、活动身份 | 通过 | 通过 |
| 工具调用 / 异常结果 | 31 / 4 | 49 / 6 |
| 单次端到端时间 | 228.83 秒 | 291.56 秒 |

Pi 的异常是一次根引用错误、两次导航后观察失效、一次下拉控件不可编辑；
随后观察或使用公开页面脚本恢复。Maka 的异常是三次等待条件参数错误、
一次导航失效、两次拒绝填充。错误参数属于本轮模型行为，导航失效涉及
共用传输，不能将所有异常归为插件实现缺陷。下拉未选中也不能由“点击已
派发”推断成功。

Pi 数字与下拉的事件 `isTrusted=false`；它们不是纯原生键盘交互验收，
也不证明 React 受控组件或要求可信事件的网站已通过。上传通过既有内置
适配，将原版 `act_ui.setText` 的文件路径映射到文件选择，再点击实际
上传按钮。文件选择事件可信；接收 SHA256 为
`2e795d9609b34ec8ae854e77f0e82ae165f294a78ebdc6068ea19581cbdd8a60`。
这不是未适配原版插件在所有后端都支持同样文件操作的证明。

另一活动标签收到 Pi 13,630、Maka 17,249 个完全匹配字符，分别有 1,340、
1,669 次焦点及活动身份采样。这里验证的是隔离 Chrome 内的受控输入，
不等于物理键鼠并行或系统桌面控制验收。

## Usage and interface trade-off

| 原生 Pi 累计字段 | Pi | Maka 六工具 |
| --- | ---: | ---: |
| input，不含下面的缓存读取 | 31,888 | 18,449 |
| cacheRead | 711,936 | 598,272 |
| output | 4,856 | 2,821 |
| totalTokens | 748,680 | 619,542 |
| 工具可见文本 UTF-8 字节 | 84,328 | 24,251 |

推理 token 是输出的子项，没有再加一次。两组工具结果图像均为 0。
Pi 本轮调用少，状态反馈和累计 token 更多；不能把调用更少写成费用更低。
未核算实际网关账单，也没有消融 schema、反馈、策略与缓存各自的贡献。
单次运行顺序和网关波动限制用时外推，不作通用性能排名。

Pi 的通用动作、批量执行、页面脚本和状态引用提供更多恢复手段，但反馈
体积更大。Maka 六工具的接口和文本更轻，普通主流程可完成；其缺少的
原语限制了本轮数字、原生选择和文件选择。完整 OpenCLI 具有更多能力，
这次六工具端口不是它的能力上限。

## Shared download fix

两组基线的 Chrome 日志均明确报告 iframe sandbox 缺少 `allow-downloads`。
此前同源码下的独立 A → B → A 对照，也观察到原标志无文件、仅增加该
标志后落盘且哈希正确、恢复原标志后再次无文件。

这次修改共享 `BrowserPanel` 的 sandbox，增加一个 `allow-downloads` 标志，
重建前端；没有增加工具、配置项、下载管理框架或特定模型分支。

复用现有 native iframe Chrome 用例，增加实际下载和逐字节核对。旧配置
在 `download` 事件等待处超时；相同用例在修复后通过，保存文件与接收端
生成内容完全一致。原有输入、选择、滚动、导航、弹窗和标签行为也通过。
移除这个唯一标志就回到已复现的失败，没有需要保留的新抽象。

修复后的独立下载任务分别由实际模型调用插件完成。Pi 使用 4 次工具调用，
Maka 的新 Session 使用 3 次；各保存一份 114,688 字节文件，逐字节相同，
SHA256 均为
`dcaa6410fab70cb330d8093c51841b586498d1907805b44d6f416764d533c471`。
另一活动标签的焦点、活动身份及原有编辑文本均保持正确。这是预先打开
下载页的专项测试，不是整套基线任务重跑。

Maka 首次专项复测复用了旧 Session 并换了 Chrome controller，两次
`browser_snapshot` 被旧页面绑定拒绝，未执行下载；这保留为恢复行为的
未通过项。随后新 Session 的准备阶段另有两次 harness 错误：UI 切换未
稳定、尚未写入的空 Session 文件被读取。两次均未发起模型任务，单独
归档，不计入插件下载结果。选定空 Session 后重新启动浏览器并修正文件
读取，才完成上述新 Session 验证。没有放宽产品 owner 检查以让测试通过。

文件能下载，不表示模型已经获得可靠的落盘回执。Pi 下载后仍如实说明工具
未提供文件保存证据；外部测试通过真实文件确认成功。下载文件的归属、
路径及失败原因怎样反馈给模型，仍值得后续讨论。

## Recommendation and remaining questions

**建议：** 暂以原版 Pi 接口作为当前通用操作与上传目标的基础，保留一套
模型接口，先补齐共用内置能力与文件回执，再借鉴 Maka 的紧凑状态反馈。
该建议基于这次边界，没有采用替代方案的正式 Decision。

需要继续讨论：原生数值、select、按键、文件选择与等待原语的后端能力
声明；导航及 controller 变化后的恢复；取消后不再输入；下载文件归属与
可验证反馈；可见光标与输入隔离的独立验收。后续使用受控组件、多模型、
重复任务和故障案例验证，不为单个模型硬编码流程。

未验证真实生产站点、SSO、跨平台桌面权限、React 受控输入、可见虚拟
光标或多模型泛化。本轮局部通过不能写成整个 computer use 已经通用可用。

## Sources and validation

- [原版 Pi package](https://github.com/injaneity/pi-computer-use)：本轮固定 npm 0.5.1，十一工具来自该安装版本，不用 main 当前列表替代。
- [六工具移植边界](https://github.com/testikun/openpi/blob/b4f13995b90eeed5ff8ed03b833c7174d4b2d21a/experiments/maka-browser/README.md)：固定 Maka 与 OpenCLI，复用同一 OpenPI frame 后端。
- [完整 OpenCLI](https://github.com/jackwener/OpenCLI)：公开能力多于本轮六工具面。
- [基线 iframe sandbox](https://github.com/testikun/openpi/blob/b4f13995b90eeed5ff8ed03b833c7174d4b2d21a/web/ui/src/features/workbar/BrowserPanel.tsx#L221)、[内置文件适配](https://github.com/testikun/openpi/blob/b4f13995b90eeed5ff8ed03b833c7174d4b2d21a/web/host/computer-use.ts#L291)。

独立 verifier 从原生 Session 与接收端事件重新核对同任务、同模型配置、
实际 xhigh、字段、提交顺序、上传字节、原生用量及并行输入。两组基线均
未全项通过；失败原样保留。后续测试与基线分别归档，不覆盖原结果。

`bun run check` 通过。隔离 profile 下完整 `bun run test` 通过：Node 2,398
通过、8 个既有跳过；UI 1,642 通过、107 个文件。真实 Chrome 下载回归
先失败后通过；下载专项的两个插件均有实际模型调用及完整文件核验。
检查通过不替代基线中未通过的原生控件、上传或恢复结果。

临时对照服务在核对精确 Session 且运行时 idle 后关闭。当前实验入口返回
的前端与修复后构建逐字节一致；刷新可加载修复。没有发布原始 Session、
配置、浏览器 profile 或截图；保留初始失败、专项复测与实际文件。
