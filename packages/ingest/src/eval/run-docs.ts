import { GOLDEN_PRD } from "./golden-prd.js";
import { recallDoc } from "../distill/recall.js";
import { extractDoc } from "../distill/extract.js";
import { gateDoc, DOC_CONFIDENCE_FLOOR } from "../distill/gate.js";

/**
 * Doc-extraction eval (v3 ship gate): run recallDoc → extractDoc → gateDoc over the guest-checkout PRD
 * fixture. A section is predicted "extracted" iff it survives recall AND the gate says propose (the 0.7
 * floor — propose_low sits below the ratification digest bar and doesn't count). Precision < 0.90 fails
 * the run; recall is informational with a 0.75 target. Needs ANTHROPIC_API_KEY.
 */
export async function runDocEval(): Promise<void> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const sec of GOLDEN_PRD) {
    const recalled = await recallDoc(sec.text, true);
    let predicted = false;
    let kind = "";
    if (recalled) {
      const x = await extractDoc(sec.anchorKey, sec.text);
      predicted = gateDoc(x) === "propose";
      kind = x.constraint_kind;
    }
    const ok = predicted === sec.expect.extracted;
    if (sec.expect.extracted && predicted) tp++;
    else if (!sec.expect.extracted && predicted) fp++;
    else if (sec.expect.extracted && !predicted) fn++;
    else tn++;
    const label = sec.headingPath[sec.headingPath.length - 1] ?? "(preamble)";
    console.log(
      `${ok ? "✓" : "✗"} ${label.padEnd(28)} expected=${sec.expect.extracted ? "constraint" : "not"} ` +
        `predicted=${predicted ? `constraint (${kind})` : "not"}`,
    );
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const rec = tp + fn === 0 ? 1 : tp / (tp + fn);
  console.log(
    `\nprecision=${precision.toFixed(2)} recall=${rec.toFixed(2)} ` +
      `(tp=${tp} fp=${fp} fn=${fn} tn=${tn}, n=${GOLDEN_PRD.length}, floor=${DOC_CONFIDENCE_FLOOR})`,
  );
  // Non-zero exit if precision drops below the ship gate (a wrong "constraint" wastes a PM's ratify click).
  if (precision < 0.9) {
    console.error("precision below the 0.90 ship gate");
    process.exitCode = 1;
  }
  if (rec < 0.75) console.warn("recall below the 0.75 target (informational)");
}
