# Toolkit 开发与发布

本页补充 README 中的开发入口，说明验证方式、归档约定和可选 Studio 联动。用户安装与操作请从 [README](../README.md) 开始。

## 环境与构建

使用 Node.js 24，在仓库根目录执行：

```sh
npm ci
npm run check
```

项目以 workspace 组织源码和内置归档 Schema，没有第三方运行时或构建依赖。构建脚本按依赖顺序合并模块，生成根目录 `PKU-Hole export tool.user.js`。修改源码后使用 `npm run build`；生成产物需要一起提交，CI 会检查重建后没有差异。

`npm run check` 包含 JavaScript 语法检查、动态代码执行规则检查、格式检查、Node 自动化测试、构建及产物语法检查。它不调用真实树洞接口，也不能替代真实浏览器和网站兼容性验证。

## 隔离浏览器验证

可在仓库根目录启动本地静态服务，例如：

```sh
python -m http.server 8765 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8765/tests/fixtures/smoke.html`，检查工具入口、弹窗和任务状态。夹具使用模拟 API，不向真实树洞执行操作。

| 地址参数 | 用途 |
| --- | --- |
| `?scenario=default` | 默认入口与面板 |
| `?scenario=paired` | 已关联 Studio 的界面 |
| `?scenario=running` | 运行中的任务 |
| `?scenario=import-preview` | 关注迁移预检 |
| `?scenario=media` | 多图、评论图片与去重 |
| `?scenario=media-partial` | 图片缺失及补抓 |

追加 `&bundle=1` 可验证根目录生成脚本，追加 `&preserve=1` 可保留 IndexedDB 验证刷新恢复。媒体缺失场景的补抓操作见[媒体实现文档](./media-capture.md)。

真实网站验证需要安装候选脚本并使用有权访问的账号。先用小分组验证导出、下载和恢复；涉及新增关注的操作必须由操作者检查并确认。验证记录不得提交账号凭据或私人正文、评论。

## 请求和任务策略

- 正文、评论与媒体共用串行限速队列。当前读取间隔为 600 ms，写入间隔为 1000 ms，另加随机抖动；读取最多尝试三次，401/403、限流和存储错误按类型停止或暂停。配置见 `apps/userscript/src/config.js`。
- 关注列表用于确定范围；保存每个帖子前读取详情。开启评论时始终检查评论接口，不依赖 `reply > 0` 判断是否抓取。
- 服务端回复数和实际导出评论数分别保留。详情失败或实际评论数少于详情回复数时，保留已知内容并标为部分完成；抓取到更多评论不会因旧回复数而被丢弃。
- 正文、评论和图片分别保存完成状态。已核验内容可在恢复或媒体补抓时复用；旧版断点首次恢复会补做必要核验，但不改变用户原有选项。
- 关注 POST 不自动重试。手动重试先读取当前状态，仅对仍未关注的帖子尝试一次写入，并核对最终状态；失败与未知结果进入审计报告。

## 归档与兼容性

使用 PkuHole Archive Contract 2.1.0，协议真源是独立的 [PkuHoleArchiveSpec](https://github.com/Susurrium/PkuHoleArchiveSpec)。仓库内 `packages/archive-schema` 固定 Schema 和契约 fixtures，运行时不依赖其他仓库。

ZIP STORE 是 Toolkit 与 Studio 的共同写入基线。归档保留 `manifest.json`、`data.json` 和可选 `readable.txt`；v1.5.0 增加可选媒体扩展及 `media/index.json`、图片文件。支持旧版 `{ holes, comments }` JSON 的迁移预检。

契约测试使用有效/无效 fixtures 和双方真实导出黄金包检查互操作。它们验证格式兼容性；本次新版媒体文件在 Studio 中的真实导入与离线查看没有进行端到端验收。

`npm run inspect:archive -- <备份路径>` 可检查归档；运行和分享输出前应注意文件中可能包含私人内容。字段定义见[协议](../packages/archive-schema/SPECIFICATION.md)，媒体索引与恢复机制见[媒体文档](./media-capture.md)。

## 隐私与 Studio 联动

树洞请求仅访问官网 `/api/*` 及同域 `/chapi/api/v3/media/getImageBinary`；媒体请求拒绝重定向，不从正文任意 URL 获取二进制。

token、Cookie 和原始 UUID 不写入任务数据库或归档。本地断点保存不可逆账号指纹，用于阻止跨账号恢复；该指纹不会写入 ZIP。图片与内容缓存在 IndexedDB，随任务删除和七天清理一起处理。

Studio 联动只在用户主动选择时访问 `http://127.0.0.1:<端口>`，只发送备份文件，不发送树洞凭据。设备关联使用浏览器生成的 ECDSA P-256 密钥：私钥保存在脚本管理器私有存储中，Studio 保存公钥，任一端可撤销关联。每次传输使用短时、一次性且绑定文件名、大小和 SHA-256 的签名票据。

发送前协商归档 Schema、扩展与体积上限，能力结果按 Studio 实例短时缓存；收到文件后仍先预检，再由用户确认导入。旧版接收码等待上传 15 分钟，收到文件后另有 30 分钟确认窗口。

最近备份刷新恢复时会验证本地图片；损坏缓存会使归档降为部分完成并允许补抓。Studio 发送结果与本地抓取结果分开呈现，发送失败不影响已生成备份。

## 正式发布

GitHub 是源码与版本发布入口。发布步骤为：

1. 同步根目录与用户脚本 package、lockfile 和 `config.js` 的版本号，整理 CHANGELOG 与验收记录。
2. 运行 `npm ci` 和 `npm run check`，核对生成脚本、必要浏览器验证及本次真实环境测试范围。
3. 提交源码和构建产物，合入主线，等待主线 CI 通过。
4. 对通过验证的提交创建版本标签，上传 `PkuHoleToolkit-<版本>.user.js` 及 SHA-256 校验文件，发布 GitHub Release。
5. 检查安装链接、附件和发布标签一致；同步本地安装文件。

当前未配置专用 `@downloadURL` / `@updateURL`，用户通过 GitHub 安装更新，不继承旧脚本的更新地址。如果未来建立独立 GreasyFork 发布渠道，应分别维护候选与正式脚本 ID，并在确认渠道后配置更新地址；本次 GitHub 发布不依赖该渠道。

## 历史记录

[BETA_TEST_CHECKLIST.md](../BETA_TEST_CHECKLIST.md) 是 v1.3.0 的历史验收，[方案设计.md](../方案设计.md) 是早期方案，均不作为当前行为或待验收清单。v1.5.0 的媒体验证记录见[媒体文档](./media-capture.md)。
