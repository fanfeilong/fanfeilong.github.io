# 分类灰库

灰库就是站点首页，入口 `/`；旧 `/books/book-manager/` 地址保留查询参数并跳转到首页。

请在**仓库根目录**运行 `npm ci`，然后：

- `npm run local`：本地整理模式，http://127.0.0.1:8765/ ，所有格式都支持保留 / 不要 / 重置，标记持久保存于本机。不会删除文件。
- `npm run build && npm run preview`：纯静态预览，http://127.0.0.1:4173/ ，与 GitHub Pages 使用同一制品，无整理操作。

依赖统一由仓库根目录的 `package-lock.json` 管理，本目录旧的 package 文件仅是迁移前记录，不再作为安装入口。详细的状态文件位置、测试和发布步骤见根目录 [README](../../README.md)。
