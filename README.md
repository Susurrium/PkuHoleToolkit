# PKU Treehole Toolkit

一个可以独立使用的北大树洞本地备份与关注迁移用户脚本。

Toolkit 直接运行在树洞官网中：你可以把当前账号关注的树洞保存为本地 `.treehole.zip`，也可以在换号时只迁移尚未关注的帖子。导出不修改关注、帖子或评论；使用本地备份不需要安装任何其他软件。

PkuHoleStudio 是可选的本机桌面端联动。已经使用 Studio 的用户可以把同一份备份直接发送到桌面端继续管理；不了解或不使用 Studio 的用户可以完全忽略它，Toolkit 的本地备份、任务恢复和关注迁移均可独立工作。

## 最短使用路径

### 备份到本机

1. 安装脚本并登录 `https://treehole.pku.edu.cn/web/`。
2. 打开页面工具栏中的 Toolkit 入口。
3. 选择备份范围；一般直接使用“全部关注”。
4. 按需决定是否包含评论、可读文本和一层引用内容，然后开始生成备份。
5. 浏览器会下载一个 `.treehole.zip` 文件。请把它保存在可信的位置；需要时可以重新下载最近生成的备份。

导出的 ZIP 包含机器可读数据，并可选包含便于直接查看的 `readable.txt`。大批量任务可以暂停、取消，并在七天内从断点继续；部分失败时只需重试未完整项目。

### 换号迁移关注

1. 先在旧账号中生成并保存备份。
2. 登录要接收关注的新账号，打开 Toolkit 的关注迁移入口。
3. 选择 Toolkit ZIP，或旧版 `{ holes, comments }` JSON，然后点击“检查备份”。
4. 核对“将新增”和“已关注”数量后再确认迁移。

迁移只会向当前登录账号新增尚未关注的 PID，不会取消或覆盖已有关注，也不会把正文、评论重新发布到树洞。归档中的 `referenced` 引用上下文不会被关注；检查未能完整读取当前关注列表时，Toolkit 会禁止执行写入。

### 可选：发送到 PkuHoleStudio

如果已经安装 PkuHoleStudio，可以在 Toolkit 中主动关联本机 Studio，并把生成的同一份备份发送过去；也可以同时保留浏览器下载。Toolkit 未选择 Studio 时不会连接本机端口。

首次持续关联需要在 Studio 中核对一次，之后发送无需反复复制接收码。发送前 Toolkit 会协商 Studio 支持的归档 schema、扩展和文件大小，上传后仍由 Studio 预检，再由用户确认导入。旧版一次性接收码继续作为兼容入口。

## 功能范围

- 从当前登录账号备份全部关注、指定收藏分组、指定 PID 或日期范围；日期按帖子发布时间和浏览器本地自然日筛选，并包含首尾。
- 可选择正文、评论，以及正文或评论中的一层 `#PID` 引用。
- 默认生成一个 `.treehole.zip`，包含 `manifest.json`、`data.json` 和可选的 `readable.txt`。
- 支持暂停、取消、七天内恢复，以及只重试未完整项目；最近完成的备份可重新下载。
- 支持导入新版 ZIP 和旧版 `{ holes, comments }` JSON；执行前会预检、合并去重并二次确认。
- 单次关注 POST 不自动重试。用户手动重试未完整项时，Toolkit 会先读取当前状态，确认仍未关注才重新尝试，并再次核对最终状态。
- 可选发送到已关联 PkuHoleStudio。Studio 不可用或发送失败不会影响已经完成的本地备份。

## 安装

当前正式版本为 `v1.4.1`。可从 [GitHub Release](https://github.com/Susurrium/PkuHoleToolkit/releases/tag/v1.4.1) 获取命名后的 `.user.js` 附件；安装前请先禁用旧版同名脚本。真实环境验收记录见 [`BETA_TEST_CHECKLIST.md`](./BETA_TEST_CHECKLIST.md)。

1. 安装 Tampermonkey 或 Violentmonkey。
2. 打开根目录生成文件 `PKU-Hole export tool.user.js` 并安装。
3. 登录 `https://treehole.pku.edu.cn/web/`，工具会在搜索按钮附近显示入口。

如果官网工具栏尚未出现，脚本会在 10 秒后显示右下角浮动入口。

## 安全与隐私

- 本地导出只读取树洞数据，不会修改关注、发帖或评论。关注迁移必须先检查备份并由用户确认，且只新增当前账号尚未关注的 PID。
- 树洞数据请求仅访问 `https://treehole.pku.edu.cn/api/*`。只有用户主动选择 Studio 联动时，脚本才会把归档 ZIP 发送到本机 `http://127.0.0.1:<端口>`；不会向 Studio 发送树洞账号、Cookie、token 或 UUID。
- token、Cookie 和原始 UUID 不写入 IndexedDB 或归档。IndexedDB 任务记录只保存不可逆账号指纹，用于阻止跨账号恢复断点；该指纹不会写入 ZIP。
- Studio 持续关联使用浏览器生成的 ECDSA P-256 设备密钥：私钥只保存在用户脚本管理器的私有存储中，Studio 只保存公钥。每次传输仍使用短时、一次性且绑定文件名、大小和 SHA-256 的签名票据，任一端均可撤销关联。
- 兼容旧版的一次性接收码等待上传 15 分钟，收到文件后另有 30 分钟供用户核对；它不是永久凭据。
- 归档包含用户关注内容和评论，可能十分敏感。请将文件保存在可信设备中，不要随意上传到第三方网站或公共云盘。
- 请勿在多个标签页同时启动大批量任务。遇到 429、401 或 403 时任务会暂停或停止，不要通过提高并发绕过服务端限制。

## 归档与兼容性

Toolkit 使用 PkuHole Archive Contract 2.1.0。Archive 2.1 以 ZIP STORE 作为 Toolkit 和 Studio 都能读取的写入基线，并通过双方真实导出黄金包持续执行互操作测试；能力协商结果按 Studio 实例短时缓存。

归档协议以独立的 `PkuHoleArchiveSpec` 为中立真源。本仓库在 `packages/archive-schema` 固定并内置 2.1.0 Schema 与契约 fixtures，Toolkit 运行时不依赖 Studio 或 Spec 仓库。

## 开发

要求 Node.js 24 或兼容版本。项目无第三方运行时或构建依赖。

```powershell
npm ci
npm run check
```

源码位于 `apps/userscript/src`，根目录 `.user.js` 是构建产物，不应手工修改。

`tests/fixtures/smoke.html` 可用于手工检查入口挂载和弹窗渲染；真实 API 流程仍应在 GreasyFork beta 与测试账号中验证。

## 发布

- GitHub 是源码和版本真源。
- 正式发布前先使用独立 GreasyFork beta 脚本 ID，以小分组验证请求速率、暂停恢复和下载。
- 正式 GreasyFork ID 建立后，才把其 `@downloadURL`/`@updateURL` 写入稳定构建；当前构建刻意不继承旧脚本的自动更新地址。

## 项目边界

Toolkit 保持为轻量、可独立使用的用户脚本：后续只围绕官网 API/DOM 兼容、导出完整性、安全迁移和归档交付维护。PkuHoleStudio 联动是可选能力；桌面数据库、搜索、标签、笔记和 AI 不在本仓库开发。[`方案设计.md`](./方案设计.md) 是已归档的早期方案，不再作为开发路线图。
