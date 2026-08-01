# ninxes-definitions

Ninxes 官方 VIA definition 内容仓库。同步上游 `the-via/keyboards` 编译产物，经校验后发布，供 Ninxes 网页端按需读取单份 definition。

> 本仓库由 2026-08-01「VIA 兼容 JSON 处理方式」十一项裁定产生：definition 随前端部署按需拉取（A1），内容独立仓库、前端 `git submodule` 锁定 commit 引用（A2/A2补），manifest 采用修正版语义（B5），releaseVersion = 本仓库发布 tag（B6），每周 CI 检查上游（B7），前端团队维护（C11）。

## 1. 仓库结构

```text
manifest/index.json   清单：设备表、内容指纹、版本信息
v2/{vpid}.json        单份定义（旧格式，上游 src/ 编译产物）
v3/{vpid}.json        单份定义（新格式，上游 v3/ 编译产物）
tools/sync-upstream.mjs  同步流水线（唯一入口）
```

`vpid = vendorId * 65536 + productId`，十进制整数（**乘法**，JS 位移是 32 位会丢高位）。

## 2. manifest 语义（修正版，裁定 B5）

```json
{
  "schemaVersion": 1,
  "generatedAt": 1785600000000,
  "releaseVersion": "def-2026.08.02-r1",
  "upstreamRevision": "0ad67d366bdfbb363830d8b3822518c60055cc63",
  "vendorProductIds": { "v2": [ ... ], "v3": [ ... ] },
  "contentHash": "<整库指纹>",
  "hashes": { "v2/{vpid}.json": "<sha256>", ... }
}
```

- `vendorProductIds.v2` = `v2/` 目录**实际文件集**；`vendorProductIds.v3` = `v3/` 目录实际文件集。同一板可同时出现在两表
- **不复刻**上游 `supported_kbs.json` 的 superset 语义（其 v3 表只收 v3-only 板，导致 32 块 v2-only 板"在表但无文件"）。表即闸门：客户端查表命中才下载，不命中直接 `no-definition`，不发请求
- `hashes` 覆盖全部文件；`contentHash` 为全部 `path=hash` 排序拼接的 sha256，客户端据此判断缓存刷新

## 3. 硬约束（同步即校验，不满足即中止）

1. **同一 VID/PID 唯一（D3）**：`src/`、`v3/` 两棵源树各自内部 vpid 查重，撞号即失败中止
2. **产物完整性**：每份产物文件名 vpid 与内容 `vendorProductId` 一致
3. 锁定上游 revision 编译，manifest 记录 `upstreamRevision` / `generatedAt` / `releaseVersion` / `contentHash`
4. 人工审核后发布；每次发布留痕（git 历史 + 增删改清单）
5. 客户端不得在运行时请求任意 GitHub URL 或厂商地址——本仓库产物随前端部署，同源读取，无 CORS 问题（纯 Web 交付，裁定 C10）

## 4. 发布流程

```sh
# 完整流程（克隆上游 → 编译 → 校验 → 写入工作区）
node tools/sync-upstream.mjs --revision <上游commit-sha>

# 用已有编译产物复验（开发用）
node tools/sync-upstream.mjs --from-build <dist目录> --src-root <上游仓库目录> --revision <sha>
```

脚本只写工作区。之后：

1. 人工核对 `--notes` 输出的增删改清单
2. 提交、开 PR、人工合并（CI 每周一自动跑以上流程并开 PR，见 `.github/workflows/weekly-sync.yml`）
3. 合并到 main 后自动打 tag = manifest 的 `releaseVersion`（见 `.github/workflows/tag-release.yml`）；前端 submodule 指向新 tag 即完成发布

## 5. 验收对照（客户端假设）

- 定义总数与上游编译产物一致（当前基线 v3 2003 / v2 1484 @ `0ad67d366b`）
- manifest 通过客户端 `validateViaManifestShape` 校验；单份定义与上游产物逐字节一致
- 表与文件集严格一致：表内 vpid 必有文件，表外必无——这是"查表即闸门"成立的前提

## 6. 维护

- 频率：每周 CI 检查上游 HEAD，有新 commit 才跑流水线开 PR（裁定 B7）
- 负责人：前端团队（裁定 C11）
- 背景与需求全文：`tofix-migration/Ninxes-Definition服务端需求说明.md`（2026-08-02 改写版）
