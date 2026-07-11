# PKU Treehole Toolkit

一个本地优先的北大树洞关注归档与迁移工具。当前可运行产物是油猴用户脚本；未来桌面端只负责长期归档、搜索、标签和笔记。

## 当前功能

- 从当前登录账号导出全部关注、指定收藏分组、指定 PID 或日期范围。
- 可选择正文、评论以及正文/评论中的一层 `#PID` 引用。
- 默认生成一个 `.treehole.zip`，包含 `manifest.json`、`data.json` 和可选的 `readable.txt`。
- 支持暂停、取消、七天内恢复，以及只重试未完整项目。
- 支持导入新版 ZIP 和旧版 `{ holes, comments }` JSON；关注前会预检、去重和二次确认。
- 所有账号写请求只发送一次，响应不确定时通过读取接口核对最终状态。

## 安装

当前公开测试版本为 `v1.3.0-beta.3`。测试者可从 [GitHub Pre-release](https://github.com/Susurrium/PkuHoleToolkit/releases/tag/v1.3.0-beta.3) 获取命名后的 `.user.js` 附件；安装前请先禁用旧版同名脚本。`beta.1` 存在入口观察器自触发导致页面白屏的问题，已经撤回。

1. 安装 Tampermonkey 或 Violentmonkey。
2. 打开根目录生成文件 `PKU-Hole export tool.user.js` 并安装。
3. 登录 `https://treehole.pku.edu.cn/web/`，工具会在搜索按钮附近显示“归档/迁移”。

如果官网工具栏尚未出现，脚本会在 10 秒后显示右下角浮动入口。

## 安全与隐私

- 脚本只请求 `https://treehole.pku.edu.cn/api/*`，不上传导出内容。
- token、Cookie 和原始 UUID 不写入 IndexedDB 或归档；仅在 IndexedDB 任务记录中保存不可逆账号指纹，用于阻止跨账号恢复断点。
- 账号指纹不会写入 ZIP，避免不同归档被关联为同一账号。
- 归档包含用户关注内容和评论，可能十分敏感；请勿随意上传到第三方网站或公共云盘。
- 为保护账号，请不要在多个标签页同时启动大批量任务。
- 429、401 或 403 会暂停/停止任务；不要通过提高并发绕过服务端限制。

## 开发

要求 Node.js 24 或兼容版本。项目无第三方运行时或构建依赖。

```powershell
npm ci
npm run check
```

源码位于 `apps/userscript/src`，根目录 `.user.js` 是构建产物，不应手工修改。归档协议位于 `packages/archive-schema/schema-v2.json`。

`tests/fixtures/smoke.html` 可用于手工检查入口挂载和弹窗渲染；真实 API 流程仍应在 GreasyFork beta 与测试账号中验证。

## 发布

- GitHub 是源码和版本真源。
- 正式发布前先使用独立 GreasyFork beta 脚本 ID，以小分组验证请求速率、暂停恢复和下载。
- 正式 GreasyFork ID 建立后，才把其 `@downloadURL`/`@updateURL` 写入稳定构建；当前构建刻意不继承旧脚本的自动更新地址。

## 项目方向

新版完整目标、架构、数据模型和路线图见 [`方案设计.md`](./方案设计.md)。
