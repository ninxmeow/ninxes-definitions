// Ninxes definition 同步流水线（2026-08-01 裁定 A4：五项职责全保留）。
//
// 职责：
//   ① 锁定上游 the-via/keyboards revision 编译（scripts/build-all.ts 产物）
//   ② 撞号检出即中止（D3）：src/v3 两棵源树各自内部 vendorProductId 必须唯一；
//      产物逐份核对文件名 vpid 与内容 vendorProductId 一致
//   ③ 生成 manifest：schemaVersion/generatedAt/releaseVersion/upstreamRevision/
//      vendorProductIds（修正版语义：两表 = 产物实际文件集）/hashes/contentHash
//   ④ 人工审核：本脚本只产出工作区变更，发布走 PR 人工合并（见 README §4）
//   ⑤ 发布留痕：git 历史 + releaseVersion = 仓库发布 tag + --notes 输出增删改清单
//
// 用法：
//   node tools/sync-upstream.mjs --revision <sha>          # 完整流程：克隆→编译→发布
//   node tools/sync-upstream.mjs --from-build <dist目录> --src-root <上游仓库目录> \
//        --revision <sha>                                  # 用已有编译产物（开发/复验）
//
// 选项：
//   --release-version <tag>   缺省自动推导 def-YYYY.MM.DD-rN（已存在同名 tag 则 N 递增）
//   --upstream-dir <path>     上游工作副本缓存目录（缺省 .upstream/，gitignored）
//   --notes <path>            增删改清单输出（缺省打印到 stdout）
//
// 已知坑：上游 scripts/build-all.ts 的 fs.remove('dist') 是硬编码，必须在上游
// 工作副本根目录执行，产物固定在 <上游>/dist。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_URL = "https://github.com/the-via/keyboards";

// ---------- 参数 ----------

const parseArgs = (argv) => {
  const args = { upstreamDir: join(repoRoot, ".upstream") };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--revision") { args.revision = value; i += 1; }
    else if (key === "--from-build") { args.fromBuild = resolve(value); i += 1; }
    else if (key === "--src-root") { args.srcRoot = resolve(value); i += 1; }
    else if (key === "--release-version") { args.releaseVersion = value; i += 1; }
    else if (key === "--upstream-dir") { args.upstreamDir = resolve(value); i += 1; }
    else if (key === "--notes") { args.notes = resolve(value); i += 1; }
    else { throw new Error(`未知参数：${key}`); }
  }
  if (!args.revision) throw new Error("缺少 --revision <sha>");
  if (args.fromBuild && !args.srcRoot) throw new Error("--from-build 需配 --src-root 做撞号检出");
  return args;
};

// ---------- 小工具 ----------

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const walkJsonFiles = (dir) => {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
    }
  };
  walk(dir);
  return out;
};

// 源文件 vendorId/productId 是十六进制字符串，上游形态参差：允许省略 0x
// 前缀（实测 src/akb/ogr.json 为 "414B"）、允许首尾空白（实测
// src/oddforge/oddforge_vea.json 为 "0x4155 "）。trim + 按 hex 解析，
// 该形态已对上游全量 3487 份源文件验证零例外。
const vpidFromHexIds = (vendorId, productId) => {
  if (typeof vendorId !== "string" || typeof productId !== "string") return null;
  const strip = (s) => s.trim().replace(/^0[xX]/, "");
  if (!/^[0-9a-fA-F]+$/.test(strip(vendorId)) || !/^[0-9a-fA-F]+$/.test(strip(productId))) return null;
  const vid = parseInt(strip(vendorId), 16);
  const pid = parseInt(strip(productId), 16);
  if (vid > 0xffff || pid > 0xffff) return null;
  // 乘法而非位移：JS 位运算是 32 位（上游 hid-keyboards.ts:6-9 同注）
  return vid * 65536 + pid;
};

// ---------- ① 上游编译 ----------

const buildUpstream = (upstreamDir, revision) => {
  if (!existsSync(join(upstreamDir, ".git"))) {
    mkdirSync(upstreamDir, { recursive: true });
    run("git", ["init", "-q"], upstreamDir);
    run("git", ["remote", "add", "origin", UPSTREAM_URL], upstreamDir);
  }
  run("git", ["fetch", "--depth", "1", "origin", revision], upstreamDir);
  run("git", ["checkout", "-q", "FETCH_HEAD"], upstreamDir);
  run("npm", ["ci"], upstreamDir);
  run("npx", ["tsx", "scripts/build-all.ts"], upstreamDir);
  return join(upstreamDir, "dist");
};

// ---------- ② 撞号检出（D3）----------

// 源树级别：同一棵树内 vpid 必须唯一。src 与 v3 之间同 vpid 是常态
// （同一板的 v2 源与 v3 源），不算撞号。
const checkSourceTreeUnique = (srcRoot, tree) => {
  const dir = join(srcRoot, tree);
  if (!existsSync(dir)) return { tree, files: 0 };
  const byVpid = new Map();
  for (const file of walkJsonFiles(dir)) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const vpid = vpidFromHexIds(parsed.vendorId, parsed.productId);
    if (vpid === null) {
      throw new Error(`撞号检出失败：${file} 缺少合法 vendorId/productId`);
    }
    if (!byVpid.has(vpid)) byVpid.set(vpid, []);
    byVpid.get(vpid).push(file);
  }
  for (const [vpid, files] of byVpid) {
    if (files.length > 1) {
      throw new Error(
        `撞号（D3）：${tree} 树内 vendorProductId=${vpid} 被 ${files.length} 份源文件共用：\n  ${files.join("\n  ")}`,
      );
    }
  }
  return { tree, files: byVpid.size };
};

// 产物级别：文件名 vpid 必须与内容 vendorProductId 一致
const checkDistIntegrity = (distDir, version) => {
  const dir = join(distDir, version);
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const vpids = [];
  for (const name of files) {
    const vpid = Number(name.slice(0, -".json".length));
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (parsed.vendorProductId !== vpid) {
      throw new Error(
        `产物完整性失败：${version}/${name} 内容 vendorProductId=${parsed.vendorProductId} 与文件名不符`,
      );
    }
    vpids.push(vpid);
  }
  return vpids.sort((a, b) => a - b);
};

// ---------- ③ manifest ----------

const nextReleaseVersion = () => {
  const now = new Date();
  const stamp = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  let tags = [];
  try {
    tags = execFileSync("git", ["tag", "--list", `def-${stamp}-r*`], { cwd: repoRoot })
      .toString().trim().split("\n").filter(Boolean);
  } catch { /* 无 tag 时从 r1 开始 */ }
  return `def-${stamp}-r${tags.length + 1}`;
};

const buildManifest = ({ distDir, revision, releaseVersion, v2Vpids, v3Vpids }) => {
  const hashes = {};
  for (const [version, vpids] of [["v2", v2Vpids], ["v3", v3Vpids]]) {
    for (const vpid of vpids) {
      const relPath = `${version}/${vpid}.json`;
      hashes[relPath] = sha256(readFileSync(join(distDir, version, `${vpid}.json`)));
    }
  }
  const contentHash = sha256(
    Object.keys(hashes).sort().map((path) => `${path}=${hashes[path]}`).join("\n"),
  );
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    releaseVersion,
    upstreamRevision: revision,
    vendorProductIds: { v2: v2Vpids, v3: v3Vpids },
    contentHash,
    hashes,
  };
};

// ---------- ⑤ 发布留痕：增删改清单 ----------

const diffAgainstPrevious = (manifest) => {
  const previousPath = join(repoRoot, "manifest", "index.json");
  if (!existsSync(previousPath)) {
    return { previous: null, added: Object.keys(manifest.hashes), removed: [], changed: [] };
  }
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, hash] of Object.entries(manifest.hashes)) {
    if (!(path in previous.hashes)) added.push(path);
    else if (previous.hashes[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(previous.hashes)) {
    if (!(path in manifest.hashes)) removed.push(path);
  }
  return { previous: previous.releaseVersion, added, removed, changed };
};

// ---------- 主流程 ----------

const main = () => {
  const args = parseArgs(process.argv.slice(2));

  const distDir = args.fromBuild ?? buildUpstream(args.upstreamDir, args.revision);
  const srcRoot = args.srcRoot ?? args.upstreamDir;
  console.log(`产物目录：${distDir}`);

  for (const tree of ["src", "v3"]) {
    const { files } = checkSourceTreeUnique(srcRoot, tree);
    console.log(`撞号检出 ${tree}：${files} 个 vpid 全部唯一 ✓`);
  }

  const v2Vpids = checkDistIntegrity(distDir, "v2");
  const v3Vpids = checkDistIntegrity(distDir, "v3");
  console.log(`产物完整性：v2=${v2Vpids.length} v3=${v3Vpids.length} 文件名与内容 vpid 一致 ✓`);

  const releaseVersion = args.releaseVersion ?? nextReleaseVersion();
  const manifest = buildManifest({ distDir, revision: args.revision, releaseVersion, v2Vpids, v3Vpids });
  const notes = diffAgainstPrevious(manifest);

  // 落盘：整体替换 v2/ v3/ manifest/（仓库内其余文件不动）
  for (const dir of ["v2", "v3", "manifest"]) {
    rmSync(join(repoRoot, dir), { recursive: true, force: true });
  }
  cpSync(join(distDir, "v2"), join(repoRoot, "v2"), { recursive: true });
  cpSync(join(distDir, "v3"), join(repoRoot, "v3"), { recursive: true });
  mkdirSync(join(repoRoot, "manifest"), { recursive: true });
  writeFileSync(join(repoRoot, "manifest", "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const notesText = [
    `releaseVersion: ${releaseVersion}`,
    `upstreamRevision: ${args.revision}`,
    `previous: ${notes.previous ?? "（首次发布）"}`,
    `v2: ${v2Vpids.length} 份 / v3: ${v3Vpids.length} 份`,
    `新增 ${notes.added.length} / 变更 ${notes.changed.length} / 删除 ${notes.removed.length}`,
    "",
    ...notes.added.map((p) => `+ ${p}`),
    ...notes.changed.map((p) => `~ ${p}`),
    ...notes.removed.map((p) => `- ${p}`),
    "",
  ].join("\n");
  if (args.notes) writeFileSync(args.notes, notesText);
  console.log(notesText);
  console.log("已写入工作区。请人工审核后提交、开 PR、合并并打 tag（README §4）。");
};

main();
