# 安装、更新与卸载

[English](install.en.md) · [返回 README](../README.zh-CN.md)

在需要发起或接收任务的电脑上安装 sub2sub，可以按需加入多台设备。一台电脑可以连接多个工作节点，也可以同时承担使用方和提供方角色。执行任务的电脑登录自己的 Codex 账号，并在工作期间保持在线。

## Codex

先安装并登录支持插件的 Codex。安装包适用于 macOS（Apple Silicon / Intel）和 Windows x64，包含 Node 运行时和证书生成依赖。

macOS，在 Terminal 运行：

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash'
```

Windows，在桌面登录用户的 PowerShell 中运行：

```powershell
irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1 | iex
```

看到 `Installed sub2sub` 后，开启新的 Codex 对话；CLI 用户重新启动 `codex`。第一次使用可说“生成 sub2sub 邀请码”，或粘贴对方发来的邀请码。

安装器下载对应系统的发行包、校验下载内容、定位 Codex，并通过原生插件命令安装。无需自己建目录、编辑 JSON 或运行 npm。Git 仅在按整个 Git 仓库选择文件时需要；明确选择文件或目录无需 Git。

程序默认安装到：

- macOS：`~/.local/share/sub2sub`
- Windows：`%LOCALAPPDATA%\sub2sub`

发行包下载见 [Releases](https://github.com/mekoand/sub2sub/releases)。源码开发与手动打包见[开发说明](development.md)。

## Claude Code

先安装并登录原生 Claude Code CLI，再运行对应命令。只从 Claude Code 发起任务的电脑无需安装 Codex；接收任务的工作节点仍使用自己的 Codex 账号执行。

macOS：

```sh
/bin/bash -o pipefail -c 'curl -fsSL https://github.com/mekoand/sub2sub/releases/latest/download/install.sh | /bin/bash -s -- claude'
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((irm https://github.com/mekoand/sub2sub/releases/latest/download/install.ps1))) -Target claude
```

安装后启动新的 `claude` 会话，`claude plugin list` 应显示 `sub2sub@sub2sub` 已启用。粘贴工作节点的邀请码，随后在当前对话中委托任务。安装器遵循 [Claude 插件机制](https://code.claude.com/docs/en/plugins-reference#mcp-servers)，通过本地 marketplace 注册携带现有 Skill 和 MCP 服务的原生插件。

两个宿主可以共用程序目录、配对和本地成果。使用哪个宿主，就运行它对应的安装命令；也可以两个都装。更新时保持原命令和目标，更新 Claude 不会同时更新 Codex 的插件缓存，反之亦然。

## 首次连接

1. 在工作机说“生成 sub2sub 邀请码”。有多个网络地址时，选择另一台电脑能访问的地址。
2. 在发起任务的电脑上粘贴邀请码，给工作机命名，并确认任务文件范围。
3. 用这个名字派发任务。检查交付的本地文件，继续提出修改或结束任务。

邀请码单次使用，10 分钟有效。成功配对后不需要每次重新生成。系统询问网络访问时，允许工作节点在所用私有网络上接收连接；默认端口为 `47631`。

添加其他节点时重复配对，分别取名；之后按任务选择节点。每个节点同时执行一个任务。

## 在 CLI 中使用

安装后运行 `codex`，在交互会话中使用相同的邀请、派发和续作指令。提供方的 CLI 会话需要一直保持打开；退出会话就会关闭它承载的共享进程。`codex exec` 可以作为任务发起端，但不适合承载持续在线的工作节点。

## 跨网络使用 Tailscale

设备分处不同网络时，可以使用 [Tailscale](https://tailscale.com/download) 提供设备间连接：

1. 在参与跨网络连接的设备上安装 Tailscale，加入可互通的网络。团队可以邀请成员或分享指定设备。
2. 在 Tailscale 中查看工作机的 IPv4 地址。
3. 让工作机“用 Tailscale 地址 100.x.x.x 生成 sub2sub 邀请码”，将示例替换为实际地址。
4. 使用者照常粘贴邀请码。保持 Tailscale 在线，网络访问规则允许使用者连接工作机的共享端口。

无需把路由器端口开放到公网，也不需要 Tailscale Funnel。sub2sub 使用 Tailscale 的 IPv4 地址；当前不接受 MagicDNS 名称或 IPv6。已经配对的连接中保存了网络地址，从局域网切换到 Tailscale 时，先保存成果并退出工作机上承载共享的会话，再在新会话中指定 Tailscale 地址开启共享；随后让使用者的助手更新连接地址。

0.5 已支持 Tailscale 常用的 `100.64.0.0/10` 范围，并完成地址处理自动测试；真实跨网络配对与任务回传留待后续版本验证。[Tailscale 地址说明](https://tailscale.com/docs/concepts/tailscale-ip-addresses)

## 更新

先完成或取消活动任务、保存成果，再次运行安装命令。安装器会刷新插件缓存和启动路径，保留已有配对、证书和任务数据。旧版程序目录保留，当前会话不会被强行终止。更新后，各设备开启新对话。

两个宿主均使用 `sub2sub@sub2sub` 作为插件标识。Codex 安装器还会在确认新安装启用后迁移其他来源的旧 sub2sub；Claude 安装器只管理其用户级安装。其他插件不变。

需要指定已发布版本时，先设置 `SUB2SUB_VERSION`，再运行同一命令。只有包含一键安装发行包的版本才支持此方式。跨大版本回退前查看对应版本说明，避免旧程序操作不兼容的任务数据。

## 安装异常

- **下载失败：**确认当前网络可访问 GitHub Releases，再次运行安装命令。
- **找不到 Codex：**先打开并登录 Codex。特殊安装位置可设置 `SUB2SUB_CODEX` 为原生可执行文件的绝对路径，再重试；Windows 需要 `codex.exe`，不能填写 `.cmd` / `.bat`。
- **找不到 Claude：**安装原生 Claude Code CLI 后重新打开终端。特殊位置可用 `SUB2SUB_CLAUDE` 指定可执行文件的绝对路径；Windows 需要 `claude.exe`。
- **安装成功但没有工具：**开启新对话或重启 CLI，通过 `codex plugin list` 检查 `sub2sub@sub2sub` 是否安装并启用。
- **Windows SSH 环境拒绝访问桌面包：**在桌面用户的 PowerShell 中安装与运行。SSH 系统会话与桌面会话的应用权限、沙箱行为可能不同。

可用 `SUB2SUB_INSTALL_DIR` 指定程序目录；更新时沿用同一目录。更多诊断见[故障排查](troubleshooting.md)。

## 停止与卸载

“停止 sub2sub 共享”会停止接收新任务，当前任务仍可完成和取回。关闭提供方进程会中断执行。

卸载前先保存需要的成果，再在插件目录卸载，或运行：

```sh
codex plugin remove sub2sub@sub2sub
```

Claude Code 使用 `claude plugin uninstall sub2sub@sub2sub --scope user`。每条命令只卸载对应宿主中的插件。

程序、任务记录和本地成果是分开的。卸载插件不会替你删除成果；任务与原生会话的删除按[清理选择](usage.md#任务生命周期)处理。需要释放旧程序占用时，在相关会话退出后删除安装目录中的旧 `versions` 子目录，保留当前安装使用的版本。
