# AGENTS.md

> **状态 / Status**：**已实现。** 本文件记录的是**已落地的约定**，与代码一致。
> **Implemented.** This file records **established conventions** that match the code.
> 需求见 [plan.md](./plan.md)，本文件只记约束（怎么做）。
> Requirements live in [plan.md](./plan.md); this file records constraints only.
> 改动实现后请同步修正本文件 —— 一份与代码不符的约束文档比没有更糟。
> Keep this file in sync with the code. A stale constraint doc is worse than none.

---

## 0. 快速定位 / Start here

| 你想做的事 | 从这里开始 |
|---|---|
| 加一家银行的导入 | `src/importers/template.ts` —— 只需要加模板数据，**不要**写机构分支 |
| 加一家平台的导入 | `src/importers/<平台>.ts`，仿 `alipay.ts`，并补合成夹具与单测 |
| 改金额 / 日期行为 | `src/domain/money.ts` / `src/domain/dates.ts` —— 先读那里的注释，再看单测 |
| 改去重规则 | `src/domain/fingerprint.ts` —— **必须**同时递增 `FINGERPRINT_VERSION` |
| 改分类规则 | `src/domain/categories.ts` 的 `DEFAULT_RULES` |
| 改收支/转账判定 | `src/domain/classify.ts`，单测在 `classify.test.ts`，**这是最容易记错账的地方** |
| 跑全部校验 | `npm run check:no-plaintext && npm run typecheck && npm test && npm run build` |

---

## 1. 项目 / Project

个人记账工具：导入支付宝 / 微信 / 银行卡流水 → 去重 → 分类 → 识别内部转账与银证转账 → 多端查看。
Personal expense tracker: import Alipay / WeChat Pay / bank statements → dedupe → categorize → detect internal & brokerage transfers → view on multiple platforms.

硬性平台要求（来自 plan.md，不可协商）/ Non-negotiable platform targets:
- **Android** 可安装运行
- **Windows** 可运行（可以是纯网页 / 交互式 HTML）
- 数据可云端备份，**且公开仓库中不可读出任何开销数据**

---

## 2. 技术选型 / Stack

**单一 TypeScript 代码库 + PWA**，理由：一份代码同时满足 Windows 与 Android，无需 Android SDK、签名打包或应用商店审核。

| 关注点 | 方案 |
|---|---|
| 应用 | Vite 8 + React 19 + TypeScript 7，编译为 PWA（离线可用） |
| Windows | 浏览器直接打开构建产物 |
| Android | Chrome「添加到主屏幕」安装为 PWA |
| 解析 | **全部在客户端完成**（流水文件永远不离开用户设备）：`papaparse` (CSV/TXT)、`read-excel-file` (XLSX)、`pdfjs-dist` (PDF)、`fflate` (`.zip`)。**全部懒加载**，见 §2.1 |
| 本地存储 | IndexedDB（经 `idb`） |
| 云端备份 | 加密快照（见 §3）；**手动导出**，Actions 只校验 |
| 发布 | GitHub Pages（`.github/workflows/pages.yml`）；`base: './'` 以适配子路径 |
| 测试 | vitest；夹具为**合成数据** |
| 后端 | **无 / none** —— 见下方说明 |
| CI | Node 24 + GitHub Actions，仅做校验/备份 |

**安全上下文是运行期约束，不只是部署细节**：PWA 安装（Service Worker）与加密快照（`crypto.subtle`）都只在 **HTTPS 或 `http://localhost`** 下可用。局域网 `http://192.168.x.x` 打开时二者都失效，但**导入与统计仍正常** —— 代码必须继续支持这种降级使用（`crypto/snapshot.ts` 的 `isWebCryptoAvailable()`，UI 据此提前禁用按钮并说明原因），不要假设 crypto 一定存在。

### 2.1 解析依赖取舍 / Parser dependency tradeoffs

体积为 Bundlephobia 实测值（min / gzip），因为「首屏要不要装下所有解析器」是本项目唯一的性能硬约束：

| 库 | min | **gzip** | 状态 |
|---|---|---|---|
| `papaparse` | 19 KB | **6.9 KB** | ✅ 已采用（主 bundle） |
| `read-excel-file` | 41 KB | **11 KB** | ✅ **已采用**（懒加载），依赖 `fflate`，浏览器原生可用 |
| `xlsx` (SheetJS CE, npm) | 412 KB | **140 KB** | ❌ **npm 版已废弃**，见下 |
| `exceljs` | 932 KB | **256 KB** | ❌ 已评估后放弃（见下） |
| `pdfjs-dist` | 306 KB | **85 KB** | ✅ 已采用（懒加载；另有 1.27 MB 独立 worker） |
| `fflate` | — | **~8 KB** | ✅ 已采用（懒加载），解 `.zip` |

**SheetJS 不能从 npm 装** —— 这是硬事实，不是偏好：

- CVE-2023-30533（原型污染，High 7.8，影响 < 0.19.3）：npm 上 **patched versions = None**。
- CVE-2024-22363（ReDoS，High 7.5，影响 < 0.20.2）：npm 上 **patched versions = None**。
- 原因：SheetJS 已停止维护 GitHub/npm 分发，安全版本只能从其自家 CDN（cdn.sheetjs.com，≥0.20.2）获取。

**XLSX 最终选 `read-excel-file`，不是 `exceljs`。** `exceljs` 虽然 MIT 且活跃，但有两个实际问题：

1. 体积 **256 KB gzip**，是 `read-excel-file` 的 **23 倍**；
2. 它在 Vite 里解析到 Node 入口（`lib/exceljs.nodejs.js`），需要 `Buffer` / `stream` polyfill，而 `read-excel-file` 是浏览器优先、零 polyfill。

两者都只在用户真的选中 `.xlsx` 时才加载，所以这一条不是因为首屏，而是因为**移动端按需下载的成本**。**不要** `npm i xlsx`。

**为什么体积在这里是硬约束**：PWA 在 Android 上就是网页，首次访问要下载全部非懒加载 JS。若把 CSV+XLSX+PDF 三个解析器都打进主 bundle，用户在看到任何界面之前就要先下载 **500 KB+ gzip**（PDF 的 worker 还没算）。

**对策：动态 `import()` 按需加载，并且不让懒加载块进预缓存。**

实测构建产物（`npm run build`）：

| 产物 | 大小 | 首屏需要？ |
|---|---|---|
| `index-*.js`（React + UI + 我们的代码） | 313 KB / **99 KB gzip** | 是（React 占大头） |
| `index-*.css` | 4.9 KB / **1.7 KB gzip** | 是 |
| `pdf-*.js` + `pdfjs` chunk | 431 KB / 129 KB gzip | 否，懒加载 |
| `pdf.worker.min.mjs` | 1.27 MB | 否，懒加载 |
| `universal-*.js`（read-excel-file） | 41 KB / 11 KB gzip | 否，懒加载 |
| PWA **预缓存总量** | **326 KB**（9 项） | 安装时一次 |

因此 `vite.config.ts` 里有两条硬约束：

1. **不要把懒加载解析器写进 `manualChunks`** —— Rollup 自动切分就够了。
2. **`workbox.globIgnores` 必须继续排除 `pdf-*.js` / `universal-*.js` / `pdf.worker*`**；它们由 `runtimeCaching` 在使用后缓存。若把它们加回预缓存，安装 PWA 会变成下载 ~570 KB，懒加载就白做了。

同理，**任何新解析器都不得被静态 import 进 UI**。曾经的坑：`ImportPanel.tsx` 从 `importers/pdf.ts` 引入了 `PDF_PASSWORD_REQUIRED` 常量，于是 430 KB 的 pdf.js 被静态拉进主 bundle，懒加载失效。修法是把这个常量放进**不 import 任何东西**的 `src/importers/errors.ts`。加新错误类型时请沿用这个模式，Vite 会在构建时用 `INEFFECTIVE_DYNAMIC_IMPORT` 警告这件事。

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

## 4. 领域模型 / Domain model

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
| **专用解析器** | `src/importers/alipay.ts`、`src/importers/wechat.ts` | 格式固定且已知，硬编码列布局（§8.2）。 |
| **通用解析器** | `src/importers/generic.ts` + `template.ts` | 银行 / 券商 / 任何未知来源。**由「模板」驱动**：列映射 + 编码 + 金额语义 + 方向取值，用户在 UI 里把列名指到字段上。不写 `if (bank === 'cmb')`。 |
| **容器识别与路由** | `src/importers/sniff.ts` + `index.ts` | 按**字节内容**识别容器、解 `.zip`、按**表头**路由到上面三者。 |

- 解析器只暴露 `parseXxx(table, options): ParseResult`，产出 **`DraftTransaction[]`** —— 即「已解析、但尚未判 kind / 未去重 / 未分类」的中间态。
- **判 kind、配对、分类、去重全部在 `src/domain/pipeline.ts`**，解析器不碰这些。
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
- `.xls` **不可信**：有些券商/银行的 `.xls` 其实是 **TSV 纯文本**或 **HTML 表格**，不是真 Excel。**按内容嗅探，不按扩展名**（真 XLS 有 OLE 魔数 `D0 CF 11 E0`；嗅探失败则回退按文本解析）。TSV 与 HTML 两条路都已实现并有单测。
- **真正的二进制 `.xls`（OLE/CFB）目前不支持**：会**明确报错**并要求用户改导出 CSV/XLSX，而不是猜。这是刻意留下的缺口 —— 真 OLE 需要专门解析器，而现实中命名为 `.xls` 的银行文件绝大多数是 TSV 或 HTML，已经覆盖。
- 因此**不需要**维护「支持哪家银行」的清单；需要维护的是**模板库**（一个模板 = 一套列映射），模板可被单个来源复用。

### 8.2 已核对的列布局 / Verified column layouts (0-indexed)

支付宝 CSV：`0 交易时间`、`1 交易分类`、`2 交易对方`、`3 对方账号`、`4 商品说明`、`5 收/支`、`6 金额`、`7 收/付款方式`、`8 交易状态`、`9 交易订单号`、`10 商家订单号`

微信 CSV/XLSX：`0 交易时间`、`1 交易类型`、`2 交易对方`、`3 商品`、`4 收/支`、`5 金额`、`6 支付方式`、`7 当前状态`、`8 交易单号`、`9 商户单号`、`10 备注`

### 8.3 解析陷阱 / Parsing pitfalls

1. **不要硬编码表头行数**（23 / 17 / 18 这类数字会随平台改版失效）。改为**扫描表头行**：找到首列等于 `交易时间` 的那一行，其后才是数据。
2. **微信 CSV 字段里混有制表符** `\t`（为防 Excel 自动转换而加）。实测真实风险**不是**列错位 —— 首尾的制表符会被 trim 掉 —— 而是 **`guessDelimiter` 可能把文件误判成 TSV**，那才会毁掉所有列。对策：分隔符按「谁更占优」选择（逗号通常多一个数量级），并在分隔符不是 `\t` 时整体剔除制表符（`parseDelimited` 的 `stripTabs`，对真正的 TSV 会显式拒绝）。
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
- **公开仓库 vs 私有仓库（已核对官方文档）**：
  - Actions 在私有仓库**可用**，只是会计量分钟数（GitHub Free = 2,000 分钟/月、500 MB 产物存储）；公开仓库的标准 runner 免费且不计量。本项目的三个 workflow 合起来约 60–150 分钟/月，远在额度内 —— 所以**分钟数不是实际障碍**。
  - **真正的障碍是 Pages**。官方文档写明：若账号使用 GitHub Free，仓库**必须是公开的**。因此 Free 下的私有仓库用不了 Pages，`pages.yml` 会直接失败。私有仓库 + Pages 需要 Pro / Team / Enterprise。
  - **私有仓库 ≠ 私有网站**。官方文档明确说明：即使站点仓库是私有的，GitHub Pages 站点在互联网上**仍然公开可访问**。所以把仓库改私有并不会让部署出去的站点变私密。
  - **结论：保持公开。** §3 的隐私不变量本就是按「全世界可读」设计的，因此改私有不增加任何安全性，却引入付费门槛、计量分钟，以及「私有了所以可以提交原文」这种错误安全感。若确实要源码私有，把 `dist/` 交给 Cloudflare Pages / Netlify / Vercel（免费、支持私有仓库、提供 HTTPS）。
  - 另外官方文档还有一条：用 `GITHUB_TOKEN` push 产生的提交不会触发 Pages 构建。本项目用 `deploy-pages` 部署、而非往分支推产物，所以天然不受影响 —— 不要改成推 `gh-pages` 分支的写法。
- **发布工作流必须自带校验**（`.github/workflows/pages.yml` 里有意的重复）。不要用 `workflow_run` 去依赖 `ci.yml`：那会增加一层隐式耦合，而「main 绿 = 线上可用」应该是同一个条件，不是两个工作流互相约定。
- **`base` 必须保持相对（`'./'`）**。GitHub Pages 的项目站点发布在 `/<repo>/` 子路径下，绝对路径 `/assets/...` 会 404。Pages 工作流里有一条断言专门挡这个回归。也不要引入 `configure-pages`：它主要用于把探测到的 base 喂给生成器，而这里不需要。
- 服务端渲染与 URL 路由都没有用到（标签页是 `useState`，不是路由），所以**不需要 `404.html` 回退**。若将来引入路由，必须同时补上回退页，否则子路径刷新会 404。

---

## 10. 命令 / Commands

```bash
npm ci                       # install
npm run dev                  # local dev server
npm run build                # typecheck + build PWA to dist/
npm run typecheck            # tsc --noEmit
npm test                     # vitest run
npm run check:no-plaintext   # block plaintext financial data
```

提交前跑全套：`npm run check:no-plaintext && npm run typecheck && npm test && npm run build`

**本机环境注意**（Windows，无管理员权限）：

- Node 不在 PATH 上，装在 `%LOCALAPPDATA%\nodejs`；用前先 `$env:PATH = "$env:LOCALAPPDATA\nodejs;$env:PATH"`。
- 用 **`npm.cmd`** 而不是 `npm` —— PowerShell 执行策略会拦截 `npm.ps1`。
- 终端若显示中文乱码，先 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。

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
9. ~~加密快照的触发方式？~~ **已决：手动导出 + 用户自行提交**（方案 a），Actions 只做校验与陈旧提醒（方案 c）。否决了方案 (b)（网页内用 token 提交）：它要求用户把有写权限的 token 交给网页，而 §3 明确规定密钥类凭据不得进入仓库、日志或 URL。为省两次点击去承担这个风险不值得。

## 13. 仍待定 / Still open

1. ~~尚未配置 GitHub Pages 部署~~ **已完成并上线**：<https://jebearssica.github.io/ledger-tool/>（仓库 `Jebearssica/ledger-tool`，公开）。`.github/workflows/pages.yml` 已就绪（校验通过才发布，且不依赖 `configure-pages`，因为 `base: './'` 让它对子路径与根路径都成立）。**线上已实测**：Service Worker 作用域为 `/ledger-tool/`、manifest 可安装、`crypto.subtle` 可用（备份正常）、GBK 文件导入与幂等性均正确。
2. **分类规则表还不能在 UI 里编辑**。§7 要求「规则与数据分离」，目前规则仍是 `DEFAULT_RULES` 常量；IndexedDB 里已有 `rules` store，但界面未接。
3. **多份快照的命名与保留策略未定**。当前由用户自行命名并放置，仓库里还没有 `data/` 约定。
4. **2 分钟时间桶的合并阈值未按真实数据校准**（见 §5）。若实际出现误合并，需要调整 `TIME_WINDOW_MINUTES`，而**那会改变指纹**，必须同时递增 `FINGERPRINT_VERSION` 并写迁移。
