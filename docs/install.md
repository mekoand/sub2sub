# 安装、更新与卸载

[English](install.en.md)

[返回 README](../README.md) · [故障排查](troubleshooting.md)

本指南使用源码打包，再通过一个独立的本地 marketplace 安装。双方都需要安装，提供方从桌面登录会话运行。首次设置后，日常操作在 Codex 对话中完成。

## 准备条件

- Node.js 22+、Git，以及支持原生插件和所需 App Server 权限接口的 Codex。
- 提供方使用自己的 ChatGPT 账号登录 Codex；首次创建身份需要 PATH 中的 OpenSSL。
- 两端使用同一版本的 sub2sub，并能通过私有 IPv4 网络直连。
- 提供方允许共享端口入站，默认47631。系统询问时选择符合实际网络的局域网访问范围。

先检查环境中的命令：

```sh
node --version
codex --version
openssl version
```

OpenSSL 只用于提供方首次生成身份。已有身份可以复用；0.4.2 在证书生成时传入插件管理的最小配置，不要求设置 `OPENSSL_CONF`。插件本身没有第三方 npm 依赖。

安装流程使用 Codex 的正常插件入口，它会保存 marketplace 和启用状态。下面的步骤由你在终端执行；无需手工修改 Codex 全局配置或审批规则。命令形态依据[官方插件打包与安装说明](https://developers.openai.com/plugins/build/plugins)及 Codex 0.152.x CLI 帮助。

## 1. 获取源码

```sh
git clone https://github.com/mekoand/sub2sub.git
cd sub2sub
```

以下安装目标是一个**新的独立目录**，不与已有个人 marketplace 混合。如果该目录已经存在，改用新的目录名；不要覆盖已有配置或旧安装包。

## 2A. macOS：准备和检查

在仓库根目录运行：

```sh
sub2sub_market="$HOME/sub2sub-marketplace"
mkdir "$sub2sub_market"
mkdir -p "$sub2sub_market/plugins" "$sub2sub_market/.agents/plugins"
node scripts/package.mjs "$sub2sub_market/plugins/sub2sub"
cp examples/marketplace.json "$sub2sub_market/.agents/plugins/marketplace.json"
/bin/sh "$sub2sub_market/plugins/sub2sub/bin/launch.sh" --check
```

打包的最后一级目录必须叫 `sub2sub`，父目录已存在，目标插件目录不能已存在。启动器优先使用显式 `SUB2SUB_NODE`，然后检查应用自带运行时、Homebrew 和 PATH，跳过低于22的Node。

环境检查输出实际 Node、Codex 路径及状态信息，不生成邀请码或启动共享。若 Codex 不在 PATH，可使用应用内可执行文件的绝对路径执行后续命令。

## 2B. Windows：准备和检查

在**目标 Windows** 的 PowerShell 中，进入源码仓库根目录：

```powershell
$sub2subMarket = Join-Path $HOME 'sub2sub-marketplace'
New-Item -ItemType Directory -Path $sub2subMarket -ErrorAction Stop
New-Item -ItemType Directory -Path "$sub2subMarket\plugins", "$sub2subMarket\.agents\plugins" -Force
node .\scripts\package.mjs "$sub2subMarket\plugins\sub2sub"
Copy-Item .\examples\marketplace.json "$sub2subMarket\.agents\plugins\marketplace.json"
node "$sub2subMarket\plugins\sub2sub\scripts\setup-check.mjs"
```

Windows 打包会把**本次运行的 Node.exe 绝对路径**写入新包的 `.mcp.json`，直接启动 `bin/mcp.mjs`，不需要 `/bin/sh`。移动 Node 后需要重新准备并安装包。不要直接安装仓库根目录的 macOS 启动配置，也不要在 PowerShell 中照搬 `npm start` 或 `npm run check`。

提供方需要原生 `codex.exe`。npm 的 `codex.cmd` / `.bat` 不能作为 `provider.codexPath`；安装检查失败时，将实际原生可执行文件路径配置到 sub2sub 自有设置。不要把另一台电脑的路径直接复制过来。

<details>
<summary>npm 安装后找不到原生 codex.exe</summary>

在源码根目录运行以下 PowerShell，仅搜索 npm 的 `@openai` 目录；找到唯一候选后，保留已有设置并更新 sub2sub 自有的 `provider.codexPath`。若没有或有多个候选，先按本机安装方式确认正确路径。操作前关闭 sub2sub 共享，完成后重启插件。

```powershell
$sub2subNpmRoot = (npm.cmd root -g).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate global npm packages.' }
$sub2subNative = @(Get-ChildItem -LiteralPath (Join-Path $sub2subNpmRoot '@openai') -Recurse -File -Filter codex.exe -ErrorAction Stop)
$sub2subNative.FullName
if ($sub2subNative.Count -ne 1) { throw 'Select the native codex.exe for this device; no configuration was changed.' }
@'
import os from 'node:os';
import path from 'node:path';
import { Config } from './lib/config.mjs';
const file = process.env.SUB2SUB_CONFIG || path.join(os.homedir(), '.config/sub2sub/config.json');
await new Config(file).update(config => {
  config.provider = { ...config.provider, codexPath: process.argv[2] };
});
'@ | node --input-type=module - "$($sub2subNative[0].FullName)"
if ($LASTEXITCODE -ne 0) { throw 'Configuration update failed.' }
node "$sub2subMarket\plugins\sub2sub\scripts\setup-check.mjs"
```

</details>

跨平台打包仅供已知目标路径时使用：

```sh
node scripts/package.mjs /absolute/new/location/sub2sub --windows-node 'C:\Program Files\nodejs\node.exe'
```

这条示例中的 Node 路径必须与目标机一致，不是通用安装位置保证。

## 3. 注册并安装

macOS：

```sh
codex plugin marketplace add "$sub2sub_market"
codex plugin add sub2sub@sub2sub-local
```

Windows PowerShell：

```powershell
codex plugin marketplace add "$sub2subMarket"
codex plugin add sub2sub@sub2sub-local
```

也可以注册 marketplace 后重启桌面应用，在插件目录选择 **sub2sub Local** 并安装。若当前 Codex 不支持这些命令或所需权限接口，先更新 Codex；不要用未经验证的手动 MCP 配置冒充原生插件安装。

`examples/marketplace.json` 中的 `./plugins/sub2sub` 相对于你创建的 marketplace 根目录。它不是相对于 `.agents/plugins/` 的路径。这个示例只包含 sub2sub，不修改你已有的个人插件列表。

```sh
codex plugin list
```

确认 sub2sub 已安装并启用，然后开启**新的 Codex 对话**。只修改源码或发布目录不会自动更新当前运行中的插件进程。

## 4. 开启共享、连接与首次任务

1. 提供方说“生成 sub2sub 邀请码”。有多块网卡时选择另一台设备能访问的局域网地址。
2. 私下发送邀请；使用方粘贴并命名连接。邀请10分钟有效，单次使用。
3. 确认任务文件范围，委托一个小任务，并检查结果已成功保存。
4. 后续直接在同一个委托任务中追加修改；不用每轮重新配对。

Windows 提供方应从桌面登录会话运行。在实测环境中，SSH 的系统会话无法初始化原生沙箱；同一程序在桌面会话成功。此结论不代表所有 Windows 环境表现相同。

## 更新与回退

1. 完成或取消活动任务，取回必要成果，并完成未决的保存确认。
2. 停止接收新任务，保留当前安装包及本地成果。
3. 在新目录准备目标版本，检查环境，再按 Codex 插件入口更新安装；双方同步更新。
4. 开启新对话，确认加载的版本和实际工具可用性，再恢复共享。

0.4.x 使用完整本地副本和增量同步。升级前已有的旧任务不会自动追溯套用七天期限。回退到0.3时给旧版本使用独立的 sub2sub 状态目录，不要让旧程序操作新同步记录。

当前发布目录是程序副本；配对、证书和任务数据在 sub2sub 自有目录。更新不需要删除这些数据。若 marketplace 源路径变化，通过 Codex 的 marketplace 管理命令调整，不直接覆盖整个个人配置。

## 停止和卸载

“停止共享”拒绝新任务，允许当前任务完成和取回。关闭承载共享的进程会中断执行，两者不同。重新开启共享可复用原有配对。

卸载前确认执行已停止、需要的成果已保存。再通过插件目录或以下命令卸载：

```sh
codex plugin remove sub2sub@sub2sub-local
```

卸载程序不等于删除任务、原生历史或本地成果；请在卸载前按[清理选择](usage.md#任务生命周期)处理需要删除的数据。
