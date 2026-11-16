# 灰库 · Fan Feilong

首页直接显示灰库。左侧是知识分类，顶部右侧是博客园、知乎、笔记、随笔与 GitHub 链接。站点发布到 `https://fanfeilong.github.io/`。GitHub Pages 只需要构建出的静态文件；整理标记由本地 Python 后端提供。

## 本地整理（推荐先用这个）

需要 Node.js 22.13+、npm、Python 3.10+。使用 `.nvmrc` 可选择 Node 22。

```sh
npm ci
npm run local
```

打开 http://127.0.0.1:8765/ 即进入灰库。旧 `/books/book-manager/` 地址会保留查询参数并跳转到首页。如果端口冲突，先 `npm run build`，再 `python3 books/book-manager/server.py --port 8766`。

- PDF、Markdown、Word、PowerPoint、图片等全部灰库资料均有“保留 / 不要 / 重置”操作。
- 用“未标记 / 保留 / 不要”筛选整理状态，也可叠加分类、主题、搜索与文件格式筛选。
- “不要”只记录选择，**不会删除原文件**。顶部显示待释放大小，可导出 JSON 清单。
- 标记保存到 `~/.local/state/fanfeilong-library/<仓库路径标识>.json`，重启服务后仍在；不会进入仓库或 Pages 制品。终端会打印实际位置。
- 每条标记包含文件路径、大小、修改时间和 SHA-256。文件变化时旧标记失效，回到“未标记”，需要重新确认。
- 完成一轮后，让维护者根据本地清单核验并移除“不要”的原文件，再重建站点。本项目目前没有删除 API，也不会自动清理源文件。
- 后端仅监听 `127.0.0.1`。测试时可用 `--state-file /某个临时目录/reviews.json` 隔离标记记录。

## 公开静态模式

```sh
npm run build
npm run preview
```

打开 http://127.0.0.1:4173/ 。公开模式没有整理按钮，也不依赖 Python API；收藏、最近阅读和 PDF 页码仅保存在访客当前浏览器。PDF 使用随站点打包的 PDF.js，其他格式使用原文件链接，是否可直接预览取决于浏览器。PDF 画布阅读器没有完整文字层，可下载原 PDF 交给系统阅读器使用搜索、复制与辅助阅读功能。

构建器 `scripts/build.py` 扫描 `books/` 实体资料与旧站根目录的 PDF / Office 文件，生成 `books/book-manager/books.json`，并打包首页和阅读器所需资源。灰库源码、开发依赖、本地标记和测试产物不会发布。专题旧页、播放器与工具下载及其专用资源已移除；当前书目中的保留资料仍正常发布。

新增书籍放入 `books/NN_领域/NN.MM_主题/`，重建后自动出现在主页与灰库。`books/分类索引.md` 是历史手工索引，页面数量以实时扫描为准。构建会拒绝 >=100 MiB 的单个灰库文件和 >=1 GB 的站点制品。

## 验证

```sh
npx playwright install chromium
npm run build
npm test
```

测试用独立临时标记文件，不污染真实整理记录；覆盖静态灰库、PDF 阅读、移动布局、本地全格式标记持久化与访问边界。

## GitHub Pages 发布

发布流程由 `.github/workflows/pages.yml` 管理，`master` 推送后自动构建、测试并部署。Pages 的发布源使用 **GitHub Actions**。后续更新时：

1. 完成资料整理，核验后移除不再保留的源文件。
2. 首次启用或迁移仓库时，确认 Settings → Pages → Build and deployment → Source 为 **GitHub Actions**。
3. 将需要发布的改动和书籍提交并推送到 `master`。
4. `.github/workflows/pages.yml` 自动安装依赖、生成静态站点、运行测试，再部署到 Pages；PR 只验证、不部署。
5. 确认 Actions 的 deploy 成功，再检查线上主页、中文书名链接和 PDF 阅读。
