# PkuHoleToolkit

**把北大树洞的帖子、评论和图片保存到自己的电脑，也可以在换账号时从备份迁移关注。**

Toolkit 是运行在[树洞网页版](https://treehole.pku.edu.cn/web/)中的用户脚本。安装油猴和 Toolkit 后即可使用，无需编程或部署服务；本地备份和关注迁移都能独立完成。[PkuHoleStudio](https://github.com/Susurrium/PkuHoleStudio) 是可选的桌面端联动。

**[安装 v1.6.0](https://raw.githubusercontent.com/Susurrium/PkuHoleToolkit/v1.6.0/PKU-Hole%20export%20tool.user.js)** · [正式版下载与更新记录](https://github.com/Susurrium/PkuHoleToolkit/releases/latest) · [反馈问题](https://github.com/Susurrium/PkuHoleToolkit/issues)

第一次使用请从[安装与首次使用](#安装与首次使用)开始；想阅读或修改代码，可以直接跳到[开发与贡献](#开发与贡献)。

[功能](#主要功能) · [安装](#安装与首次使用) · [备份](#保存一份备份) · [迁移](#从备份迁移关注) · [Studio](#可选连接-pkuholestudio) · [常见问题](#常见问题) · [隐私](#数据与隐私) · [开发](#开发与贡献)

## 主要功能

### 备份树洞内容

将帖子正文、评论和图片保存到电脑。可以备份全部关注、某个收藏分组、指定帖子，或按帖子发布日期筛选关注内容；也可以补充保存正文或评论中引用的另一层帖子。

### 迁移账号关注

将备份中的帖子加入另一个账号的关注列表。迁移前可以检查待新增和已关注数量，确认后只添加尚未关注的帖子。

### 发送备份到 PkuHoleStudio（可选）

已使用 Studio 的用户，可以将生成的备份直接发送到本机桌面端，检查后确认导入。

[查看版本更新](./CHANGELOG.md)

## 安装与首次使用

### 1. 安装油猴

油猴是管理和运行用户脚本的浏览器扩展，Toolkit 需要通过它运行。

1. 打开 [Tampermonkey（油猴）官网](https://www.tampermonkey.net/)，选择自己的浏览器，按提示安装扩展。
2. 安装后，按浏览器提示允许扩展运行用户脚本。点击浏览器工具栏中的油猴图标，可以查看、启用或停用已安装的脚本。

完全没有用过油猴？完整、详细的流程可以参考这篇图文教程：[https://arthals.ink/blog/pku-art](https://arthals.ink/blog/pku-art)。

这篇教程介绍的是另一个插件 **PKU Art**。只需参考“前置插件需求”中对应浏览器的**油猴安装和权限设置**，完成后回到本页，继续下面的 **“2. 安装 Toolkit”**，无需安装教程中的 PKU Art。

### 2. 安装 Toolkit

打开 **[Toolkit v1.6.0 安装链接](https://raw.githubusercontent.com/Susurrium/PkuHoleToolkit/v1.6.0/PKU-Hole%20export%20tool.user.js)**，在脚本管理器弹出的页面中确认安装。

如果没有弹出安装页面，可以到[正式版发布页](https://github.com/Susurrium/PkuHoleToolkit/releases/latest)下载附件 `PkuHoleToolkit-1.6.0.user.js`，然后通过脚本管理器的文件导入功能安装。不要下载名为 `Source code` 的源码包来安装。

升级或替换旧脚本后，请确认同类树洞导出脚本只启用一个，避免重复运行。脚本管理器中的中文名称是“北大树洞本地备份与关注迁移工具”，英文名称是 `PKU-Hole export tool`。

### 3. 打开树洞

登录[树洞网页版](https://treehole.pku.edu.cn/web/)，刷新页面，然后点击搜索按钮附近的 **“树洞备份”**。

如果工具栏无法挂载入口，脚本会在约 10 秒后显示右下角浮动按钮。首次使用建议先选择一个较小的收藏分组，熟悉操作和下载结果。

## 保存一份备份

### 开始备份

1. 打开“树洞备份”，进入 **“备份到本机”**。
2. 选择“备份范围”。保存全部关注时保持默认；也可以选择某个收藏分组、指定帖子 PID（帖子编号）或按帖子发布日期筛选。
3. 默认包含评论、图片和阅读文本；需要调整时展开 **“更多备份选项”**。
4. 点击 **“生成并下载备份”**，等待任务完成。长任务期间请保留页面，并避免在多个标签页同时启动备份。
5. 浏览器会下载一个以 `.treehole.zip` 结尾的文件。查看完成提示和缺失数量，再把文件保存在自己的电脑中。

日期筛选针对关注帖子的**发布时间**，不是关注时间；采用浏览器所在时区的自然日，包含开始和结束日期。指定 PID 则可以读取当前账号有权访问的帖子，不要求已经关注。

### 查看下载的文件

`.treehole.zip` 是普通 ZIP 文件，解压后即可查看：

| 文件 | 用途 |
| --- | --- |
| `readable.txt` | 用文本编辑器打开，阅读帖子和评论；默认生成，关闭阅读文本选项后不生成 |
| `media/` | 已保存的图片原始文件，存在图片备份数据时生成；可使用支持对应格式的图片查看器打开 |
| `media/index.json` | 记录图片与帖子、评论的对应关系，以及缺失情况 |
| `data.json`、`manifest.json` | 供工具读取的内容、备份范围和完成情况；迁移时无需手动编辑 |

**阅读文本会列出图片文件路径，图片不会直接嵌在文本中。** 需要迁移关注或导入其他工具时，保留原始 ZIP，直接选择整个备份文件。

### 选择备份内容

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| 包含评论 | 开启 | 保存评论；关闭后也不会抓取评论中的图片 |
| 备份图片 | 开启 | 保存帖子以及所选评论的图片原始文件 |
| 附带可直接阅读的文本 | 开启 | 生成 `readable.txt` |
| 补全一层引用内容 | 关闭 | 保存正文或正文与评论中引用的帖子；可能加入范围之外的内容，增加任务耗时 |

图片保留原始文件，包括 GIF 动画。当前媒体备份支持树洞图片，不下载正文中任意外部链接，也不抓取音频或视频。

单张图片上限为 **50 MiB**，图片文件合计上限为 **180 MiB**，整个备份上限为 **200 MiB**。图片超限或下载失败时会记录为缺失，其他已完成内容仍可保存；整个备份超限时需要缩小范围。图片较多时，建议按收藏分组或日期分次备份。

### 暂停、继续和重试

任务运行时可以点击 **“暂停”**，待安全暂停后再离开页面。重新打开 Toolkit 时，可以在原账号、原浏览器环境中点击 **“继续上次任务”**。断点保留七天；清理网站数据或切换浏览器会影响恢复。

如果显示“部分完成”，可以先保存已有内容，再点击 **“重试未完成项”** 补抓。最近生成的完整或部分备份也可以通过 **“重新下载”** 获取；**“按相同设置再次备份”** 会开始一次新的抓取。

## 从备份迁移关注

1. 在旧账号中生成并保存备份。
2. 登录接收关注的新账号，打开 Toolkit 的 **“迁移关注”**。
3. 选择备份文件，点击 **“检查备份”**。支持 Toolkit ZIP 和旧版 JSON；多个文件会自动合并去重。
4. 核对“将新增”“已关注并跳过”“仅作引用，不迁移”和“存在问题”等数量，再确认执行。

检查阶段只读取数据；**确认后才会向当前账号新增关注**。迁移不会取消已有关注，不会重新发布正文或评论，也不重建原账号的收藏分组。补全引用的帖子只用于阅读上下文，不会自动关注。

如果当前关注列表未能完整读取，工具会禁止执行迁移。结果不确定或有未完成项时，手动重试会先核对当前关注状态，避免重复写入；任务结束后会下载迁移审计文本。

## 可选：连接 PkuHoleStudio

已经使用 [PkuHoleStudio](https://github.com/Susurrium/PkuHoleStudio) 的用户，可以把备份发送到本机桌面端继续管理。

1. 启动本机 Studio，在 Toolkit 的“备份到本机”中展开 **“可选：连接 PkuHoleStudio”**。
2. 点击 **“连接 PkuHoleStudio”**，在 Studio 中核对并批准关联。
3. 备份完成后点击 **“发送到 Studio”**，或选择备份完成后同时发送。
4. 在 Studio 中查看预检结果，再确认导入。

首次关联后无需每次复制接收码；旧版一次性接收码入口仍保留。未选择联动时 Toolkit 不会连接本机端口，Studio 不可用或发送失败也不会影响已经生成的本地备份。

## 常见问题

### 安装后没有“树洞备份”入口？

确认脚本已启用、浏览器允许运行用户脚本，并且打开的是 `https://treehole.pku.edu.cn/web/`。登录后刷新页面，再等待约 10 秒检查右下角。仍然没有入口时，请反馈浏览器、脚本管理器和 Toolkit 版本。

Chrome / Edge 等浏览器的脚本运行权限设置，可以参考 [Tampermonkey 官方说明](https://www.tampermonkey.net/faq.php?q=Q209)。

### 没有看到下载文件？

先检查浏览器的下载列表及下载拦截提示。如果“最近备份”已经出现，可点击“重新下载”；不必重新抓取全部内容。

### “部分完成”是否意味着整个备份不能用？

已保存的内容仍可使用；提示表示某些帖子详情、评论或图片没有完成抓取或检查。查看任务提示及备份中的缺失记录，再重试未完成项。删除或无权访问的内容不能保证补回。

### 为什么备份里的评论数与官网回复数不同？

官网提供的回复数可能与评论接口返回数量不一致。Toolkit 实际读取评论，保留服务端回复数原值，并单独统计已保存的评论数量。开启评论时，显示为零回复的帖子也会检查评论接口。

### 图片为什么缺失，或保存后无法打开？

可能是图片已无法访问、下载失败、超过体积限制，或格式无法识别。关闭图片备份也不会保存图片文件。已保存图片保持原格式；部分格式需要使用支持它的查看器。具体缺失情况可查看任务提示和 `media/index.json`。

### 登录过期、遇到限流，或换了账号怎么办？

按提示暂停操作，重新登录原账号或等待后再继续。原账号的断点不能在另一个账号恢复；迁移关注时也必须在接收账号重新检查备份。不要通过多开任务或提高并发绕过限流。

### 更新后会自动升级吗？

当前脚本没有配置专用自动更新地址，请从[正式版发布页](https://github.com/Susurrium/PkuHoleToolkit/releases/latest)安装新版，并确认旧副本已禁用。更新前请先下载需要保留的备份。

### 必须安装 Studio 吗？如何反馈问题？

Toolkit 可以独立备份、阅读解压后的文本与图片、迁移关注。遇到问题请到 [GitHub Issues](https://github.com/Susurrium/PkuHoleToolkit/issues)提供版本、浏览器、操作步骤和错误提示；提交截图或日志前，请遮盖账号凭据和私人内容。

## 数据与隐私

- 备份只读取树洞数据。只有在迁移预检之后由你确认，工具才会新增关注。
- 导出使用当前网页登录状态，请求树洞官网的正文、评论和图片接口；不会把内容上传到远程备份服务。主动选择 Studio 联动后，才会向本机 Studio 发送备份文件。
- 任务断点和图片缓存在当前浏览器的网站存储中，保留七天。账号凭据不写入任务数据库或备份；本地账号指纹仅用于限制跨账号恢复，不进入 ZIP。Studio 只接收备份，不接收树洞账号、Cookie、token 或 UUID。
- 下载文件包含帖子和评论等私人内容，请妥善保管。备份文件本身没有加密；断点的七天保留规则不会删除已经下载到电脑的文件。

“完整备份”表示在所选选项和本次可访问数据范围内完成抓取与检查，不代表能恢复服务器已删除的内容；持续抓取期间也可能出现新评论。协议与 Studio 关联的实现说明见[开发文档](./docs/development.md)。

## 开发与贡献

Toolkit 使用 JavaScript 模块开发，构建为单个用户脚本，无第三方运行时或构建依赖。建议使用 **Node.js 24**。

```sh
git clone https://github.com/Susurrium/PkuHoleToolkit.git
cd PkuHoleToolkit
npm ci
npm run check
```

`npm run check` 执行语法与安全规则检查、格式检查、自动化测试、构建和生成脚本语法检查。单独构建使用 `npm run build`。

源码位于 [`apps/userscript/src`](./apps/userscript/src)，根目录 [`PKU-Hole export tool.user.js`](./PKU-Hole%20export%20tool.user.js) 是构建产物；请修改源码后重新生成，不要手工修改产物。

### 从哪里读代码

| 模块 | 职责 |
| --- | --- |
| [`main.js`](./apps/userscript/src/main.js)、[`credentials.js`](./apps/userscript/src/credentials.js) | 启动、当前登录凭据与账号绑定 |
| [`api.js`](./apps/userscript/src/api.js)、[`scheduler.js`](./apps/userscript/src/scheduler.js) | 官方接口、并发读取、分页、限速、重试与取消 |
| [`export-job.js`](./apps/userscript/src/export-job.js)、[`media.js`](./apps/userscript/src/media.js) | 范围、详情与评论抓取、引用补全、图片获取与校验 |
| [`storage.js`](./apps/userscript/src/storage.js) | IndexedDB 断点和图片缓存 |
| [`archive.js`](./apps/userscript/src/archive.js)、[`zip.js`](./apps/userscript/src/zip.js) | 归档、阅读文本与 ZIP 读写 |
| [`import-job.js`](./apps/userscript/src/import-job.js) | 关注迁移预检、去重、写入与审计 |
| [`studio-bridge.js`](./apps/userscript/src/studio-bridge.js)、[`ui.js`](./apps/userscript/src/ui.js) | 可选 Studio 联动与页面交互 |

备份流程为：确定范围 → 逐帖读取详情与评论 → 保存图片和断点 → 生成 ZIP。评论和图片分别记录完成状态，补抓图片时复用已经核验的正文与评论。

### 协议、验证与贡献入口

- [开发与发布说明](./docs/development.md)：本地验证、隔离浏览器夹具、请求策略、隐私和 Studio 协议。
- [图片备份实现与验收记录](./docs/media-capture.md)：媒体接口、原始文件、缓存、体积边界和真实环境验证范围。
- [归档协议](./packages/archive-schema/SPECIFICATION.md)：固定内置 PkuHole Archive Contract 2.1.0；运行时无需安装 Studio 或 Spec。媒体采用可选扩展，旧版 JSON 继续兼容。协议真源为 [PkuHoleArchiveSpec](https://github.com/Susurrium/PkuHoleArchiveSpec)。

欢迎通过 Issue 描述问题，或提交包含必要验证的 Pull Request。Toolkit 的维护范围是官网兼容、备份完整性、关注迁移和归档交付；桌面数据库、搜索、标签、笔记和 AI 功能由其他项目负责。

## 相关项目、更新记录与许可证

- [PkuHoleStudio](https://github.com/Susurrium/PkuHoleStudio)：可选的桌面端联动。
- [CHANGELOG](./CHANGELOG.md) 与 [GitHub Releases](https://github.com/Susurrium/PkuHoleToolkit/releases)：版本变化和可安装脚本。
- [v1.3.0 Beta 验收记录](./BETA_TEST_CHECKLIST.md)与[早期方案](./方案设计.md)：历史资料，不作为当前安装指南或开发路线图。

本项目采用 [MIT License](./LICENSE) 开源。感谢 Arthals 提供的油猴安装图文教程。
