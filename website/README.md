# ContextEngine 官网(website/)

ContextEngine 的营销 + 使用手册静态网站,中英双语。**零构建、零外部依赖**(无 CDN 字体 / 框架),可直接双击打开,也可部署到任意静态托管。

## 结构

```text
website/
├── index.html        # 营销首页(中文):定位、检索管线、核心能力、基准数据、vs Augment、快速上手
├── docs.html         # 使用手册(中文):安装 / CLI / 语义检索 / MCP / HTTP / 配置参考 / 排障 / FAQ
├── en/
│   ├── index.html    # Landing page (English)
│   └── docs.html     # Documentation (English)
└── assets/
    ├── style.css     # 设计系统 v2(深浅双主题、hairline 网格、电光绿单强调色)
    └── main.js       # 交互:主题切换、移动菜单、代码复制、语法高亮、侧栏 scrollspy
```

## 设计语言

- **中性底 + 单一强调色**:深色近纯黑 `#0a0a0b` / 浅色米白 `#fafaf6`,唯一强调色为电光绿(dark `#3df2b0` / light `#0b9e71`),不使用多色渐变。
- **hairline 网格质感**:能力 / 管线 / 数据卡通过 `gap:1px + 边框色背景` 形成共享边线网格;阴影极少,层次靠 1px 细线与留白。
- **mono 层级**:kicker 标签、版本徽标、表头、统计数字统一等宽字体;代码块在浅色主题下保持深底("纸上一块墨")。
- 语言切换:顶栏 `EN / 中` 按钮在同名页面间互跳;主题偏好存 `localStorage("ce-theme")`。

## 本地预览

任选其一:

```bash
# 直接打开
open website/index.html

# 或起一个静态服务器
python3 -m http.server 4173 --directory website
```

## 部署

内容为纯静态文件,直接把 `website/` 目录发布到 GitHub Pages、Cloudflare Pages、Vercel、Netlify 或任意对象存储即可,无需构建步骤。

## 维护约定

- 版本号、基准数字、CLI 与环境变量必须与仓库文档(README / docs/)保持一致;发版时同步更新四个页面中的 `v0.5.0` 标注。
- 深浅主题通过 `<html data-theme>` 切换,新组件颜色一律使用 `assets/style.css` 顶部的 CSS 变量,不写死色值。
- 中英文内容一一对应:改动任一语言的事实性内容(命令、env、指标)时,必须同步另一语言版本。
- 基准数据引用自 `docs/MULTILANG_BENCH.md`(2026-07 公开 T4 实测);更新基准后同步两个首页的 `#bench` 表格与大数字。
- 中文文案标点为全角(代码块与终端注释除外);HTML 属性引号必须是半角直引号。
