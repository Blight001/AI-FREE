# Browser Workspace 稳定契约

状态：Stage 2 冻结

生效条件：默认应用启动路径

## 窗口与生命周期

- Home 通过 `workspace-open-browser` 创建或聚焦唯一 Browser Window。
- Browser Window 使用独立 `browser-preload.js`，主标签页和 side view 均登记为
  `browser` sender。
- 窗口关闭时只释放 Browser Workspace：取消 Browser AI run、停止 Browser
  Automation 任务并清空 Browser 窗口/side view 引用；不得关闭 Software Window。
- `app.activate` 只恢复 Home，不隐式创建 Browser。
- Browser composition 不创建或注入 Cursor Sidecar；Chromium 原生点击、滚动、
  拖拽、键盘和文件输入协议保持不变。

## UI 与 preload

- 主区域继续使用已验收的 Chromium 标签壳和地址/标签操作。
- side view 只显示“AI 控制”“自动化”“浏览器配置”；Browser 模式会在任何
  software controller 初始化前移除 Software 栏目 DOM。
- Browser preload 不暴露 `software` 或 Home 启动入口。迁移期保留浏览器壳所需的
  `ai`、`automation`、只读/公共账号展示、网络、更新和 UI 能力；这些能力仍是固定
  channel allowlist，不接受调用方提供任意 IPC 名称。

## IPC 授权

- Browser sender 允许 `browser`、`network` 以及 Browser UI 所需的公共 domain。
- Browser sender 调用 `software` domain 返回：

```js
{
  ok: false,
  error: {
    code: 'WORKSPACE_ACCESS_DENIED',
    message: 'browser 工作域无权调用此 IPC',
    retryable: false
  }
}
```

- AI/Automation 的工作域由已登记的 sender 推导。payload 若声明
  `workspaceType`，必须与 sender 一致；不能通过伪造 payload 改变授权域。

## 状态、AI 与 Automation

- `tabs`、`activeTabId`、Chromium Runtime、Profile、历史和网络选择在迁移模式下
  只绑定 Browser Window；Software 占位窗口不进入该 TabManager。
- Browser AI 工具目录不读取外部软件 Runtime，不发布 `software_ui` 或软件目标。
- Browser AI run key 包含 `browser` domain；关闭 Browser 只取消该 registry 的 run。
- Browser 历史视图隐藏并拒绝带 `softwareProfileId` 的旧会话；旧文件只读兼容，
  不执行破坏性迁移。
- Browser Automation 使用 Browser AutomationBridge、Browser 连接与定向 side view
  进度事件；事件在迁移模式下包含 `domain: "browser"`。

## 网页远程控制

- AI-FREE 作为 HeySure 自定义设备注册时声明 `remote_control`，复用统一 `rc:*`
  信令和网页控制端，不创建第二套公网控制接口。
- 远控只绑定会话开始时的活动 Browser Profile，通过 Chromium Runtime Bridge
  采集页面、注入输入并管理该 Profile 内的网页标签；不得读取或控制 Software
  Workspace、Home、账号页和 AI 侧栏。
- 视频与输入走 WebRTC P2P，服务器只中继 SDP/ICE 信令；ICE/TURN 配置必须从当前
  已认证 HeySure 服务器动态获取。Socket 断开、退出登录、应用退出或 WebRTC 失败时
  必须释放采集、接管状态、定时器和隐藏 peer renderer。

## 持久化兼容

- Chromium Profile、浏览器历史、账号会话和许可证路径保持原路径。
- 现有 `extensions/browser_automation/automation-cards.json` 在 Stage 2 继续作为
  Browser Automation 的兼容卡片库；Software Stage 3 必须使用独立仓库，不能复用
  此状态或 selected id。
- 不覆盖或删除无法可靠分类的旧 AI 历史。

## 验收命令

```text
npm run check:workspace-shell
npm run check:browser-settings
npm run check:browser-settings-ui
npm run accept:chromium-phase3
npm run check:session-storage
npm run guardrails
npm run verify
npm run test:acceptance
npm run build:win
npm run check:packaged-runtime
```
