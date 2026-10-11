import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localExperienceDefaults } from "./full-app-local-tools.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(
  process.execPath,
  [join(root, "scripts/full-app-server.mjs")],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      HB_FULL_APP_LOCAL_EXPERIENCE: "1",
      HB_FULL_APP_LOCAL_PORT:
        process.env.HB_FULL_APP_LOCAL_PORT ??
        String(localExperienceDefaults.publicPort),
      HB_FULL_APP_LOCAL_CONTROL_PORT:
        process.env.HB_FULL_APP_LOCAL_CONTROL_PORT ??
        String(localExperienceDefaults.controlPort),
      HB_FULL_APP_LOCAL_INTERNAL_PORT:
        process.env.HB_FULL_APP_LOCAL_INTERNAL_PORT ??
        String(localExperienceDefaults.internalPort),
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
