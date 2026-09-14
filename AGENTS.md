# AGENTS.md

> **状态 / Status**：本仓库目前**只有 `plan.md`，没有任何实现代码**。以下“技术选型”“约定”等章节是**待确认的建议**（标 `[建议]`），不是已存在的既成约定。
> This repo currently contains **only `plan.md` — no code**. Sections marked `[建议]` are **proposals awaiting confirmation**, not established conventions.
> 实现落地后请删掉 `[建议]` 标记并按实际代码修正本文件。
> Requirements belong in [plan.md](./plan.md) — link to it, do not copy it here.

---

## 1. 项目 / Project

个人记账工具：导入支付宝 / 微信 / 银行卡流水 → 去重 → 分类 → 识别内部转账与银证转账 → 多端查看。
Personal expense tracker: import Alipay / WeChat Pay / bank statements → dedupe → categorize → detect internal & brokerage transfers → view on multiple platforms.

硬性平台要求（来自 plan.md，不可协商）/ Non-negotiable platform targets:
- **Android** 可安装运行
- **Windows** 可运行（可以是纯网页 / 交互式 HTML）
- 数据可云端备份，**且公开仓库中不可读出任何开销数据**

---

## 2. 技术选型 `[建议]` / Stack (proposed)

**单一 TypeScript 代码库 + PWA**，理由：一份代码同时满足 Windows 与 Android，无需 Android SDK、签名打包或应用商店审核。

| 关注点 | 方案 |
|---|---|
| 应用 | Vite + React + TypeScript，编译为 PWA（离线可用） |
| Windows | 浏览器直接打开 GitHub Pages 站点 |
| Android | Chrome「添加到主屏幕」安装为 PWA |
| 解析 | **全部在客户端完成**（流水文件永远不离开用户设备）：`papaparse` (CSV/TXT)、XLSX 库、`pdfjs-dist` (PDF)。**必须懒加载**，见 §2.1 |
| 本地存储 | IndexedDB |
| 云端备份 | 加密快照（见 §3） |
| 测试 | vitest；夹具为**合成数据** |
| 后端 | **无 / none** —— 见下方说明 |
| CI | Node 20 + GitHub Actions，仅做校验/备份 |

### 2.1 解析依赖取舍 / Parser dependency tradeoffs

体积为 Bundlephobia 实测值（min / gzip），因为「首屏要不要装下所有解析器」是本项目唯一的性能硬约束：

| 库 | min | **gzip** | 状态 |
|---|---|---|---|
| `papaparse` | 19 KB | **6.9 KB** | ✅ 活跃维护，直接用 |
| `xlsx` (SheetJS CE, npm) | 412 KB | **140 KB** | ❌ **npm 版已废弃**，见下 |
| `exceljs` | 932 KB | **256 KB** | ✅ 活跃维护、MIT，但比 SheetJS 重 **+116 KB gzip** |
| `pdfjs-dist` | 306 KB | **85 KB** | ✅ Mozilla 维护（另有体积可观的独立 worker，未计入） |

**SheetJS 不能从 npm 装** —— 这是硬事实，不是偏好：

- CVE-2023-30533（原型污染，High 7.8，影响 < 0.19.3）：npm 上 **patched versions = None**。
- CVE-2024-22363（ReDoS，High 7.5，影响 < 0.20.2）：npm 上 **patched versions = None**。
- 原因：SheetJS 已停止维护 GitHub/npm 分发，安全版本只能从其自家 CDN（cdn.sheetjs.com，≥0.20.2）获取。
- 因此三条路选一：(a) `exceljs`（MIT、活跃，代价 +116 KB gzip）；(b) SheetJS 从其 CDN 引入固定版本；(c) 先只支持 CSV/TXT，XLSX 后置。**不要** `npm i xlsx`。

**为什么体积在这里是硬约束**：PWA 在 Android 上就是网页，首次访问要下载全部非懒加载 JS。若把 CSV+XLSX+PDF 三个解析器都打进主 bundle，用户在看到任何界面之前就要先下载 **230 KB+ gzip**。

**对策：动态 `import()` 按需加载。** 主 bundle 只含 UI + `papaparse`；用户真正选中 `.xlsx` / `.pdf` 时才加载对应解析器。

不使用 Python、不使用原生 Android 工程、不使用后端，除非用户明确要求。

**为何没有后端 / Why no backend**：用户**没有服务器资源**。后端在此项目里只可能有三种用途，且都不成立：

1. 用账号凭据自动抓取流水 —— 支付宝 / 微信 / 银行**均无个人账单开放 API**，只能靠非官方自动化，存在封号风险。
2. 服务端解密 + 多云同步 —— 用户已确认**无需多设备并发写入**。
3. 服务端定时拉取 —— 同上，无数据来源。

因此 GitHub 只作为**加密 blob 存储**（git 仓库当对象存储用），Actions 仅做备份与校验、**绝不解密**。
副作用是隐私反而更强：**明文永不离开用户设备**。
代价要诚实告知用户：没有后端 ⇒ 无法真正「自动」同步，只能走「手动导出 → 导入」流程。

不使用 Python、不使用原生 Android 工程、不使用后端，除非用户明确要求。

---

## 3. 隐私不变量 / Privacy invariants — **HARD RULES**

> 仓库是**公开**的。任何一次提交都会永久留在 git 历史中，即使后续删除也会被 clone/镜像保留。Assume every committed byte is world-readable forever.

1. **绝不提交**明文流水、平台导出原文件、真实卡号/账号，或可反推出金额的片段。
2. 唯一允许入库的数据形态：**AES-256-GCM 密文**（固定扩展名如 `*.enc`）。密钥由用户口令经 `PBKDF2-SHA256`（≥600,000 次迭代）派生，**只存在于设备内存**；绝不写入仓库、日志、URL、错误信息或 Actions secrets。
3. 写任何文件前自问：**这一步会不会把用户财务数据带进仓库？**
4. 测试夹具必须完全合成。**禁止**使用真实账单、截图或导出文件。
5. `.gitignore` 必须包含 `/data/**`、`*.csv`、`*.xlsx`、`*.zip`、`*.pdf`；提交前运行 `npm run check:no-plaintext`。
6. 元数据同样会泄露：加密快照采用**定长填充**与**批量提交**，避免提交时间/文件大小暴露消费频率。
7. 导入文件（`import { ... }` / `require`）不得指向 `data/` 或用户目录下的真实文件。

---

## 4. 领域模型 `[建议]` / Domain model

```
Transaction {
  id, fingerprint, fingerprintVersion,
  source,            // e.g. 'alipay' | 'wechat' | 'cmb' | 'icbc'
  accountId,
  direction,         // 'in' | 'out'
  amountMinor,       // integer! minor units
  currency,          // 'CNY'
  occurredAt,        // UTC ISO-8601
  counterparty?, balanceAfter?,
  rawDescription,    // original text, never rewritten
  category?, kind, importedBatchId
}
```

- **金额一律用整数「分」**（`amountMinor: number`），禁止浮点运算；仅在 UI 格式化时转成元。
- `kind` ∈ `expense | income | transfer-internal | transfer-investment | transfer-repayment | refund | unknown`。
- 永远保留 `rawDescription` 原文；分类是派生数据，不得改写原文。
- 时间内部统一 **UTC**，只在渲染时按 `Asia/Shanghai` 显示。

---

## 5. 去重 / Deduplication

- 指纹优先级：银行流水自带的 `balanceAfter` + 时间 + 金额 + 方向；无余额列时退化为 `时间(±2min) + 金额 + 方向 + 对手方`。
- 指纹函数必须是**纯函数且稳定**。改动算法会让全部历史指纹失效 → 必须递增 `fingerprintVersion` 并提供迁移方案，**不要**静默修改。
- **导入必须幂等**：同一个文件导入两次，收支总额与条数不得变化。这是回归测试的必备用例。
- **退款不是收入**：支付宝退款行 `交易状态 = 退款成功` 且分类为 `退款`，通过「订单号前缀匹配 + 金额相等」找到原订单，两行都应剔除（`refund`），否则支出与收入各被虚增一次。
- **失败/关闭交易不是流水**：`交易状态 = 交易关闭` 的行必须剔除，否则会记出根本没发生的支出。

---

## 6. 内部转账与投资 / Transfers & investments

- 同一用户不同账户之间金额相抵、时间窗口内（默认 ±3 天）配对 → `transfer-internal`，**不计入收支**。
- 银证转账 / 三方存管（关键识别词：`银证转账`、`证券`、`三方存管`、`投资`）→ `transfer-investment`，**单独记录**，既不入收支也不入消费分类。
- 配对要能处理 **1 对 N**（一笔转出对多笔转入）与**未配对残留**：残留不得静默丢弃，保留为 `unknown` 并提示用户确认。

### 6.1 花呗 / 信用卡 / 借呗 / 白条还款 / Credit-line repayments — **易错点**

核心原则：**「消费」与「还款」不是一回事。**

- 花呗 / 信用卡刷卡的当期消费 = 真实支出（`expense`）。
- 之后的「还款」只是把负债结清，**不是新支出**；重复记账会让支出翻倍。
- 关键识别信号（两家平台都**自带**非收支标记，不要靠关键词猜）：
  - **支付宝**：`收/支` 列有三个取值 —— `收入` / `支出` / **`不计收支`**。转账、还款等落在 `不计收支`。
  - **微信**：`收/支` 列为 **`/`** 时即「不计收支」；配合 `交易类型` = `信用卡还款`、`转账`、`零钱提现`、`零钱充值`、`购买理财通`、`转入/转出零钱通`。
- 处理：还款类记录 `kind = transfer-repayment`，**既不入收支、也不入消费分类**（等价于复式记账里挂到 `Equity:Transfers` 类过渡账户）。
- **例外**：手续费、分期手续费、利息、逾期费是**真实支出**，仍须计为 `expense`（微信会把服务费写进 `备注`，需从本金中拆出）。
- 若同时导入信用卡账单与其还款行，必须配对抵消；配对后仍有残留 → 保留 `unknown` 并提示用户确认，不得静默丢弃。
- 借呗 / 京东白条 / 分期同此规则。

---

## 7. 分类 / Categories

- 规则表形式：`{ match: RegExp | 关键词, category, priority }`，规则与数据分离，便于单测。
- **用户手工修改的分类优先级最高且持久化**，重导同一批数据不得把用户修正覆盖回规则结果。
- 分类只作用于 `kind === 'expense'`。

---

## 8. 导入器 / Importers

**架构决策：按「格式」驱动，而不是按「机构」驱动。**（用户已确认：只要格式集合就是 csv/txt/xls/xlsx/pdf，就不必逐个银行适配。）

分两层：

| 层 | 位置 | 说明 |
|---|---|---|
| **专用解析器** | `src/importers/alipay/`、`src/importers/wechat/` | 格式固定且已知，硬编码列布局（§8.2）。 |
| **通用解析器** | `src/importers/generic/` | 银行 / 券商 / 任何未知来源。**由「模板」驱动**：列映射 + 编码 + 分隔符 + 日期格式，用户在 UI 里把列名指到字段上。不写 `if (bank === 'cmb')`。 |

- 所有解析器只暴露 `parse(input: File | ArrayBuffer, template?): Transaction[]`。
- 解析器**不得直接写数据库**，也不得做去重/分类 —— 保持纯解析，便于单测与重放。
- **模板必须带版本号**（如 `cmb@2026-09`）。平台改版会改变列布局；把版本钉住，旧文件才不会被新模板静默解析错。
- **校验失败要显式报错**：模板与文件表头不匹配时抛错并展示实际表头，**绝不**静默按错位的列解析出错误金额。
- 新增模板时**必须同时提交合成夹具与单测**。

### 8.1 导出格式事实表 / Verified export formats

| 来源 | 文件格式 | 常见容器 | 编码 | 表头前需跳过的行数 |
|---|---|---|---|---|
| **支付宝** | **CSV**（不支持 XLSX） | 通常为 `.zip`（内含 CSV） | **GBK** ⚠️ | ~23 行 |
| **微信支付** | **CSV 或 XLSX** | 通常为 `.zip` | **UTF-8** | CSV ~17 行 / XLSX ~18 行 |
| **银行 / 券商** | **CSV / TXT / XLS / XLSX / PDF 全都有** | 视来源；常为 `.zip` | 视来源（常见 GBK） | 视来源 |

**结论：`csv` / `txt` / `xls` / `xlsx` / `pdf` 五种都会遇到。** 处理方式：

- `.txt` 归一化为 **CSV** 解析。
- `.xls` **不可信**：有些券商/银行的 `.xls` 其实是 **TSV 纯文本**或 **HTML 表格**，不是真 Excel。**按内容嗅探，不按扩展名**（真 XLS 有 OLE 魔数 `D0 CF 11 E0`；嗅探失败则回退按文本解析）。
- 因此**不需要**维护「支持哪家银行」的清单；需要维护的是**模板库**（一个模板 = 一套列映射），模板可被单个来源复用。

### 8.2 已核对的列布局 / Verified column layouts (0-indexed)

支付宝 CSV：`0 交易时间`、`1 交易分类`、`2 交易对方`、`3 对方账号`、`4 商品说明`、`5 收/支`、`6 金额`、`7 收/付款方式`、`8 交易状态`、`9 交易订单号`、`10 商家订单号`

微信 CSV/XLSX：`0 交易时间`、`1 交易类型`、`2 交易对方`、`3 商品`、`4 收/支`、`5 金额`、`6 支付方式`、`7 当前状态`、`8 交易单号`、`9 商户单号`、`10 备注`

### 8.3 解析陷阱 / Parsing pitfalls

1. **不要硬编码表头行数**（23 / 17 / 18 这类数字会随平台改版失效）。改为**扫描表头行**：找到首列等于 `交易时间` 的那一行，其后才是数据。
2. **微信 CSV 字段里混有制表符** `\t`（为防 Excel 自动转换而加），**解析前必须整体剔除**，否则列错位。
3. **微信 `金额` 带 `¥` 前缀**，需剥离后再转整数分。
4. **支付宝老版账单**首行含 `支付宝` 且列布局不同 → 必须**显式报错**提示版本不兼容，不要静默按新格式解析。
5. 金额一律解析为**整数分**，禁止 `parseFloat` 后直接参与运算（见 §4）。

### 8.4 PDF 对账单 / PDF statements —— **最高风险区**

用户已确认**需要支持 PDF**。但必须承认：PDF 与上面「按格式驱动」的路线存在**张力**，因为 **PDF 里没有「列」**，只有一堆带坐标的文字块。

**做法（用 `pdfjs-dist`，动态 `import()`）：**

1. 提取文本项及其 **x/y 坐标**。
2. **重建表格**：按 y 聚类成行，按 x 直方图切列。
3. 产出**二维数组**，然后**复用 §8 的同一个通用映射 UI** —— 绝不为 PDF 另写一套映射逻辑。
4. **必须让用户确认后再入库**，并展示行数与金额合计供核对。

**硬性要求：**

- **绝不静默采用抽取结果。** PDF 重建可能把两行并成一行、把金额错位到别的列 —— 那会产出**看似合理但错误**的金额，比直接报错危险得多。
- **支持加密 PDF**：银行对账单常带密码（身份证后 6 位 / 卡号后 6 位）。用 pdf.js 的密码回调，**密码只在内存中**（§3 规则 2）。
- **抽取失败要明确失败**：提示用户「请改用银行 App 导出 CSV/XLSX」，不要猜测。
- 合成夹具需覆盖：多页、跨页续表、合并单元格、金额右对齐带千分位、负数用括号表示。
- PDF **不承诺全银行覆盖**；它是兜底通道，不是主路径。

---

## 9. GitHub Actions 限制 / Constraints (do not fight these)

- 定时任务只能做备份 / 校验；它**无法访问用户本地文件**，不要设计依赖本地路径的流程。
- 频率 ≤ 每天 1 次。**禁止** `* * * * *` / 分钟级调度 —— 会被判定滥用并可能导致账号受限。
- 公开仓库的 `schedule` 是尽力而为：可能延迟 5–15 分钟甚至整天跳过。逻辑必须**容忍漏跑并可补齐**。
- 用 `GITHUB_TOKEN` push 产生的提交**不会触发其他 workflow**（递归保护）。不要设计链式触发。
- 仓库 60 天无活动后定时任务会被自动停用 → 必须提供明确的手动触发方式。
- 不要在 Actions 中解密用户数据；解密只发生在用户设备上。

---

## 10. 命令 / Commands

> ⚠️ 仓库尚未初始化（无 `package.json`）。首次开工先搭脚手架，随后回填此节。
> This repo has no `package.json` yet. Scaffold first, then fill in this section.

```bash
npm ci                       # install
npm run dev                  # local dev server
npm run build                # build PWA to dist/
npm test                     # vitest
npm run check:no-plaintext   # block plaintext financial data
```

---

## 11. 代码约定 / Code conventions

- **代码、标识符、注释、commit message 一律英文。** 文档（README / AGENTS.md）中英双语。
- 提交信息用祈使句，例如 `Add Alipay CSV importer`。
- 任何涉及金额、日期或去重的逻辑都必须有单元测试。
- 本文件与 `plan.md` 作用不同：`plan.md` 记需求（要做什么），本文件记约束（怎么做）。

---

## 12. 已决 / Settled（原「待定」）

1. ~~是否引入后端？~~ **已决：不引入后端。** 用户无服务器资源，且后端的三种可能用途均不成立（见 §2）。GitHub 仅作加密 blob 存储。
2. ~~是否需要多人 / 多设备并发写入？~~ **已决：不需要。** 因此无需设计加密快照的合并策略；快照可整体覆盖。
3. ~~银行卡是否包含信用卡账单？~~ **已决：包含。** 还款 ≠ 消费，按 §6.1 处理。
4. ~~支付宝/微信/银行导出格式？~~ **已决：见 §8.1。** 支付宝 = CSV(GBK)，微信 = CSV/XLSX(UTF-8)，银行因行而异且部分仅 PDF。
5. ~~云端存储用 GitHub 还是第三方？~~ **暂定 GitHub 仓库快照**（用户已确认仓库为**公开**，故 §3 隐私规则按「全世界可读」执行）。
6. ~~首批要支持哪家银行？~~ **已决：不做机构清单。** 银行流水一律走**通用解析器 + 模板**（§8）；`csv/txt/xls/xlsx/pdf` 五种都覆盖，因此无需逐行适配。
7. ~~是否支持 PDF？~~ **已决：支持**（见 §8.4）。定位为兜底通道，必须经用户确认后才入库。
8. ~~解析依赖怎么选？~~ **已决：见 §2.1。** `papaparse` 直接用；`xlsx` 不走 npm；XLSX / PDF 解析器**一律动态加载**。

## 13. 仍待定 / Still open

1. 加密快照的**触发方式**：Actions 无法访问本地设备，只能处理已推送的 blob。需定型三种用户流程之一：**(a)** 手动「导出并 push」；**(b)** 网页内点按钮、用用户提供的细粒度 token 调 GitHub API 提交；**(c)** Actions 定时仅做校验/提醒。见 §9 与下节说明。
2. 是否接受 `exceljs`（+116 KB gzip）换取 MIT 且活跃维护的 XLSX 支持，还是从 SheetJS CDN 固定版本？见 §2.1。
