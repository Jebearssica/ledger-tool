# 记账工具 / Ledger Tool

个人记账工具：导入支付宝 / 微信 / 银行卡流水 → 去重 → 分类 → 识别内部转账与银证转账 → 多端查看。
A local-first personal expense tracker: import Alipay / WeChat Pay / bank statements → dedupe → categorize → detect internal & brokerage transfers → view on any device.

**没有后端。明文流水永远不离开你的设备。**
**No backend. Plaintext statements never leave your device.**

> ## 🚀 直接使用 / Live
>
> **<https://jebearssica.github.io/ledger-tool/>**
>
> 手机 Chrome 打开 → 菜单 → 「添加到主屏幕」，即可像 App 一样离线使用。
> Open in mobile Chrome → menu → "Add to Home screen" for an offline, app-like install.

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
| Android 要能装 | PWA，Chrome「添加到主屏幕」即可（**需要一个 HTTPS 地址**，见下） |
| Windows 要能跑 | 浏览器打开即用（`npm run preview` 后用 `http://localhost`） |

---

## 快速开始 / Quick start

```bash
npm ci                 # 安装依赖
npm run dev            # 本地开发服务器
npm test               # 单元测试
npm run build          # 构建 PWA 到 dist/
npm run preview        # 用 HTTP 提供构建产物
npm run check:no-plaintext   # 提交前必跑：阻止明文流水进入仓库
```

> Node.js **20+**（构建用 24.x 验证）。本机若没有 Node，可参考下方「环境说明」。

---

## 在 Windows 上使用 / Using it on Windows

### 推荐方式：本机构建后用 HTTP 打开

```powershell
npm run build      # 构建到 dist/
npm run preview    # 默认 http://localhost:4173
```

然后在浏览器打开 **http://localhost:4173**。这种方式**全部功能可用**，包括加密备份与「安装应用」。

同理，任何能静态托管 `dist/` 的本地 HTTP 服务都可以（`npx serve dist`、IIS、Caddy……）。

### 为什么不能直接双击 `dist/index.html`

**不要**把双击打开当作可靠方式。构建产物是 ES module（`<script type="module">`），而标准 Chrome / Edge 在 `file://` 协议下会因跨域限制**拒绝加载模块**，页面会是空白。

（实测：VS Code 内置浏览器允许 `file://` 加载模块，所以那样能跑通；但普通浏览器不行。差异来自浏览器策略，不是本项目的配置。）

### 首次使用流程

1. 打开应用 → 「导入」标签页
2. 选择从支付宝 / 微信 / 银行导出的账单文件（`.csv` / `.txt` / `.xls` / `.xlsx` / `.pdf`，或它们所在的 `.zip`）
3. 核对「识别结果」和「导入预览」—— **此处的数字就是入库后的数字**
4. 点「确认导入」

数据存在浏览器的 IndexedDB 里；**清除浏览器数据会一并清掉**，所以请定期在「备份」标签页导出加密快照。

---

## 在 Android 上使用 / Using it on Android

### 前提：必须是一个 HTTPS 地址

这是硬性要求，有两个独立的原因：

| 功能 | 为什么需要 HTTPS |
|---|---|
| 「添加到主屏幕」安装为 PWA | 浏览器只在**安全上下文**下注册 Service Worker |
| 导出 / 恢复加密快照 | Web Crypto（`crypto.subtle`）**只在安全上下文下存在** |

**安全上下文 = HTTPS，或 `http://localhost`。** 手机上的 `http://192.168.x.x:4173`（电脑开 `--host`、手机连同一 Wi-Fi）**不算**安全上下文。

因此 **`localhost` 无法用于手机**——`localhost` 指的是手机自己，而站点跑在电脑上。所以 Android 端只能走 HTTPS。

> 实测确认：在 `http://192.168.x.x` 下，`crypto.subtle` 为 `undefined`，Service Worker 注册数为 0。此时**导入与统计仍可用**，但无法安装、无法备份（应用会明确说明原因并禁用备份按钮，而不是报错）。

### 部署步骤（GitHub Pages）

仓库里已有 workflow [`.github/workflows/pages.yml`](./.github/workflows/pages.yml)，它会**先跑一遍校验**（隐私守卫 + 类型检查 + 单测），全部通过后才构建并发布 —— 所以「main 是绿的」和「线上是可用的」是同一个条件。构建失败或测试红，就不会发布。

#### 1. 创建远端仓库并推送

GitHub 的仓库名只允许 ASCII，而本地目录名是 `记账工具`。**建议用 `ledger-tool`**（与 `package.json` 的 `name` 一致）；中文名会出现在 URL 里并被百分号编码成 `%E8%AE%B0...`，能跑但很难看也难分享。

```powershell
# 在 GitHub 上先建好空仓库（不要勾选任何模板文件），然后：
git remote add origin https://github.com/<你的用户名>/ledger-tool.git
git push -u origin main
```

#### 2. 打开 Pages 开关（只需一次）

仓库 → **Settings → Pages → Build and deployment → Source** 选 **「GitHub Actions」**。

> 这一步是必须的。只推送 workflow 并不会自动开启 Pages，首次运行会因 Pages 未启用而失败。

开关打开后，到 **Actions** 标签页手动运行一次 `Deploy to GitHub Pages`（或再 push 一次）。

#### 3. 拿到地址

本项目已部署：**<https://jebearssica.github.io/ledger-tool/>**

路径是子目录，这是最容易出错的地方 —— 本项目的 `base: './'`（相对路径）已经在真实线上环境验证过：Service Worker 作用域、manifest、静态资源、以及懒加载的 PDF/XLSX chunk 在该子路径下全部正常解析。

#### 4. 手机安装

用手机 Chrome 打开该地址 → 菜单 → **「添加到主屏幕」**。之后从桌面图标启动即为独立窗口，且离线可用。

### 其他静态托管

不局限于 Pages。产物是纯静态文件、且用相对路径，所以可直接拖给 **Cloudflare Pages / Netlify / Vercel**，或放进任意 HTTPS 主机的子目录。

```powershell
npm run build      # 产物在 dist/
```

### 仓库要公开还是私有？（已核对 GitHub 官方文档）

先说结论：**建议保持公开**。这不是图省事，而是因为公开对本项目反而更安全。

| 问题 | 事实 |
|---|---|
| 私有仓库能用 Actions 吗？ | **能**。但会计量分钟数（GitHub Free = 2,000 分钟/月）。公开仓库免费且不计量。本项目三个 workflow 约 60–150 分钟/月，远在额度内，**所以这不是障碍**。 |
| 私有仓库能用 Pages 吗？ | ⚠️ **Free 计划下不能。** 官方文档：使用 GitHub Free 的账号，仓库**必须是公开的**。私有仓库要用 Pages 得升级到 Pro / Team / Enterprise。 |
| 仓库私有，网站就私有吗？ | ⚠️ **不是。** 官方文档明确：即使站点仓库是私有的，GitHub Pages 站点在互联网上**仍然公开可访问**。 |

一个容易踩的坑：私有仓库会诱使你“反正没人看得到”而提交账单原文件。**千万不要** —— 私有仓库可以随时改成公开，git 历史会一起公开；协作者、token 泄露、账号被盗都会泄露它；GitHub 的 ToS 本身也允许他们访问私有仓库内容。一旦泄露就**不可撤销**。

这也是本项目的设计取舍：**隐私不变量本来就是按「全世界可读」定的**，所以仓库公开反而更安全 —— 没有“私有了就无所谓”的幻觉空间，而 `check:no-plaintext` 也会一直拦着你。

**如果你确实要源码私有**：不要用 Pages（Free 下不可用），把 `dist/` 交给 **Cloudflare Pages / Netlify / Vercel** —— 它们免费、支持私有仓库、并且提供 HTTPS，Android 端照样能装。（但不能因此放宽上面的隐私规则。）

### 手机上的账单从哪来

支付宝 / 微信的账单**在手机 App 内申请导出**，然后直接在该 PWA 里导入即可 —— 文件不会离开手机。

---

## 两台设备之间怎么同步 / Moving data between devices

**Windows 和 Android 是两个独立的账本，默认互不相通。** 这是「无后端」的直接后果：数据只存在各自浏览器的 IndexedDB 里，没有服务器能替你转发。

要在设备之间搬运数据，只能走快照：

1. 在 **A 设备**「备份」标签页输入口令 → 导出 `ledger-YYYY-MM-DD.enc`
2. 把该文件传到 **B 设备**（U 盘 / 网盘 / 聊天工具——它是密文，传输途中被看到也读不出内容）
3. 在 **B 设备**「备份」标签页输入**同一口令** → 「从快照恢复」

注意两点：

- 恢复是**整体替换**，不是合并。B 设备原有的流水会被覆盖。
- 口令丢失则数据无法找回——没有后门，也没有任何重置途径。

如果想让仓库里也有一份备份，把 `.enc` 提交上去是安全的（它已被 `.gitignore` 覆盖，需用 `git add -f` 强制添加）：

```bash
git add -f ledger-2026-09-14.enc
```

**绝不要**提交账单原文件。提交前跑 `npm run check:no-plaintext`。

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

- **Android 端需要 HTTPS 地址**（最要紧的一条）。PWA 安装与加密备份都要求安全上下文，而手机访问 `http://192.168.x.x` **不算**安全上下文。在那种情况下导入与统计正常，但无法安装、无法备份。仓库里已备好 Pages workflow（见下），需要你先建远端仓库并在 Settings 里启用 Pages。
- **私有仓库在本项目的可用性受限**。Free 计划下私有仓库**无法使用 Pages**（官方要求仓库公开），而且**就算是付费计划的私有仓库，Pages 站点依然对全网公开**。详见「仓库要公开还是私有」。- **Windows 与 Android 是两个独立账本，不自动同步**。设备间搬运数据要走「导出快照 → 在另一台恢复」，且恢复是**整体替换**。
- **构建产物不能双击打开**。ES module 在 `file://` 下会被标准 Chrome/Edge 拦截，必须用 HTTP 提供（`npm run preview`）。
- **真正的二进制 `.xls`（OLE/CFB）不支持**。很多银行把 TSV 或 HTML 表格命名为 `.xls`，那些**可以**读；但真 OLE 文件需要专门解析器，工具会明确报错并让你改导出 CSV/XLSX。
- **PDF 是兜底通道，不是主路径**。PDF 里没有「列」，只有带坐标的文字块，重建表格可能把两行并成一行或把金额错位。因此工具会展示列一致性与行数，并要求你**确认后**才入库。加密 PDF 支持，密码只留在内存。
- **银行模板需要你自己核对**。内置模板只是形状示例，不是已验证的真实布局。
- **2 分钟时间桶可能合并两笔等价交易**（无余额列时）。这是刻意的取舍：宁可少记一笔可疑重复，也不要在每次重新导入时把支出翻倍。
- **没有自动同步**（见上）。
- **内部转账的 1:N 配对有组合上限**（最多 3 条腿、24 个候选）。一笔转出被拆成很多小额的极端场景可能漏配，漏配时不会静默丢弃，而是保留待你确认。

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
- [`.github/workflows/pages.yml`](./.github/workflows/pages.yml) —— 发布到 GitHub Pages
