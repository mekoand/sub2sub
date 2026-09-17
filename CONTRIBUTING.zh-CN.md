# 参与 sub2sub

[English](CONTRIBUTING.md) · **简体中文**

欢迎用中文或英文参与：改进文档和翻译、复现缺陷、提交小范围修复，或讨论其他执行工具的适配。这是社区维护项目，请尊重参与者，并根据实际观察讨论问题。

## 开始前

先搜索[已有 Issues](https://github.com/mekoand/sub2sub/issues)。功能或行为变更请先创建或补充 Issue，说明问题、预期结果和范围，再开始实现。纯文案或错别字修正可直接提交 PR。[Issue 工作流](https://github.com/mekoand/sub2sub/blob/main/docs/agents/issue-tracker.md)说明较大工作的跟踪方式；参与贡献不需要安装特定技能或 Agent 工具。

修改行为前，阅读[架构](docs/architecture.md)和[执行边界](docs/usage.md#派发和追加需求)。配对、权限、清理或持久化数据的较大调整需要先讨论。希望适配其他工具时，先在 Issue 中说明其执行、权限、会话和用量接口。

不要公开邀请码、凭据、真实任务内容、私网地址或私人路径。测试使用合成数据，日志和截图先脱敏。安全漏洞请使用[私密报告入口](SECURITY.md)，不要发到公开 Issue。

## 提交修改

1. Fork 仓库并克隆自己的副本，从最新 `main` 创建分支：

   ```sh
   git clone https://github.com/YOUR-USERNAME/sub2sub.git
   cd sub2sub
   git switch -c fix/short-description
   ```

2. 使用 Node.js 22+，按 CI 的方式安装依赖：

   ```sh
   npm ci --omit=optional --ignore-scripts
   ```

   Host 使用本机安装的 Claude CLI，不需要 SDK 附带的可选 CLI 二进制。

3. 保持修改范围集中。行为变化在已有公开接口处补充回归测试；文档修改核对链接和事实即可，不需要额外造测试。同步维护 `README.md`、英文副本 `README.en.md` 和 `README.zh-CN.md`。

4. 运行相关检查，记录实际结果：

   ```sh
   # macOS / Linux
   npm run check
   npm test

   # Windows 平台回归
   node --test test/platform.test.mjs
   ```

   CI 在 Linux/macOS 运行完整套件，在 Windows 运行专门的平台测试，两者不能互相替代。真实模型 smoke 脚本会消耗登录账号的额度并产生原生历史，只有明确授权后才能运行。另见[开发与打包](docs/development.md)和[验证范围](docs/validation.md)。

5. 提交代码并推送到自己的 fork，向 `mekoand/sub2sub:main` 发起 PR。说明问题、修改后的行为、实际检查和限制。关联 Issue，完整实现其范围时才使用 `Closes #N`；纯文案 PR 可注明无需 Issue。

## 审查约定

采用最小充分改动。在外部输入、文件、进程和网络边界做必要校验，保留有用的错误原因，避免静默兜底。一次性操作不引入通用框架。执行、清理、持久化状态和发行打包改动在合入前需要独立审查。

修改打包逻辑后，准备一个新包并核对内容：包含许可证和所链接的公开文档，不包含本地状态、内部笔记或凭据。

贡献按仓库的 [MIT 许可证](LICENSE)分发。使用 AI 服务仍需遵守其条款；sub2sub 不是 OpenAI 或 Anthropic 的官方产品。
