# AI-FREE 浏览器 MCP 三阶段对齐

本次以可调用的浏览器操作能力为对齐目标；不宣称与 Codex 内部实现或所有网站表现完全等价。

## 第一阶段：控制协议与标签生命周期

- `browser_tab` 支持 list/switch/navigate/replace/reload/close/back/forward。
- `tab_id`、`tabId`、`index` 等参数指向 list 返回的当前索引；关闭标签后重新 list。
- 先验证导航 URL；真实失败向上传递。标签已切换但后续失败时，清理旧观察引用。
- 历史导航按提交事件返回，覆盖 BFCache 和同文档导航，避免实际后退成功却等待超时。

## 第二阶段：结构、图像与操作反馈

- `browser_observe` 传 `include_accessibility_tree:true` 返回 ax-tree-v1：role、name、value、states、父子关系、bounds。
- 最多 4000 节点，文本裁剪到 512 个 UTF-16 单元；节点截断时标记 truncated。密码内容脱敏。
- AX id 是结构标识；操作使用 items 中的 ref 与 observationId，或经观察确认的坐标。
- `include_screenshot:true` 将结构与 PNG 同时返回。
- `browser_action` 传 `after:"observe"`，可用 observation_options 配置后置观察；成功操作不会因后置读取失败而重放。
- 标准 MCP 返回 image 内容块，JSON 元数据不重复携带大段 base64。个人插件同步更新标准转发与旧服务兼容。

## 第三阶段：真实内核与安装闭环

- 补齐实际 Chromium checkout 缺失的 0038、0041–0043 补丁，避免应用目录有功能而安装内核没有功能。
- 新增 0044–0048 补丁，修复标签操作、AX 快照、密码观察/等待结果、历史完成事件和会话命令路由。
- 会话管理走认证 Runtime Bridge；页面操作要求先对所选浏览器执行 browser_control acquire。业务失败不能被协议 ok 包装成成功。
- 验收入口：`npm run verify`、`npm run test:acceptance`、`npm run accept:codex-browser`、`npm run accept:chromium-phase3`。
- 最后打包、安装，并通过 AI-FREE MCP 对本地独立测试页面验证；安装与最终验收已完成，见下方记录。

## 调用约定

一次 acquire 覆盖同一浏览器的活动标签，直到 release 或连接断开。侧栏支持 browser_tab 的刷新、前进、后退、关闭、导航和指定标签切换。页面变化后先重新 observe，再使用当前页面的引用。`BROWSER_RUNTIME_UPDATE_REQUIRED` 表示旧内核缺能力；`ACCESSIBILITY_TREE_NOT_READY` 表示本次页面结构暂未就绪，可等待后重试。普通页面数据和 AX 数据来自两个读取过程，动态图页应按结果再次确认；截图与结构不是事务式原子快照。

## 验收记录（2026-09-16）

- `npm run verify`：711 项通过，0 失败；复杂度/类型/架构门禁通过。
- `npm run test:acceptance`：扩展兼容、运行时握手、页面观察、界面与会话存储验收通过。
- `npm run accept:codex-browser`：真实内核 AX、密码脱敏、复选框状态、PNG、输入点击、后置观察、历史导航与旧引用拒绝通过。
- `npm run accept:chromium-phase3`：真实文件上传、trusted 键鼠/拖拽/文本选区、封闭 Shadow DOM、媒体资源、下载、Cookie/Storage 双 Profile 隔离、协议拒绝和进程退出恢复通过。旧脚本补上显式 acquire，并使用现行 mediaResources 合同。
- 本地安装包：`appbuild/AI-FREE Setup 2.6.45.exe`；主程序与 Chromium DLL 的安装文件 SHA-256 与打包文件完全一致。
- 安装目录：`D:/1.STUDY/1_project/Automation_project/AI_crack/main/AI-FREE-app/appbuild/新建文件夹/AI-FREE`。
- 安装版 MCP：独立验收窗口完成创建、接管、AX+截图、输入、保存、等待、导航/切换/关闭/后退/前进/刷新。页面事件记录只有一次点击，且 isTrusted=true；返回内容为 Saved: MCP verified。
- 安装版 stdio adapter 与新个人插件均通过 `accept-installed-mcp.js` 实测：PNG image block（27140 bytes）、33 个 AX 节点、元数据不含重复 base64、旧引用调用 isError=true。
- 个人插件已更新安装为 `0.2.0+codex.20260915161213`；旧接口仅明确 HTTP 404/405 时回退，其他失败不重放动作。
- 九个增量补丁在隔离目录反向还原再顺序重放，与实际编译源码一致。
- 已释放接管并关闭验收窗口；软件保留正常运行。测试窗口记录保留供复查。

当前任务建立的旧 MCP 连接仍缓存旧工具目录；新启动的客户端已验证新目录与图像块。新会话或重新连接 MCP 后使用更新后的连接程序。本次修改未提交或推送。

## 2.6.47 双模式及实际页面复测（2026-09-16）

已在三阶段基础上增加自动化/调试模式、业务探针、操作链与暂停恢复，并修复实际剪辑页面暴露的默认观察误选 header、按钮换行文字定位不一致。新版已重新打包安装并重启，安装版 MCP 直接复测通过；当前连接已能发现 browser_workflow。721 项测试通过，新增原生补丁独立反向还原及重放与编译源码一致。

完整行为约定、能力边界与安装后验收见 [浏览器自动化与调试模式](browser-workflow-modes.md)。当前保留视频剪辑窗口并恢复自动化模式；此次真实项目验收覆盖面板及导出设置，未在用户项目执行素材添加和成片导出。
