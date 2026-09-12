# LaTeX 编辑器

LaTeX 文档以卡片保存在所属工作空间，与文献、Markdown 和图片资产一起排布、缩放及连线。工作空间工具栏或画布右键菜单的“添加 LaTeX 文档”打开浮层，新建或导入后留在画布并显示新卡片；点击卡片才进入编辑器。可导入一个 `.tex` 文件、ZIP、tar/tar.gz 源码包，也可通过工作空间的通用文件导入添加 `.tex`。多文件论文请导入完整源码包；单独导入 `.tex` 不会扫描其原始目录。

编辑器以项目名称在顶层打开标签，与工作空间、Markdown 文档和 PDF 并列。左上角返回按钮保存当前源码并回到所属工作空间，保留画布位置和卡片布局。已有项目首次加载会补建卡片；移除卡片保留源文件，之后可在“添加 LaTeX 文档”浮层中重新添加。关闭编辑器标签也不会删除项目或卡片。

从工作空间添加或恢复 LaTeX 卡片时，会避开现有卡片；若新卡片位于视野之外，画布自动定位到新卡片，原有卡片位置不变。

项目保存在该工作空间的本地沙箱 `work/latex/<项目 ID>/files/`，从工作空间工具栏可在 Finder 中打开沙箱。文件列表支持编辑 `.tex`、`.bib`、`.sty`、`.cls` 等源码，添加子目录中的新源码，以及选择主文档。编辑自动保存，⌘S 手动保存，⌘F 查找替换，⌘Return 编译。窄工作空间编译成功后自动切换到 PDF，可用文件路径右侧的“源码 / 分栏 / PDF”视图按钮切换；宽面板可同时查看源码与预览，PDF 默认适应可用宽度。可下载当前源码和导出上次成功编译的 PDF。

工作空间中的 PNG、JPEG、PDF、EPS 图片可从编辑器左侧插入。图片复制到项目主文档旁的 `assets/`，插入的 `includegraphics` 使用相对路径。主文档需要加载 `graphicx`；新建项目已加载。优先插入当前光标位置；若光标在文档正文之外，则插入 `\end{document}` 之前。

AI 的 `refora_workspace` 工具增加 `action="latex"`，参数 `operation="active"` 返回当前打开的项目、文件内容和哈希。之后使用 `operation="write"`，传入 `projectId`、`path`、修改后的 `content` 和读取时的 `expectedHash`。还支持列出项目、读取其他文件、添加源码、选择主文档、复制工作空间图片及编译。编译返回日志，不向模型发送 PDF 的 base64 内容。

编辑器每两秒检查当前文件的外部变更。没有本地修改时自动加载 AI 的修改；有草稿时显示冲突并保留草稿，必须下载草稿或明确重新加载后才能继续。离开工作空间、关闭应用时接入现有的保存等待机制。浏览器本地存储保留意外退出后的草稿恢复副本。

## 本地编译器

安装包含 `latexmk` 的 MacTeX 或 TinyTeX。Refora 查找 `/Library/TeX/texbin`、常见 TinyTeX 安装目录和进程 PATH；也可打开右上角项目操作菜单中的“编译设置”，点击“设置编译器”，选择包含 `latexmk` 的 `bin` 目录。路径按文献库保存。测试时可设置 `REFORA_TEX_BIN`。

支持 pdfLaTeX、XeLaTeX、LuaLaTeX。EPS 图片通过已安装的 Ghostscript (`gs`) 转换，推荐与 TeX 发行版一起安装。缺少宏包或字体时，日志会标出名称，使用发行版的包管理器安装后重新编译。Refora 不自动安装宏包，不上传论文。

编译使用项目临时副本及 macOS 沙箱，禁止联网和读取其他用户文件；禁用 TeX shell escape 和 latexmk 配置文件。Ghostscript 使用 `-dSAFER`。编译总限时 120 秒，单个源码/图片及输出 PDF 限 32 MiB，项目导入限 256 MiB、3000 个支持的文件。路径必须是相对路径，当前支持英文、数字、空格、下划线、连字符、点和目录分隔符，禁止路径穿越、链接、隐藏配置文件。原始导入文件不会被修改。

## 真实论文与期刊模板验证

将下列源码下载为指定文件名（仅用于本地验证，遵循各自许可）：

| 文件名 | 来源 | 主文档 |
| --- | --- | --- |
| `arxiv-1706.03762.tar.gz` | [Attention Is All You Need](https://arxiv.org/src/1706.03762) | `ms.tex` |
| `arxiv-1810.04805.tar.gz` | [BERT](https://arxiv.org/src/1810.04805) | `main.tex` |
| `arxiv-2005.14165.tar.gz` | [Language Models are Few-Shot Learners](https://arxiv.org/src/2005.14165) | `main.tex` |
| `IEEEtran.zip` | [IEEEtran](https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip) | `IEEEtran/bare_jrnl.tex` |
| `elsarticle.zip` | [Elsevier](https://mirrors.ctan.org/macros/latex/contrib/elsarticle.zip) | `elsarticle/elsarticle-template-num.tex` |
| `revtex.zip` | [APS REVTeX](https://mirrors.ctan.org/macros/latex/contrib/revtex.zip) | `revtex/sample/aps/apssamp.tex` |

```sh
uv run --project backend --locked python scripts/validate-latex-corpus.py \
  --sources .tmp/latex-validation \
  --output .tmp/latex-validation/repro \
  --tex-bin .tmp/latex-validation/TinyTeX/bin/universal-darwin
```

脚本使用应用同一套项目导入、主文档选择和编译服务，输出源码 SHA-256、文件数、页数、编译日志、PDF 和 `results.json`。源文件、TeX 运行时和生成物均放在忽略提交的 `.tmp/` 下。

本次测试基于 TinyTeX / TeX Live 2026，补充了 `subfiles tikz-qtree bold-extra elsarticle revtex ieeetran pgfplots todonotes mwe xfrac tocloft tablefootnote chngcntr cm-mf-extra-bold`。BERT 和 GPT-3 源码包包含预生成的 `.bbl`，但不含全部原始 `.bib`；现有参考文献可排版，添加新引用时需自行补齐书目文件。


2026-09-12 的真实源码回归结果：

| 项目 | 导入文件数 | PDF 页数 | 编译结果 |
| --- | ---: | ---: | --- |
| Attention Is All You Need | 23 | 15 | 通过 |
| BERT | 28 | 16 | 通过 |
| Language Models are Few-Shot Learners | 173 | 75 | 通过 |
| IEEEtran 期刊模板 | 31 | 1 | 通过 |
| Elsevier elsarticle 模板 | 20 | 4 | 通过 |
| APS REVTeX 示例 | 41 | 7 | 通过 |

上述源码未被改写。已抽查论文首页、双栏正文、公式、表格和 EPS 图像的渲染。完整日志保留源模板自身的警告和多轮排版中间过程警告；成功编译不代表源码没有警告。最终记录在 `.tmp/latex-validation/final-corpus/results.json`。

界面端到端回归测试为 `tests/e2e/latex.spec.ts`，需要可访问的 macOS 桌面和本地 TeX 运行时：

```sh
REFORA_TEX_BIN=/absolute/path/to/tex/bin npm run test:e2e -- tests/e2e/latex.spec.ts --workers=1
```


界面验收（2026-09-12）通过：Markdown 与 LaTeX 标签并列；源码保存后编译；图片像素确实出现在 PDF；AI 工具写入后编辑器自动刷新；离开 LaTeX 标签后清除活动文件上下文。窄工作区的 PDF 不再被裁出可见区域，适宽状态不产生横向溢出。`npm run dev` 中手动确认了首次 PDF.js 加载、工作空间图片插入，以及宽面板源码/PDF 并列显示。


## 编辑工作台

顶层标签代表具体内容：每个 LaTeX 项目有独立标签，标题就是项目名称；点击切换项目，关闭只关闭该项目。打开多个项目时，各自保留源码文件位置、草稿和 PDF 预览。项目标签下仅有一行工具栏，包含返回工作空间、当前文件路径、视图切换、编译和更多菜单。“打开项目”、新建、导入、导出与编译设置都在更多菜单中。顶部不再为项目操作和文件路径各占一行；保存状态、编译结果与光标行列显示在底部。

左侧导航可以收起，窄工作区中以抽屉打开。导航包含文件目录、当前文件章节大纲和工作空间图片三个页签；文件和图片支持筛选，图片提供缩略图。点击文件目录旁的加号可新建源码，文件通过左侧目录切换。界面只保留最上层工作空间阅读标签；编辑区上方只显示当前文件路径，不再增加第二层文档标签或重复文件名。图片插入当前光标位置；若光标不在正文内，则插入文档结束标记之前。

编辑器提供行号、当前行提示、查找与替换、Tab/Shift-Tab 缩进。大纲可跳转到章节；带有文件与行号的编译错误可从底部诊断面板跳转到源码，也可展开或复制完整日志。源码更新后，PDF 显示需要重新编译的提示。

窄工作区隐藏当前不可用的分栏按钮，扩大工作区后恢复。点击当前文件路径会打开文件树；在窄工作区的导航抽屉中按 Escape 可收起导航并返回导航按钮。

Computer Use 复测已检查新建项目、更多菜单和项目入口、设置与 XeLaTeX 编译、⌘F 查找、⌘Enter 编译、Escape 关闭菜单和导航、宽窄面板切换、大纲跳转、新建源码和文件切换保存。窄面板优先显示文件名，完整路径保留在悬停提示中；当前项目标签在面板宽度变化后自动滚动定位。新建文件后的编辑器焦点由组件回归测试验证。

工作空间卡片复测已通过：新建后保留画布、从卡片打开与返回、拖动和连线、移除后恢复卡片、通过 macOS 原生选择器导入 IEEEtran ZIP 并在应用内编译出 PDF。复测修复了文件选择器等待超时、单选路径解析错误，以及新卡片遮挡已有卡片的问题；导入选择器停留超过 30 秒后仍可完成导入。
