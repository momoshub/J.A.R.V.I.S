import { homedir } from "node:os";
import { join } from "node:path";

/** `~` and `~/x` mean the home directory; anything else is returned as given. */
export const expandHome = (path: string, home: string = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
