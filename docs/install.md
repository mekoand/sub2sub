# 安装、更新与卸载

[English](install.en.md) · [返回 README](../README.zh-CN.md)

在发起任务和接收任务的电脑上分别安装 sub2sub。提供方登录自己选定的 Codex 或 Claude Code 订阅账号，并授权配对；使用方在自己的对话中委托任务，无需登录提供方账号。执行设备在工作期间保持在线。同一台电脑可以按需发起或接收任务，也可以连接多台设备。

按下文完成安装并重启宿主后，在对话中生成或连接邀请码，就能开始[第一次委托](usage.md#派发和追加需求)。想先熟悉一下，也可以说“打开 sub2sub 管理页”：它默认开启、随时可关闭，不会自动弹出浏览器。[管理页说明](usage.md#本机管理页与统计)

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

看到 `Installed sub2sub` 后，**完整退出并重新打开 Codex 桌面应用**；仅关闭窗口或新建对话可能仍使用旧插件进程。CLI 用户退出并重新启动 `codex`。先说“查询 sub2sub 状态和版本，不修改设置”，确认当前对话已加载插件，再按 [README](../README.zh-CN.md#连接工作节点) 配对。

安装器下载对应系统的发行包、校验下载内容、定位 Codex，并通过原生插件命令安装。无需自己建目录、编辑 JSON 或运行 npm。Git 仅在按整个 Git 仓库选择文件时需要；明确选择文件或目录无需 Git。

程序默认安装到：

- macOS：`~/.local/share/sub2sub`
- Windows：`%LOCALAPPDATA%\sub2sub`

发行包下载见 [Releases](https://github.com/mekoand/sub2sub/releases)。源码开发与手动打包见[开发说明](development.md)。

## Claude Code

先安装并登录原生 Claude Code CLI，再运行对应命令。只从 Claude Code 发起任务的电脑无需安装 Codex；macOS 工作节点也可以使用自己的 Claude 订阅执行：安装 Claude Code 2.1.263 或更高版本并登录，再让 sub2sub 将提供方执行工具切换为 Claude。选择与管理 sub2sub 所用的宿主无关。暂不支持 Windows 上的 Claude 执行。

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

添加其他节点时重复配对，分别取名；之后按任务选择节点。每个节点默认最多同时执行 4 项任务，可在提供方设置中调整；满额时拒绝新任务，不等待排队。

## 在 CLI 中使用

安装后运行 `codex`，在交互会话中使用相同的邀请、派发和续作指令。开启共享会启动独立节点，关闭 CLI 会话后仍可接单，新会话会连接同一节点。单次 CLI 调用也可开启共享。电脑须保持唤醒和联网，重启电脑后手动开启共享。

## 跨网络连接

0.9.0 提供内置跨网络服务。发行包为 macOS ARM64、macOS x64、Windows x64 附带对应 Tailcat 组件及许可证，用户无需安装 Go 或另行配置 Tailscale。

1. 双方安装兼容版本，在本机设置中主动打开“开启跨网络连接服务”，或在对话中明确要求开启。默认关闭，配对和首次设置确认不会自动开启。
2. 提供方照常生成邀请码，使用方粘贴邀请码连接；文件传输仍需单独授权。
3. 之后照常委托、取回成果和续作，无需逐项选择网络方式。系统优先尝试私网直连，必要时使用 Tailcat。

开启后，Tailcat 会使用公共中继服务完成发现和连接建立，并尽可能建立直接数据通道；私网数据可以直连，不代表 Tailcat 启动完全不依赖公共服务。公共中继可能影响速度和可用性，不保证任意网络必通。关闭此设置时 sub2sub 不启动 Tailcat；已有私网连接继续可用，系统自行配置的 VPN 不受此开关控制。

已有连接不会自动迁移。双方开启服务后，在使用方连接详情中选择“为此连接启用跨网络访问”，或明确要求迁移该连接。程序验证原设备身份与新入口后才保存，保留原配对、传输授权、任务副本和会话。如果原地址已不可达，可提供同一设备的新邀请码验证；失败保留旧连接，不能用删除重配代替迁移。

旧版提供方须先升级才能提供跨网入口；旧版调用方仍可使用已保存的直接连接，但须升级才能读取新版跨网邀请码。已有 Tailscale IPv4 连接保持原方式，可继续用 `100.64.0.0/10` 私网入口，不要求迁移；原地址接口仍只接受私网 IPv4，不接受任意公网地址、MagicDNS 或 IPv6。

关闭服务或退出节点前，跨网活动任务、正在传输的成果和结果未知的提交须先完成或由用户明确取消。无法确认远端状态时会保留开启状态并提示待处理任务。停止接单只停止新任务；已有任务、取消和成果取回继续可用。设备间跨网传输不改变执行任务的联网、浏览器、MCP 或应用权限。

## 更新

直接在对话中说“检查 sub2sub 更新”，助手会调用 `update_plugin` 的 `check`，只查询最新正式版，并分别显示当前对话加载版本、当前宿主实际登记的安装版本和运行节点版本。对话加载版本不代表已安装版本；节点不可达或未运行时会明确说明。

明确说“升级 sub2sub”后，`install` 会使用原有发行包下载、校验和安装流程，只更新当前管理宿主的已登记目录。它不根据提供方执行工具猜测宿主，不新建另一份安装，也不降级较新的版本或预发行安装。来源安装或旧安装无法确定宿主时，需要明确宿主；登记目录仍无法确认时，按本文原安装流程处理。Codex 和 Claude 的安装分别更新。

有活动任务、尚未保存或状态不确定的本地委托时，升级暂缓。先等工作结束，查询任务状态并保存成果后重试；升级不会取消任务、清理数据或重启节点。安装保留配对、证书、配置、任务数据、本地成果和旧版程序目录。失败信息标明查询或下载/安装环节；若安装曾中断，先核查宿主插件列表，不能把安装尝试当作成功。

安装完成且宿主登记验证通过后，Codex 桌面用户完整退出并重新打开应用；仅关闭窗口或新建对话不足以确保加载新版。CLI 用户退出并重启 `codex` 或 `claude`。独立节点继续运行原版；等它空闲后，在新对话中明确使用现有退出节点和开启共享操作，才能加载新版。**从 0.5.3 升级时，共享进程依附旧提供方对话，没有新版的独立节点退出命令；先完成任务、保存成果，再结束旧提供方对话，由新对话开启共享。** 0.5.3 本身没有对话升级工具，首次升到提供该工具的版本仍需运行本文安装命令。身份未改变时无需重新配对；两端沿用现有能力检查，不保证任意新旧版本互通。

两个宿主均使用 `sub2sub@sub2sub` 作为插件标识。Codex 安装器还会在确认新安装启用后迁移其他来源的旧 sub2sub；Claude 安装器只管理其用户级安装。其他插件不变。

需要指定已发布版本时，先设置 `SUB2SUB_VERSION`，再运行同一命令。只有包含一键安装发行包的版本才支持此方式。回退前退出节点并查看版本说明。旧版不支持本版的 Claude 任务和分工具设置；先保存并结束 Claude 任务、按需清理其历史，再切回 Codex。不要用旧版继续或清理保留的 Claude 任务。

## 安装异常

**插件登记失败：**若出现 `plugin add/install/update failed` 或 `Operation not permitted`，安装尚未确认完成，即使程序文件已经存在。在你本机正常终端运行 `codex plugin list` 或 `claude plugin list`，检查 `sub2sub@sub2sub` 的版本和启用状态；重试时使用相同宿主和原安装目录（自定义目录沿用 `SUB2SUB_INSTALL_DIR`）。`Operation not permitted` 表示系统拒绝了该操作，单凭这行信息无法确定权限来源；保留错误末尾用于排查，不需要删除配对或使用 sudo。

安装和重启后先说“查询 sub2sub 状态和版本，不修改设置”。确认当前对话已加载所需版本，再按 [README 首次使用步骤](../README.zh-CN.md#连接工作节点) 配对和委托。

- **下载失败：**确认当前网络可访问 GitHub Releases，再次运行安装命令。
- **找不到 Codex：**先打开并登录 Codex。特殊安装位置可设置 `SUB2SUB_CODEX` 为原生可执行文件的绝对路径，再重试；Windows 需要 `codex.exe`，不能填写 `.cmd` / `.bat`。
- **找不到 Claude：**安装原生 Claude Code CLI 后重新打开终端。特殊位置可用 `SUB2SUB_CLAUDE` 指定可执行文件的绝对路径；Windows 需要 `claude.exe`。
- **安装成功但没有工具：**完整退出并重新打开 Codex 桌面应用，或退出并重启 CLI。在当前使用的工具中运行 `codex plugin list` 或 `claude plugin list`，检查 `sub2sub@sub2sub` 是否安装并启用。
- **Windows SSH 环境拒绝访问桌面包：**在桌面用户的 PowerShell 中安装与运行。SSH 系统会话与桌面会话的应用权限、沙箱行为可能不同。

可用 `SUB2SUB_INSTALL_DIR` 指定程序目录；更新时沿用同一目录。更多诊断见[故障排查](troubleshooting.md)。

## 停止与卸载

“停止 sub2sub 共享”会停止接收新任务，当前任务仍可完成和取回。需要停止后台进程时，明确说“退出 sub2sub 节点”；活动任务须先结束或取消。仅关闭管理应用不会退出节点。

卸载前先保存需要的成果并退出节点，再在插件目录卸载，或运行：

```sh
codex plugin remove sub2sub@sub2sub
```

Claude Code 使用 `claude plugin uninstall sub2sub@sub2sub --scope user`。每条命令只卸载对应宿主中的插件。

程序、任务记录和本地成果是分开的。卸载插件不会替你删除成果；任务与原生会话的删除按[清理选择](usage.md#任务生命周期)处理。需要释放旧程序占用时，在相关会话退出后删除安装目录中的旧 `versions` 子目录，保留当前安装使用的版本。
