// Runs every suite in this folder and returns non-zero if anything failed.
//
//   node test/run.mjs            all suites
//   node test/run.mjs ts board   only those
//
// Nothing here talks to the network or to AWS: `gen.mjs` rewrites the handler with the SDK imports stubbed,
// and each suite scripts its own `fetch`. So the whole thing runs offline, costs nothing, and needs no keys.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const SKIP = new Set(["run.mjs", "gen.mjs", "h.mjs", "results.mjs", "typesafe.mjs"]); // the runner and its copies

execFileSync(process.execPath, ["gen.mjs"], { cwd: here, stdio: "pipe" });

const wanted = process.argv.slice(2).map((a) => a.replace(/\.mjs$/, ""));
const suites = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && !SKIP.has(f))
  .filter((f) => !wanted.length || wanted.includes(f.replace(/\.mjs$/, "")))
  .sort();

let pass = 0, fail = 0, broken = 0;
for (const file of suites) {
  let out;
  try {
    out = execFileSync(process.execPath, [file], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // A suite that throws is worse than one that fails a check: nothing after the throw was tested at all.
    broken++;
    console.log(`${file.replace(/\.mjs$/, "").padEnd(10)} DID NOT RUN`);
    console.log(String(e.stdout || "").trim().split("\n").slice(-3).map((l) => "    " + l).join("\n"));
    console.log(String(e.stderr || "").trim().split("\n").slice(0, 3).map((l) => "    " + l).join("\n"));
    continue;
  }
  const last = out.trim().split("\n").pop() || "";
  const m = /(\d+) passed, (\d+) failed/.exec(last);
  if (!m) { broken++; console.log(`${file.replace(/\.mjs$/, "").padEnd(10)} NO RESULT LINE`); continue; }
  pass += Number(m[1]); fail += Number(m[2]);
  if (Number(m[2])) console.log(out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  console.log(`${file.replace(/\.mjs$/, "").padEnd(10)} ${m[1].padStart(4)} passed${Number(m[2]) ? `, ${m[2]} FAILED` : ""}`);
}

console.log(`\n${suites.length} suites, ${pass} checks passed, ${fail} failed${broken ? `, ${broken} did not run` : ""}`);
process.exit(fail || broken ? 1 : 0);
