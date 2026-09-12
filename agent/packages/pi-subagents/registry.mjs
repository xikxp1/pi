import { topLevel } from "./manager.mjs";
/** Registry references remain scoped to their original parent, even after /new. */
export function createRegistry({
  manager,
  spawn,
  isCurrent,
  getWorkflows = () => undefined,
}) {
  const current = () => {
    if (!isCurrent() || manager.closed)
      throw new Error(
        "Subagent registry belongs to an inactive parent session",
      );
  };
  return Object.freeze({
    goalResumeVersion: 1,
    getRecord(id) {
      const r = manager.getRecord(id);
      return topLevel(r) ? r : undefined;
    },
    hasRunning() {
      return (
        manager.hasRunning() ||
        Boolean(
          getWorkflows()
            ?.list()
            .some(
              (r) => !["completed", "failed", "cancelled"].includes(r.status),
            ),
        )
      );
    },
    async waitForAll() {
      await getWorkflows()?.waitForAll();
      await manager.waitForAll();
    },
    spawn(_pi, _ctx, type, prompt, options) {
      current();
      return spawn(type, prompt, options).id;
    },
    async resume(id, prompt, options) {
      current();
      if (
        typeof options?.invocationId !== "string" ||
        !options.invocationId.trim()
      )
        throw new Error("Managed goal resume requires invocationId");
      for (const key of Object.keys(options))
        if (!["invocationId", "signal", "maxTurns", "onStarted"].includes(key))
          throw new Error(`Unsupported managed resume option: ${key}`);
      return manager.resume(id, prompt, options);
    },
  });
}
