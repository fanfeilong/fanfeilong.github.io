# course/v1 课程规格

每个课程是一个 UTF-8 Markdown 文件。文件开头以两行 `---` 包住一个 JSON 对象；这是 JSON 兼容的 YAML front matter，便于标准库读取，不引入 Python YAML 运行依赖。正文使用普通 Markdown。

字段约定（字段均需出现，未知可空的字段使用 `null`）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| schema_version | string | 固定 `course/v1` |
| id | string | 固定资源 ID，小写字母、数字和连字符；更新时保留 |
| title | string | 官方名称 |
| title_zh | string/null | 中文名称；非官方译名在正文注明 |
| provider | string/null | 主办机构 |
| course_codes | string[] | 官网列出的课程号；未列出时空数组 |
| year | integer/null | 本届年份 |
| term | string/null | 学期；推断应注明依据 |
| source_url | string | 课程主页的 HTTP(S) URL |
| language | string/null | 授课或资料语言；不能由国籍推断 |
| instructors | string[] | 已核实教师；未知空数组 |
| delivery | string/null | 线下、在线、混合或公开资料等事实 |
| location | string/null | 官方地点 |
| schedule | string/null | 官方时间写法，不擅自补时区或 AM/PM |
| credits | number/null | 官网数值，不换算学分体系 |
| credit_unit | string/null | 官网单位或说明 |
| weekly_hours | number/null | 预期每周投入 |
| prerequisites | string/null | 官方先修与适用条件 |
| enrollment | string/null | 报名或选课条件，不写无法核实的当前开放状态 |
| cost | string/null | 费用；未知不等于免费 |
| certificate | string/null | 证书；未知不等于提供证书 |
| license | string/null | 资料许可；公开访问不等于自由转载 |
| summary | string | 简短、事实性的中文介绍 |
| topics | string[] | 主题标签 |
| last_checked | YYYY-MM-DD string | 实际核实日期 |
| sources | object[] | 每项包含 `title`、`url`、`checked_at`；至少包括主页 |

正文必须包含：`## 课程概览`、`## 学习目标`、`## 课程安排`、`## 考核与作业`、`## 学习资源`、`## 信息缺口`、`## 来源`。

课程安排尽量使用 `日期 / 主课主题与链接 / 辅导课或截止事项` 表格；没有官方课表时明确未提供，不填造出的周次。来源使用正文链接与末尾来源表，关键报名、考核信息引用其实际页面。表中日期与时间保留官网的精度。

可选 `## 学习记录` 用于本地学习计划、进度或笔记，与官方事实分开；更新工具会保留该章节。禁止把任务完成状态写成已修完课程、已取得证书或已报名。

`books/book-manager/server.py` 的 `parse_course()` 是构建与辅助工具共用的规格校验入口。首次创建后运行 `python3 scripts/build.py --sync-resources`，课程的 `id` 将登记到资源表。更名或移动源文件时同时更新资源表路径，保留 ID。
