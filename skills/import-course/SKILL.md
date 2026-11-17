---
name: import-course
description: 根据课程 URL 核实官方信息，在本仓库“课程”分类创建或更新规格化课程 Markdown；用于归档课程介绍、课表、考核和学习资源。
---

# 从课程 URL 创建课程条目

在包含 `books/book-manager/server.py` 的仓库根目录执行。课程源文件位于 `books/07_课程/<主题>/<课程ID>.md`；构建器会将其加入左侧“课程”目录，并生成站内阅读页。

先读 [课程规格](references/course-schema.md)，按其中的字段与章节组织内容。

1. 获取用户指定的课程页，再按需核对同届 syllabus/application、grading、instructor 和 resources 等一手页面。可用 `python3 <本技能目录>/scripts/course.py fetch URL` 提取页面正文与绝对链接；动态网页用可用的浏览器工具补充，不把空页面当作没有课程信息。
2. 记录课程名称、机构、课程号、届次、教师、授课方式、时间地点、投入、先修要求、考核和公开资源。每项事实应能回到来源；未知字段写 `null`，在“信息缺口”说明。依据主题归纳的学习目标需明确标为归纳。区分公开课件与可报名的在线课程；不能从关联的其他项目推断本课程收费、证书或招生条件。
3. 课程 URL 和届次用于查重。更新同一课程保留原 `id` 和手写“学习记录”；新届次独立建条目。核实网页时填实际核实日期。无需收集学生名单、联系方式或整站下载，保留必要的课件、作业链接即可。
4. 将规格元数据写到临时 JSON、正文写到临时 Markdown，运行：

   ```sh
   python3 <本技能目录>/scripts/course.py create --spec /path/course.json --body /path/body.md --topic 数字制造
   ```

   更新已有文件时加 `--update`。命令会校验规格、检查 URL 重复并写入课程目录；失败不会覆盖原文件。
5. 运行 `python3 <本技能目录>/scripts/course.py validate <课程文件>`，再运行 `python3 scripts/build.py --sync-resources` 登记独立资源入口并构建。检查课程标题、来源、侧边栏分类和站内页面。生成或更新条目不等于用户授权提交、发布或报名课程。

交付课程文件路径、核实的课程 URL、缺失或不可访问的信息，以及实际完成的验证。
