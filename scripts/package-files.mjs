import { copyFileSync } from "node:fs";
for (const name of ["LICENSE", "NOTICE"]) {
  copyFileSync(new URL(`../${name}`, import.meta.url), name);
}
