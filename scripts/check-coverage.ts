/**
 * CI's coverage minimum: totals coverage/lcov.info (from `bun test --coverage`)
 * over the app's code in src/, and fails below the minimum. Bun's own
 * `coverageThreshold` applies to every file separately, and some files are
 * legitimately less covered (TerminalPane's key chords); what mustn't happen
 * is the total slipping quietly.
 *
 *   bun scripts/check-coverage.ts [--lines 0.94] [--functions 0.88]
 *
 * The defaults sit just under where it was when this was added (lines
 * 94.9%, functions 89.5%): raise them as coverage grows.
 */
import { readFileSync } from "node:fs";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const minimum = { lines: arg("lines", 0.94), functions: arg("functions", 0.88) };

let lcov: string;
try {
  lcov = readFileSync("coverage/lcov.info", "utf8");
} catch {
  console.error("coverage/lcov.info not found — run `bun test --coverage` first");
  process.exit(2);
}

const total = { LF: 0, LH: 0, FNF: 0, FNH: 0 };
let counted = false;
for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) counted = /(^|\/)src\//.test(line.slice(3));
  const m = /^(LF|LH|FNF|FNH):(\d+)$/.exec(line);
  if (m && counted) total[m[1] as keyof typeof total] += Number(m[2]);
}

const lines = total.LF ? total.LH / total.LF : 1;
const functions = total.FNF ? total.FNH / total.FNF : 1;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
console.log(
  `src/ coverage: lines ${pct(lines)} (minimum ${pct(minimum.lines)}), functions ${pct(functions)} (minimum ${pct(minimum.functions)})`,
);
if (lines < minimum.lines || functions < minimum.functions) {
  console.error("Coverage fell below the minimum — cover the new code, or lower the minimum on purpose.");
  process.exit(1);
}
