# 记账工具 / Ledger Tool

个人记账工具：导入支付宝 / 微信 / 银行卡流水 → 去重 → 分类 → 识别内部转账与银证转账 → 多端查看。
A local-first personal expense tracker: import Alipay / WeChat Pay / bank statements → dedupe → categorize → detect internal & brokerage transfers → view on any device.

**没有后端。明文流水永远不离开你的设备。**
**No backend. Plaintext statements never leave your device.**

---

## 它解决什么问题 / What it solves

| 需求 | 做法 |
|---|---|
| 手动导出太麻烦 | 一次性解析支付宝 / 微信 / 银行导出的文件，支持 `.csv` / `.txt` / `.xls` / `.xlsx` / `.pdf` 及其所在的 `.zip` |
| 重复导入会重复记账 | 每行生成稳定指纹；同一文件导入两次，**总额与条数完全不变** |
| 分不清开销类别 | 规则表自动分类；你手工改过的分类会被永久保留 |
| 卡↔支付宝互相转账被算成收支 | 自动配对金额相抵的两条腿，**从收支中剔除** |
| 银证转账被算成消费 | 识别 `银证转账` / `证券` / `三方存管` 等，单独记录，不入收支 |
| 花呗 / 信用卡还款让支出翻倍 | 还款记为 `transfer-repayment`，**不计收支也不计消费** |
| 退款被当成收入 | 退款行与原订单配对抵消，两行都剔除，收支不被双向虚增 |
| 交易关闭的行也记了一笔 | 显式剔除，不记录根本没发生的支出 |
| 云端备份怕泄露 | AES-256-GCM 密文快照；公开仓库里读不出任何开销数据 |
| Android 要能装 | PWA，Chrome「添加到主屏幕」即可 |
| Windows 要能跑 | 浏览器打开即用 |

---

## 快速开始 / Quick start

```bash
npm ci                 # 安装依赖
npm run dev            # 本地开发服务器
npm test               # 单元测试
npm run build          # 构建 PWA 到 dist/
npm run check:no-plaintext   # 提交前必跑：阻止明文流水进入仓库
```

> Node.js **20+**（构建用 24.x 验证）。本机若没有 Node，可参考下方「环境说明」。

---

## 隐私模型 / Privacy model

这个仓库是**公开**的，而且 git 历史会被克隆和镜像 —— **删除一次提交并不等于抹掉它**。

1. 唯一允许提交的数据形态是 **AES-256-GCM 密文**（`*.enc`）。
2. 密钥由口令经 **PBKDF2-SHA256（60 万次迭代）** 派生，**只存在于设备内存**，绝不写入文件、日志、URL，也绝不放进 Actions secrets。
3. 快照使用 **4 KiB 定长填充**，文件大小不会暴露你某个月有多少笔消费。
4. 快照头部作为 **AES-GCM 附加认证数据**，所以篡改迭代次数或 salt 会让校验失败，无法被降级。
5. 导入的文件**全部在客户端解析**，不上传。
6. 提交前运行 `npm run check:no-plaintext`：它按内容（而非扩展名）拦截明文流水、身份证号与银行卡号。CI 会强制执行。

**没有后端是有意为之的收益**：明文根本没有机会离开设备。代价同样要讲清楚 —— Actions 无法读取你设备上的数据，所以**不存在真正的「自动同步」**，只能「手动导出快照 → 提交」。

---

## 架构 / Architecture

```
src/
  domain/        纯业务逻辑（无 IO，可完整重放）
    money.ts      整数「分」运算 —— 禁止浮点
    dates.ts      UTC 存储 / Asia/Shanghai 渲染
    fingerprint.ts 去重指纹（幂等的关键）
    classify.ts   kind 判定：还款 ≠ 消费
    transfers.ts  内部转账配对（1:1 与 1:N）
    categories.ts 规则表分类
    pipeline.ts   导入流水线（顺序有意义）
  importers/     按「格式」驱动，不按机构驱动
    sniff.ts      按字节内容识别容器，不看扩展名
    text.ts       CSV/TSV + HTML 表格（扫描表头，不硬编码行号）
    alipay.ts     支付宝专用
    wechat.ts     微信专用（含服务费拆分）
    generic.ts    银行/券商：模板驱动列映射
    xlsx.ts       read-excel-file（懒加载）
    pdf.ts        pdf.js 坐标重建表格（懒加载，最高风险）
  storage/db.ts  IndexedDB
  crypto/        AES-256-GCM 快照
  ui/            React 界面
```

**为什么按格式而不按机构**：银行能产出的容器格式是有限且已知的，而银行的数量不是，且每家都会毫无预警地改版。所以支持一家新银行是**改数据（模板）**，不是改代码。

**首屏体积是硬约束**：PWA 在 Android 上就是网页。`pdfjs-dist`（85 KB gzip + 一个 1.2 MB 的 worker）与 `read-excel-file` 都只在用户真的选中对应文件时才 `import()`，且**不进入 PWA 预缓存**。

---

## 已知限制 / Known limitations

诚实列出，避免误用：

- **真正的二进制 `.xls`（OLE/CFB）不支持**。很多银行把 TSV 或 HTML 表格命名为 `.xls`，那些**可以**读；但真 OLE 文件需要专门解析器，工具会明确报错并让你改导出 CSV/XLSX。
- **PDF 是兜底通道，不是主路径**。PDF 里没有「列」，只有带坐标的文字块，重建表格可能把两行并成一行或把金额错位。因此工具会展示列一致性与行数，并要求你**确认后**才入库。加密 PDF 支持，密码只留在内存。
- **银行模板需要你自己核对**。内置模板只是形状示例，不是已验证的真实布局。
- **2 分钟时间桶可能合并两笔等价交易**（无余额列时）。这是刻意的取舍：宁可少记一笔可疑重复，也不要在每次重新导入时把支出翻倍。
- **没有自动同步**（见上）。
- `transfer-internal` 的 1:N 配对有组合上限（最多 3 条腿、24 个候选），极端拆分场景可能漏配。

---

## 环境说明 / Environment note

若本机没有 Node.js，无需管理员权限的安装方式（Windows）：

```powershell
$ver = 'v24.21.0'
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile "$env:TEMP\node.zip"
Expand-Archive "$env:TEMP\node.zip" -DestinationPath "$env:LOCALAPPDATA\nodejs" -Force
```

然后用 `npm.cmd`（而不是 `npm`）执行脚本 —— PowerShell 默认执行策略可能拦截 `npm.ps1`。

---

## 文档 / Docs

- [`plan.md`](./plan.md) —— 需求（要做什么）
- [`AGENTS.md`](./AGENTS.md) —— 约束（怎么做），含隐私不变量与领域规则
