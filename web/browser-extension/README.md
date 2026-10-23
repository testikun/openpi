# OpenPI Browser Bridge

0.5.0 仅负责 OpenPI 内置页面的导航、绑定与 CDP 执行。支持 Chrome、Edge、Brave 和 Chromium 145+。普通浏览器与桌面应用直接使用原版 `@injaneity/pi-computer-use`，不需要此扩展，也不再安装 portable 构建或配对外部浏览器配置。

## 设置

1. 在「设置 → 浏览器」请求安装原版 `npm:@injaneity/pi-computer-use@0.5.1`，或通过 `/openpi-setup` 审阅 `computer_use_action=install`。Pi 原生确认会列出固定来源及桌面、浏览器、文件操作权限。已有插件偏好原样保留。
2. 空闲时明确重新加载 Pi 资源，或新建会话。安装回执不代表当前会话已加载插件。
3. 使用内置页面时，通过设置引导打开 Chromium 的扩展管理页，启用开发者模式，选择此 `browser-extension` 文件夹。浏览器原生安装和站点权限确认由浏览器负责。
4. 刷新当前 OpenPI 页面，并通过 `/openpi-setup` 保存 `browser_control=true`、`browser_embedded=true`、`browser_default=embedded`。内置控制默认关闭；安装扩展与完成引导不会自动授权。

原版配置命令 `/computer-use` 保持只读展示。OpenPI 的配置入口仍为 `/openpi-setup`。选择普通模式（外部 `browser_default`）时，原版插件自行观察系统应用并执行操作，受 Pi 与系统权限约束；它可能激活窗口或使用真实键鼠。

## 同一套工具

模型只看到原版插件注册的 11 个工具及其原始参数 Schema：`find_roots`、`observe_ui`、`search_ui`、`expand_ui`、`inspect_ui`、`act_ui`、`read_text`、`wait_for`、`launch_browser`、`navigate_browser`、`evaluate_browser`。OpenPI 不再注册 `openpi_browser`。

内置模式的 `find_roots` 返回当前发起标签的页面 root；`observe_ui` 返回不可变 `stateId` 和元素 ref。语义观察读取 AX 树，`visual` 加入实际 PNG 与截图像素坐标尺寸。搜索、展开和检查访问完整缓存；单次可见文本有预算，较长输出通过原版 `read_text` 和不可变 `@o` 引用继续读取。

`act_ui` 支持原版点击、输入、按键、滚动、移动和拖拽参数。富文本使用浏览器编辑操作，避免替换整个编辑器文档。真实 `file_input` 节点会说明 `setText` 可接收一个绝对本地文件路径，空字符串清空选择；后台校验普通文件，Chrome 选择后再次核对文件名和字节数。输入框选择成功不等于服务器已收到文件，仍需观察页面回执或使用 `expect` 核实。

`setText` 替换完整内容；`typeText` 通过 CDP 原生文本输入按当前光标和选择区编辑。键盘控制包含退格、方向键、全选组合键和多行回车。真实 Chrome 测试在另一个标签持续输入时执行这些操作，并核对两边完整文本、活动标签和输入焦点。页面自身的 DOM 焦点仍被该页面共享，同一页面的人工和代理编辑需要协调。

内置模式通过 CDP 派发键鼠，当前没有绘制可见的虚拟光标动画。原版 `cursor_overlay` / `AgentCursor` 属于其桌面执行路径；原生桌面的前台键鼠需求仍按原版插件行为处理。

`evaluate_browser` 的 JavaScript 只在绑定文档的隔离上下文执行。`navigate_browser` 返回导航派发回执，随后调用 `find_roots` / `observe_ui` 确认新文档。`launch_browser` 在工作栏打开 HTTP(S) 页面，不启动另一个浏览器；没有页面时也能通过扩展的只读存在信号接收首次打开请求。

## 权限与生命周期

- Pi 拥有 Session、模型、包资源与工具定义；WebHost 的既有当前 Turn 和 controller 拥有内置输入权限。
- 只绑定实际工作栏的直接 iframe，使用浏览器文档身份及 nonce 核对；不控制 OpenPI 自身、同级文档或另一个发起标签。
- 任何写入先消费旧状态；取消、超时、页面替换与撤权均禁止凭旧状态重放。已派发但未验证的效果报告为不确定。无 `expect` 的事件派发不冒充业务成功。
- 截图只裁切可见内置页面；坐标输入必须来自该截图并仍命中绑定 iframe，不得点击覆盖的工作台界面。
- 关闭工作栏会清理绑定、DNR 规则及调试器。内置模式不初始化原版桌面 helper；原版 0.5.1 的模块级原生状态在 Web 进程中仅由一个 Session 持有，完成原生 shutdown 后释放。
- 扩展不枚举普通标签、不保存 profile 或 Cookie，不持有 Web API 凭据。旧外部配对接口返回 retired 回执。

网站完整 CSP 仍保留；并非所有站点都允许嵌入。跨站登录、嵌套子框架与动态文件选择 UI 仍需按实际站点验证；普通模式保持原版插件能力。多模型、所有网站、所有操作系统与用户同时操作的普遍可靠性不是局部集成测试可以证明的。

## 验证入口

- `tests/web/computer-use.test.ts`：真实原版 Schema、原生转发、单 Session 原生所有权、内置缓存、文件路径及状态权限。
- `tests/web/computer-use-plugin.e2e.ts`：原版 Pi 工具 → 内置后端 → 真 Chrome 扩展；同进程与 OOPIF、混合中英文富文本、中文文件名、服务端完整字节校验、连续输入和回车，以及其他活动标签保持。
- `tests/web/browser-computer-use.e2e.ts`：截图裁切、遮挡拒绝、文档替换、取消和 debugger 清理。
- `tests/web/browser-settings.e2e.ts`：设置引导、桌面／窄屏、可访问性及引导窗口所有权；其状态夹具不当作真实安装证据。

这些是版本限定的本地集成验证，不是通用模型能力 Benchmark。Pi core 和上游包源码没有被修改。原 MIT notice 保留于 [LICENSE.pi-computer-use](LICENSE.pi-computer-use)。
