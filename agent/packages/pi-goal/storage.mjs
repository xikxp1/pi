import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  realpath,
  stat,
  lstat,
} from "node:fs/promises";
import { dirname, join, resolve, relative, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_TYPES, ROLES, hash, profiles, filePath } from "./core.mjs";

export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
export async function readConfig(agentDir) {
  try {
    const value = JSON.parse(
      await readFile(join(agentDir, "goal.json"), "utf8"),
    );
    if (value.version !== 1) throw new Error("Unsupported goal.json version");
    return { version: 1, profiles: profiles(value.profiles) };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, profiles: {} };
    throw new Error(`Cannot read goal profiles: ${error.message}`);
  }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
export async function saveConfig(agentDir, value) {
  await atomicJson(join(agentDir, "goal.json"), {
    version: 1,
    profiles: profiles(value.profiles),
  });
}
export async function ensureAgents(agentDir, cwd, parseFrontmatter) {
  const agentPath = join(agentDir, "agents");
  await mkdir(agentPath, { recursive: true });
  const expected = new Map();
  for (const role of ROLES) {
    const type = AGENT_TYPES[role];
    const template = await readFile(
      join(PACKAGE_DIR, "agents", `${type}.md`),
      "utf8",
    );
    expected.set(type, template);
    try {
      await writeFile(join(agentPath, `${type}.md`), template, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  // The installed subagents runtime discovers by declared frontmatter name,
  // not filename. Fail closed on any competing definition, even in another file.
  const seen = new Set();
  for (const dir of new Set([
    agentPath,
    join(cwd, ".agents", "agents"),
    join(cwd, ".pi", "agents"),
  ])) {
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((name) => name.endsWith(".md"))) {
      const path = join(dir, name);
      const content = await readFile(path, "utf8");
      let parsed;
      try {
        parsed = parseFrontmatter(content.replace(/^\uFEFF/, ""));
      } catch (error) {
        throw new Error(
          `Cannot safely inspect agent definition ${path}: ${error.message}`,
        );
      }
      const declared =
        typeof parsed.frontmatter?.name === "string"
          ? parsed.frontmatter.name.trim()
          : "";
      const type = declared || basename(name, ".md");
      if (!expected.has(type)) continue;
      if (
        path !== join(agentPath, `${type}.md`) ||
        content !== expected.get(type) ||
        seen.has(type)
      ) {
        throw new Error(
          `Goal agent policy conflict: ${path}. Keep bundled ${type} unchanged; configure model/thinking with /goal profile instead.`,
        );
      }
      seen.add(type);
    }
  }
  if (seen.size !== ROLES.length)
    throw new Error("Goal agent definitions are incomplete");
  // RPC spawn reloads definitions from process.cwd in pi-subagents 0.19.0.
  if ((await realpath(cwd)) !== (await realpath(process.cwd())))
    throw new Error(
      "Subagent runtime cwd differs from this session. Restart Pi in the project directory.",
    );
}
export async function safePath(cwd, input) {
  const path = filePath(input);
  if (path.split("/").includes(".git"))
    throw new Error("Git metadata cannot be a goal target");
  const root = await realpath(cwd);
  const absolute = resolve(root, path);
  let ancestor = absolute;
  for (;;) {
    try {
      const target = await realpath(ancestor);
      const rel = relative(root, target);
      if (rel.split(/[\\/]/).includes(".git"))
        throw new Error(
          "Git metadata cannot be a goal target, including through symlinks",
        );
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
        throw new Error(`Target escapes project through a symlink: ${path}`);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // realpath also reports ENOENT for a dangling symlink. Do not ascend
      // past one and accidentally approve its nonexistent external target.
      try {
        if ((await lstat(ancestor)).isSymbolicLink())
          throw new Error(`Dangling symlink cannot be a goal target: ${path}`);
      } catch (entryError) {
        if (entryError.code !== "ENOENT") throw entryError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return absolute;
}
export async function snapshot(cwd, plan) {
  const paths = [...new Set(plan.steps.flatMap((step) => step.files))].sort();
  const result = {};
  for (const path of paths) {
    const absolute = await safePath(cwd, path);
    try {
      const info = await stat(absolute);
      if (!info.isFile())
        throw new Error(`Plan target must be a file: ${path}`);
      if (info.size > 5 * 1024 * 1024)
        throw new Error(`Plan target exceeds 5 MiB: ${path}`);
      const content = await readFile(absolute);
      result[path] = { hash: hash(content), bytes: content.length };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      result[path] = null;
    }
  }
  return result;
}
export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (path) => JSON.stringify(before[path]) !== JSON.stringify(after[path]),
  );
}
export function artifactDir(agentDir, sessionId, goalId) {
  const safe = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(agentDir, "goals", safe(sessionId), safe(goalId));
}
export async function saveArtifact(dir, label, value) {
  const path = join(
    dir,
    `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID().slice(0, 8)}.json`,
  );
  await atomicJson(path, value);
  return path;
}
