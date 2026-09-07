# Refora AI 精简工具与能力核对

## 本次调整

Refora 向模型公开的自定义工具由 **52 个缩减为最多 12 个**。其中，原先 42 项应用操作归并为 **2 个工具**，使用统一的 `action + parameters` 结构。其余 10 个工具是原有的学术研究、网页、沙箱执行、产物发布和记忆功能；是否全部出现取决于运行模式与功能配置。Agent 框架自身的文件工具不计入这个数字。

初始工具定义的 JSON 长度从 36,438 字符降至 10,842 字符，约减少 70%。详细动作参数按需查询，避免每轮向模型提供全部操作的完整 schema。

没有移除原来的 42 项应用操作。独立操作名仅保留为内部实现；恢复旧审批时，临时注册该审批实际引用的旧名字，不让全部旧工具重新出现在新对话中。

## 两个应用工具

| 工具 | 动作 |
| --- | --- |
| `refora_library` | `list`、`search`、`context`、`read`、`open`、`related`、`import`、`update`、`star`、`delete`、`refresh`、`ocr`、`categories.list`、`categories.create`、`categories.rename`、`categories.delete`、`categories.assign` |
| `refora_workspace` | `list`、`create`、`rename`、`delete`、`inspect`、`read`、`contents`、`cards.add`、`cards.add_documents`、`cards.layout`、`cards.reorder`、`cards.remove`、`canvas.set`、`connections.create`、`connections.update`、`connections.delete`、`notes.create`、`notes.update`、`notes.delete`、`reports.create`、`reports.update`、`reports.delete`、`files.import`、`assets.update`、`assets.delete` |

两个工具都支持 `help`。工具内部的参数仍按具体动作严格校验，不能通过通用参数调用任意数据库方法、SQL 或其他服务。

### 查询参数

调用 `refora_workspace`：

```json
{"action":"help","parameters":{"action":"cards.layout"}}
```

返回该动作的说明、是否只读、是否需要审批，以及完整的 `parametersSchema`。`parameters={}` 返回动作目录；`parameters={"coverage":true}` 同时返回已核对的能力缺口。

### 摆放卡片

调用 `refora_workspace`：

```json
{
  "action": "cards.layout",
  "parameters": {
    "workspaceId": "实际工作空间ID",
    "items": [
      { "itemId": "实际卡片ID", "x": 120, "y": 80, "width": 540, "height": 310, "zIndex": 8 }
    ]
  }
}
```

用 `inspect` 获取卡片 ID 和当前布局。省略的布局字段保持不变，整批修改失败时回滚。工作空间动作的 `workspaceId` 可省略，此时使用当前对话所属空间；全局对话需要提供明确 ID。

### 将论文加入工作空间

调用 `refora_workspace`：

```json
{
  "action": "cards.add",
  "parameters": {
    "workspaceId": "实际工作空间ID",
    "kind": "document",
    "ids": ["实际论文ID"],
    "placement": { "x": 100, "y": 80 }
  }
}
```

`kind` 还支持 `note`、`report` 和 `asset`。`cards.add_documents` 保留旧接口的 `added`、`alreadyInWorkspace`、`missing` 返回语义；新调用可优先使用返回完整卡片的 `cards.add`。

### 星标与分类

调用 `refora_library`：

```json
{"action":"star","parameters":{"docIds":["实际论文ID"],"starred":true}}
```

分类归属使用 `categories.assign`，内层 `parameters.action` 选择 `assign` 或 `unassign`。这种显式设置方式避免重复执行时产生反向切换。

## 权限保持不变

审批依据具体动作和参数判断，而不是只检查外层工具名：

- 普通读取、创建、编辑、导入、分类、星标、布局和本地 OCR 自动执行。
- 删除论文、空间、笔记、报告、附件、分类、卡片或连接线，仍逐次审批。一次批准不会放开整组工具，也不会放开后续删除。
- 只读子任务获得同名工具的只读动作子集；即使手工伪造写入动作，执行层也会拒绝。讨论和计划模式保留只读限制。
- 删除审批界面显示具体动作、目标和影响范围；提交决定时保留原始嵌套参数。
- PDF 删除继续复用系统废纸篓流程；不硬删除源 PDF。附件更新继续校验当前哈希并保留原始导入文件。
- AI 自身的配置、凭据和运行状态不由这两个工具管理；既有记忆工具沿用原审批机制。

## 能力核对结果：仍有未接入的部分

本次做的是接口合并和覆盖核对，**不代表全部应用功能已开放给 AI**。以下普通应用能力确实仍有缺口，不应把它们描述为已完成或按用户要求禁止。

| 功能 | 当前覆盖 | 尚未接入的部分 |
| --- | --- | --- |
| 内容库与分类 | 论文查询、阅读、元数据/笔记修改、星标、分类、PDF 导入和删除 | 统一全局搜索入口；批量刷新可逐篇完成，但没有独立批量动作 |
| 工作空间数据 | 空间、卡片、连接线、笔记、报告、附件的主要操作，以及位置、大小、层级、画布视图 | 不能在当前运行的 Agent 所属空间内删除该空间；可从全局对话或其他空间发起 |
| PDF 批注 | 未接入 | 高亮、绘图、批注评论和删除批注 |
| 阅读器与书签 | 能读取论文文本、打开 PDF | 定位页面、选中文字、阅读器缩放/旋转、书签增删改、阅读位置保存与恢复 |
| 监控文件夹 | 未接入 | 列出、添加、删除、启停自动导入目录 |
| 导入导出 | 本地 PDF；空间文件导入；沙箱产物发布 | 文件夹、标识符、JSON、Zotero、Mendeley 导入，以及调用应用原生 JSON/BibTeX/PDF 导出流程。沙箱可生成文件，但不等同于接通这些原生入口 |
| 文件恢复与定位 | 可更新论文信息、导入文件 | 重新绑定 PDF 路径、恢复缺失文件、在 Finder 定位论文 |
| 附件原生操作 | 导入、修改、删除、卡片文本预览 | 打开、在 Finder 定位、复制到剪贴板；未摆放的附件需先添加卡片再通过卡片读取 |
| OCR 管理 | 本地 balanced OCR、缓存文本读取 | 其他配置档、取消任务、查询任务状态、MinerU 安装/卸载和安装位置管理 |
| 设置与内容库切换 | 未接入 | 主题、语言、阅读偏好、列表列设置、代理/元数据偏好、切换当前资料库 |
| 界面控制与剪贴板 | 已打开空间的画布 pan/zoom 可控制 | 打开/关闭标签、选择卡片、切换面板、全屏、系统剪贴板、打开空间沙箱目录 |
| 同步与账户 | 未接入 | 登录/退出、同步开关、立即同步、冲突处理与账户设置 |
| AI 自身管理 | 按原要求排除 | Provider、密钥、Agent 配置、模型切换、运行中的 Agent 自身管理 |

核对依据包括 `src/shared/ipc-types.ts` 中的 preload API、后端 `server/routes/library.py`、`server/routes/workspaces.py`、`server/services/library_settings_routes.py`，以及 renderer 的阅读器状态、设置、工作空间和账户界面。

后续接通这些缺口时，可以继续在两个工具内添加动作，或仅在确有独立领域需要时增加一个工具，不必恢复“一项操作一个工具”的形式。对新增的危险动作应继续按动作审批，不应默认放开整个工具。

## 验证

- 覆盖检查确认全部 42 项原应用操作仍有公开动作入口。
- 覆盖参数纠错、按动作审批、只读任务拒绝写入、旧调用恢复和重复调用的行为测试。
- 开发版使用独立临时资料库与本机模拟模型，经过真实调用链执行 `help`、创建空间/便签、读取卡片、调整布局、创建分类、调整画布、请求删除并拒绝；确认笔记保留。随后另起一次调用并批准删除，确认笔记及其卡片只在获批后删除。
- `npm run verify` 已通过：前端 1427 项、后端 1798 项（1 项跳过），以及服务集成测试。
