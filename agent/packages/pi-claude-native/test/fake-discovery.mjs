import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

export function run(mode, report) {
  let input = "";
  const heartbeat = setInterval(() => {}, 1000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\n")) return;
    const request = JSON.parse(input.trim());
    const info = { input, cwd: process.cwd(), args: process.argv.slice(2) };
    const respond = (models, subtype = "success", id = request.request_id) => {
      process.stdout.write(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype,
            request_id: id,
            response: { models, account: "secret-account" },
          },
        }) + "\n",
      );
    };
    if (mode === "group" || mode === "group-timeout") {
      const descendant = spawn(
        process.execPath,
        [
          "-e",
          'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)',
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      info.descendant = descendant.pid;
      descendant.stdout.once("data", () => {
        writeFileSync(report, JSON.stringify(info));
        if (mode === "group") respond([{ value: "default" }]);
        // Leader exits before discovery cleanup; descendant still belongs to group.
        process.exit(0);
      });
      return;
    }
    writeFileSync(report, JSON.stringify(info));
    if (Array.isArray(mode?.models)) return respond(mode.models);
    if (mode === "timeout") return;
    if (mode === "exit") {
      clearInterval(heartbeat);
      process.exit(3);
    }
    if (mode === "malformed") return process.stdout.write("not-json\n");
    if (mode === "overflow")
      return process.stdout.write("x".repeat(1024 * 1024 + 1));
    if (mode === "stderr") return process.stderr.write("secret".repeat(200000));
    if (mode === "error") return respond(undefined, "error");
    if (mode === "empty") return respond([]);
    if (mode === "invalid")
      return respond([{ value: "default", supportsEffort: "yes" }]);
    if (mode === "wrong-id")
      return respond([{ value: "wrong" }], "success", "other");
    // Unrelated, valid JSON messages must not be mistaken for initialization.
    process.stdout.write(
      JSON.stringify({ type: "system", account: "secret-account" }) + "\n",
    );
    respond([
      {
        value: "default",
        resolvedModel: "claude-opus-5-5[1m]",
        displayName: "Default",
        description: "Opus",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
        supportsAdaptiveThinking: true,
        credentials: "secret",
      },
      { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" },
      { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    ]);
  });
}
