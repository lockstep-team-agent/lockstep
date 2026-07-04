import { GOLDEN } from "./golden.js";
import { recall } from "../distill/recall.js";
import { extract } from "../distill/extract.js";
import { gate } from "../distill/gate.js";

/**
 * Extraction eval (A.7): run the funnel's decision-detection stages over the golden set and report
 * precision / recall / F1. A prediction is "decision" iff it survives recall AND gate() says propose.
 * Run before/after prompt changes to catch regressions. Needs ANTHROPIC_API_KEY.
 */
export async function runEval(): Promise<void> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const ex of GOLDEN) {
    const recalled = await recall(ex.text, true);
    let predicted: "decision" | "not" = "not";
    if (recalled) {
      const x = await extract(ex.id, ex.text);
      predicted = gate(x) === "propose" ? "decision" : "not";
    }
    const ok = predicted === ex.label;
    if (ex.label === "decision" && predicted === "decision") tp++;
    else if (ex.label === "not" && predicted === "decision") fp++;
    else if (ex.label === "decision" && predicted === "not") fn++;
    else tn++;
    console.log(`${ok ? "✓" : "✗"} ${ex.id.padEnd(20)} expected=${ex.label} predicted=${predicted}`);
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const rec = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + rec === 0 ? 0 : (2 * precision * rec) / (precision + rec);
  console.log(
    `\nprecision=${precision.toFixed(2)} recall=${rec.toFixed(2)} f1=${f1.toFixed(2)} ` +
      `(tp=${tp} fp=${fp} fn=${fn} tn=${tn}, n=${GOLDEN.length})`,
  );
  // Non-zero exit if recall drops below the gate (CI signal).
  if (rec < 0.8) {
    console.error("recall below 0.8 threshold");
    process.exitCode = 1;
  }
}
