/**
 * dsh-backup-button 的 host 半（Node 侧）—— v2「配置快照」体系。
 *
 * 三种触发：
 * 1. boot-auto：每次 harness 启动时对核心配置集做哈希去重快照——
 *    任一文件内容与上次快照不同才落盘（防止多实例频繁启动制造垃圾）；
 * 2. manual：侧边栏 💾 按钮（GET /backup/api/backup）——全量快照；
 *    **凭据默认排除**（config.includeCredentials 默认 false）：快照是明文副本且保留
 *    20 份，密钥跟着配置一起躺在 backups/ 里，最容易在"发个配置给我看看"时泄出去；
 * 3. 兼容保留：GET /backup/api/cleanup 仍可清理旧版平铺 .bak（保留最近 20 个）。
 *
 * 快照布局：backups/snapshots/<时间戳>-p<pid>/
 *   ├─ snapshot.json   自描述清单（ts/trigger/pid/files:[{safe, original, hash, size}]）
 *   └─ <safe-name>     各配置文件内容（safe 名 = 路径编码，original 字段还原真实路径）
 *
 * 保留策略：快照目录超过 MAX_SNAPSHOTS(20) 时自动删除最旧的（含清单项）。
 * 恢复入口：tools/dsh-restore.ps1（ZCode 接口：-List / -Restore latest|<ts> [-Only <safe>] [-To <dir>]）。
 *
 * 安全底线：只读配置文件、只写 backups/snapshots/ 目录；删除仅限超出保留上限的
 * 旧快照目录；失败返回 { ok:false, error } 而不是静默。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

const pad = (n) => String(n).padStart(2, "0");

/** 快照保留上限。 */
const MAX_SNAPSHOTS = 20;
/** 旧版平铺 .bak 的保留上限（cleanup 兼容路径用）。 */
const MAX_LEGACY_BACKUPS = 20;

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sha1(file) {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 快照集定义。original 相对 DSH_HOME；credentials 只在 includeCredentials 明确
 * 打开时才纳入（它含 API 密钥与浏览器会话密钥，且每次启动轮换，纳入 auto 去重
 * 会导致每次启动都落盘）。
 */
function snapshotSet(home, includeCredentials) {
  const entries = [
    { original: "profiles/web/cordis.patch.yml", safe: "web__cordis.patch.yml" },
    { original: "profiles/dev/cordis.patch.yml", safe: "dev__cordis.patch.yml" },
    { original: "cordis.patch.yml", safe: "root__cordis.patch.yml" },
    { original: "profiles/web/package.json", safe: "web__package.json" },
    { original: "profiles/web/pnpm-workspace.yaml", safe: "web__pnpm-workspace.yaml" },
    { original: "profiles/web/pnpm-lock.yaml", safe: "web__pnpm-lock.yaml" },
    { original: "profiles/dev/package.json", safe: "dev__package.json" },
    { original: "settings.yaml", safe: "settings.yaml" }
  ];
  if (includeCredentials) entries.push({ original: ".credentials.yaml", safe: "credentials.yaml" });
  return entries
    .map((e) => ({ ...e, abs: resolve(home, e.original) }))
    .filter((e) => existsSync(e.abs));
}

/** 旧版平铺 .bak 的列出与排序（cleanup 兼容路径）。 */
function backupSortKey(name, mtimeMs) {
  const m = /(\d{8})-(\d{4})/.exec(name);
  if (m) return `T${m[1]}${m[2]}`;
  return `M${String(Math.trunc(mtimeMs)).padStart(16, "0")}`;
}

function listLegacyBackups(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => name.endsWith(".bak") || name.includes(".bak-"))
    .map((name) => {
      const path = join(backupDir, name);
      return { name, path, key: backupSortKey(name, statSync(path).mtimeMs) };
    })
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

const BackupButtonHost = {
  name: "backup-button-host",
  inject: ["webServer"],
  apply(ctx, config = {}) {
    const home = config.home ?? process.env.DSH_HOME ?? join(os.homedir(), ".dsh");
    const profile = config.profile ?? process.env.DSH_PROFILE ?? "web";
    const legacySourceFile = resolve(config.sourceFile ?? join(home, "profiles", profile, "cordis.patch.yml"));
    const backupDir = resolve(config.backupDir ?? join(home, "backups"));
    /**
     * 是否把 .credentials.yaml 纳入手快照。默认 false——快照是明文且保留 20 份，
     * 密钥不该跟着配置一起躺在 backups/ 里。要旧行为：本行 config 加
     * includeCredentials: true 后重启。
     */
    const includeCredentials = config.includeCredentials === true;
    const snapRoot = join(backupDir, "snapshots");
    const stateFile = join(snapRoot, ".last-hashes.json");

    /** 列出全部快照目录（按时间戳从新到旧）。 */
    const listSnapshots = () => {
      if (!existsSync(snapRoot)) return [];
      return readdirSync(snapRoot)
        .filter((name) => /^\d{8}-\d{6}-p\d+$/.test(name) && existsSync(join(snapRoot, name, "snapshot.json")))
        .sort()
        .reverse()
        .map((name) => {
          try {
            const meta = JSON.parse(readFileSync(join(snapRoot, name, "snapshot.json"), "utf8"));
            return { dir: name, ts: meta.ts, trigger: meta.trigger, files: (meta.files || []).length, time: meta.time };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    };

    /** 执行一次快照；返回 { dir, files } 或 { skipped }（auto 且全部未变）。 */
    const takeSnapshot = (trigger, includeCredentials) => {
      const set = snapshotSet(home, includeCredentials);
      if (!set.length) return { error: "没有任何可快照的配置文件" };
      if (trigger === "boot-auto") {
        let last = {};
        try { last = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
        const changed = set.filter((e) => sha1(e.abs) !== last[e.original]);
        if (!changed.length) return { skipped: true };
      }
      mkdirSync(snapRoot, { recursive: true });
      const ts = timestamp();
      const dir = join(snapRoot, `${ts}-p${process.pid}`);
      mkdirSync(dir, { recursive: true });
      const files = [];
      for (const e of set) {
        try {
          copyFileSync(e.abs, join(dir, e.safe));
          files.push({ safe: e.safe, original: e.original, hash: sha1(e.abs), size: statSync(e.abs).size });
        } catch (err) {
          ctx.logger.warn(`[backup-button] 快照跳过 ${e.original}: ${err?.message ?? err}`);
        }
      }
      const meta = { ts, time: new Date().toISOString(), trigger, pid: process.pid, files };
      writeFileSync(join(dir, "snapshot.json"), JSON.stringify(meta, null, 2));
      // 更新 auto 去重状态（manual 也更新，避免下次 boot 重复落盘同样内容）。
      try {
        const hashes = {};
        for (const f of files) hashes[f.original] = f.hash;
        writeFileSync(stateFile, JSON.stringify(hashes, null, 2));
      } catch {}
      // 保留策略：按目录名计数（含"写到一半/清单坏了"的目录）。
      // 原来只用 listSnapshots()（要求 snapshot.json 可解析）→ 坏目录永远不参与回收，无上限堆积。
      const all = readdirSync(snapRoot)
        .filter((name) => /^\d{8}-\d{6}-p\d+$/.test(name))
        .sort()
        .reverse();
      for (const old of all.slice(MAX_SNAPSHOTS)) {
        try { rmSync(join(snapRoot, old), { recursive: true, force: true }); } catch {}
      }
      ctx.logger.info(`[backup-button] 配置快照(${trigger}) -> ${dir}（${files.length} 个文件）`);
      return { dir: `${ts}-p${process.pid}`, files: files.length };
    };

    // boot-auto：启动即做一次去重快照（尽力而为，失败只告警不拖垮启动）。
    try {
      const r = takeSnapshot("boot-auto", false);
      if (r?.skipped) ctx.logger.info("[backup-button] 配置自上次快照以来无变化，跳过 boot 快照");
      else if (r?.error) ctx.logger.warn("[backup-button] boot 快照未做：" + r.error);
    } catch (err) {
      ctx.logger.warn(`[backup-button] boot 快照失败: ${err?.message ?? err}`);
    }

    ctx.effect(() => ctx.webServer.register({
      kind: "prefix",
      path: "/backup/api",
      handler: async (req, res) => {
        try {
          const pathname = new URL(req.url ?? "/", "http://x").pathname;
          if (req.method === "GET" && pathname === "/backup/api/backup") {
            const r = takeSnapshot("manual", includeCredentials);
            if (r.error) { sendJson(res, 500, { ok: false, error: r.error }); return; }
            sendJson(res, 200, {
              ok: true,
              dir: r.dir,
              files: r.files,
              kept: MAX_SNAPSHOTS,
              credentials: includeCredentials
                ? "included"
                : "excluded（默认不复制密钥；需要时在 cordis.patch.yml 里给 backup-button 行加 config.includeCredentials: true 后重启）"
            });
            return;
          }
          if (req.method === "GET" && pathname === "/backup/api/snapshots") {
            sendJson(res, 200, { ok: true, snapshots: listSnapshots().slice(0, 50) });
            return;
          }
          if (req.method === "GET" && pathname === "/backup/api/cleanup") {
            // 兼容路径：清理旧版平铺 .bak（新版快照的保留在 takeSnapshot 内自动执行）。
            const all = listLegacyBackups(backupDir);
            if (all.length <= MAX_LEGACY_BACKUPS) {
              sendJson(res, 200, { ok: true, deleted: [], total: all.length, note: "无需清理（未超过上限）" });
              return;
            }
            const excess = all.slice(MAX_LEGACY_BACKUPS);
            // 删的是 backups/ 下所有 *.bak，不只本插件的产物；没有确认就只报清单，不动手。
            if (new URL(req.url ?? "/", "http://x").searchParams.get("confirm") !== "1") {
              sendJson(res, 200, {
                ok: false,
                needsConfirm: true,
                count: excess.length,
                files: excess.map((f) => f.name),
                note: "要真删请再请求一次并加 ?confirm=1"
              });
              return;
            }
            for (const f of excess) { try { rmSync(f.path, { force: true }); } catch {} }
            sendJson(res, 200, { ok: true, deleted: excess.map((f) => f.name), total: MAX_LEGACY_BACKUPS });
            return;
          }
          sendJson(res, 404, { ok: false, error: "未知端点" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`[backup-button] 请求失败: ${message}`);
          sendJson(res, 500, { ok: false, error: message });
        }
      }
    }), "backup-button: /backup/api 快照路由");
  }
};

export default BackupButtonHost;
