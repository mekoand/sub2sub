# 安装、更新与卸载

[English](install.en.md) · [返回 README](../README.md)

两台电脑都安装 sub2sub。执行任务的电脑登录自己的 Codex 账号，并在工作期间保持在线。

## 一条命令安装

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

## 首次连接

1. 在工作机说“生成 sub2sub 邀请码”。有多个网络地址时，选择另一台电脑能访问的地址。
2. 在发起任务的电脑上粘贴邀请码，给工作机命名，并确认任务文件范围。
3. 用这个名字派发任务。检查交付的本地文件，继续提出修改或结束任务。

邀请码单次使用，10 分钟有效。成功配对后不需要每次重新生成。系统询问网络访问时，允许工作节点在所用私有网络上接收连接；默认端口为 `47631`。

## 在 CLI 中使用

安装后运行 `codex`，在交互会话中使用相同的邀请、派发和续作指令。提供方的 CLI 会话需要一直保持打开；退出会话就会关闭它承载的共享进程。`codex exec` 可以作为任务发起端，但不适合承载持续在线的工作节点。

## 跨网络使用 Tailscale

两台电脑不在同一局域网时，可以使用 [Tailscale](https://tailscale.com/download) 提供设备间连接：

1. 两端安装 Tailscale，加入可互通的网络。团队可以邀请成员或分享指定设备。
2. 在 Tailscale 中查看工作机的 IPv4 地址。
3. 让工作机“用 Tailscale 地址 100.x.x.x 生成 sub2sub 邀请码”，将示例替换为实际地址。
4. 使用者照常粘贴邀请码。保持 Tailscale 在线，网络访问规则允许使用者连接工作机的共享端口。

无需把路由器端口开放到公网，也不需要 Tailscale Funnel。sub2sub 使用 Tailscale 的 IPv4 地址；当前不接受 MagicDNS 名称或 IPv6。已经配对的连接中保存了网络地址，从局域网切换到 Tailscale 时，先保存成果并退出工作机上承载共享的会话，再在新会话中指定 Tailscale 地址开启共享；随后让使用者的助手更新连接地址。

0.5 已支持 Tailscale 常用的 `100.64.0.0/10` 范围，并完成地址处理自动测试；真实跨网络配对与任务回传留待后续版本验证。[Tailscale 地址说明](https://tailscale.com/docs/concepts/tailscale-ip-addresses)

## 更新

先完成或取消活动任务、保存成果，再次运行安装命令。安装器会刷新插件缓存和启动路径，保留已有配对、证书和任务数据。旧版程序目录保留，当前会话不会被强行终止。更新后两端均开启新对话。

安装器使用 `sub2sub@sub2sub` 作为插件标识。如果发现其他来源的旧 sub2sub 安装，会在新安装确认启用后移除旧插件，避免同时加载两份。其他插件和旧 marketplace 列表不变。

需要指定已发布版本时，先设置 `SUB2SUB_VERSION`，再运行同一命令。只有包含一键安装发行包的版本才支持此方式。跨大版本回退前查看对应版本说明，避免旧程序操作不兼容的任务数据。

## 安装异常

- **下载失败：**确认当前网络可访问 GitHub Releases，再次运行安装命令。
- **找不到 Codex：**先打开并登录 Codex。特殊安装位置可设置 `SUB2SUB_CODEX` 为原生可执行文件的绝对路径，再重试；Windows 需要 `codex.exe`，不能填写 `.cmd` / `.bat`。
- **安装成功但没有工具：**开启新对话或重启 CLI，通过 `codex plugin list` 检查 `sub2sub@sub2sub` 是否安装并启用。
- **Windows SSH 环境拒绝访问桌面包：**在桌面用户的 PowerShell 中安装与运行。SSH 系统会话与桌面会话的应用权限、沙箱行为可能不同。

可用 `SUB2SUB_INSTALL_DIR` 指定程序目录；更新时沿用同一目录。更多诊断见[故障排查](troubleshooting.md)。

## 停止与卸载

“停止 sub2sub 共享”会停止接收新任务，当前任务仍可完成和取回。关闭提供方进程会中断执行。

卸载前先保存需要的成果，再在插件目录卸载，或运行：

```sh
codex plugin remove sub2sub@sub2sub
```

程序、任务记录和本地成果是分开的。卸载插件不会替你删除成果；任务与原生会话的删除按[清理选择](usage.md#任务生命周期)处理。需要释放旧程序占用时，在相关会话退出后删除安装目录中的旧 `versions` 子目录，保留当前安装使用的版本。
