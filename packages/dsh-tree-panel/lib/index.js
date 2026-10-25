import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dsh-tree-panel 的 host 半（Node 侧）。
 *
 * 当前为 UI-only 插件的占位：client 半（lib/client.js）自管面板 DOM，
 * 不需要 Node 侧路由。保留此文件作为将来扩展点（例如需要 host 侧提供
 * "全量会话头扫描"路由时——用 webServer.register 挂 /tree-panel/api/*）。
 *
 * 红线：本文件刻意保持零依赖、零副作用；任何会写共享 .dsh 的逻辑都必须
 * 先经过 dev profile 验证（见 TASK.md）。
 */

const name = "tree-panel";
const inject = [];

function apply(ctx) {
	// UI-only：无宿主逻辑。若将来需要 host 路由，在 config 里加开关后再实现。
	void ctx;
}

/** 读取插件自身版本（供 client 半在面板标题里显示，避免双处维护）。 */
async function pluginVersion() {
	try {
		const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export { apply, inject, name, pluginVersion };
