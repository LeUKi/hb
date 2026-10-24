// How each of the four commands runs from npm: on the kit's own directory,
// a file argument read from where npm was started, and the exit code non-0
// on failure so AI tools and scripts can tell.
import { fileURLToPath } from "node:url";
import { KitError } from "./files.mjs";

const dir = fileURLToPath(new URL("../..", import.meta.url));

export async function main(command) {
  // Output piped into head and the like may end early: stop quietly.
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit();
  });
  try {
    const { exitCode } = await command({
      dir,
      cwd: process.env.INIT_CWD ?? process.cwd(),
      args: process.argv.slice(2),
    });
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof KitError ? `✗ ${error.message}` : error);
    process.exitCode = 1;
  }
}
