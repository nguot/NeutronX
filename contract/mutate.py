#!/usr/bin/env python3
"""
Minimal, transparent mutation-testing runner for the NeutronX pure libraries.

Why this exists
---------------
The previous `mutation-report.txt` was produced by a crude character-level
mutator that inserted *non-compiling* garbage (e.g. `curs < urrentStartPrice`),
so 67/75 mutants were "Error" and the headline "8/75 killed" was misleading.

This runner only emits mutants that are legal Solidity operator swaps, then
classifies each as:
  - EXCLUDED : the mutant does not compile (stillborn — never counts)
  - KILLED   : compiles, but at least one test fails (the suite caught it)
  - LIVED    : compiles, all tests pass (a real gap in the test suite)

Mutation score = KILLED / (KILLED + LIVED)   -- excludes stillborn mutants.
"""

import re, subprocess, sys, pathlib

CONTRACT_DIR = pathlib.Path(__file__).resolve().parent

# Scoped to the deterministic pure libs (see TESTCASE_DETAILED.md §"Mutation testing").
TARGETS = [
    "src/libs/RemainingLib.sol",
    "src/libs/ScaledOutputLib.sol",
    "src/libs/DecayCursorLib.sol",
    "src/libs/DynamicStakeLib.sol",
]

TEST_MATCH = "test/libs/*"  # deterministic, no RPC needed

# Operator swaps. Longer operators are matched first so `<=` is never seen as `<`.
SWAPS = {
    "<=": ">=", ">=": "<=", "==": "!=", "!=": "==",
    "<": ">", ">": "<", "+": "-", "-": "+", "*": "/", "/": "*",
}
OP_RE = re.compile(r"(?<![<>=!+\-*/])(<=|>=|==|!=|<|>|\+|-|\*|/)(?![<>=])")


def in_string(line: str, pos: int) -> bool:
    return line[:pos].count('"') % 2 == 1


def is_comment(line: str) -> bool:
    s = line.strip()
    return s.startswith("//") or s.startswith("*") or s.startswith("/*")


def gen_mutants(path: pathlib.Path):
    """Yield (line_no, col, original_line, mutated_line, orig_op, new_op)."""
    lines = path.read_text().splitlines()
    for i, line in enumerate(lines):
        if is_comment(line):
            continue
        for m in OP_RE.finditer(line):
            op = m.group(1)
            if op not in SWAPS:
                continue
            if in_string(line, m.start()):
                continue
            new = SWAPS[op]
            mutated = line[: m.start()] + new + line[m.end():]
            yield i, m.start(), line, mutated, op, new


def run_tests() -> str:
    """Return 'excluded' (no compile), 'killed' (test failed), or 'lived' (all pass)."""
    r = subprocess.run(
        ["forge", "test", "--match-path", TEST_MATCH],
        cwd=CONTRACT_DIR, capture_output=True, text=True,
    )
    out = r.stdout + r.stderr
    if "Compiler run failed" in out or re.search(r"Error \(\d+\)", out):
        return "excluded"
    return "killed" if r.returncode != 0 else "lived"


def main():
    report = []
    tally = {"killed": 0, "lived": 0, "excluded": 0}
    survivors = []

    for rel in TARGETS:
        path = CONTRACT_DIR / rel
        original = path.read_text()
        for (ln, col, oline, mline, op, new) in gen_mutants(path):
            path.write_text(original.replace(oline, mline, 1))
            try:
                result = run_tests()
            finally:
                path.write_text(original)  # always restore
            tally[result] += 1
            tag = {"killed": "KILLED ", "lived": "LIVED  ", "excluded": "EXCLUDED"}[result]
            line = f"[{tag}] {rel}:{ln+1}  '{op}' -> '{new}'"
            print(line, flush=True)
            report.append(line)
            report.append(f"           {oline.strip()}")
            report.append(f"        => {mline.strip()}")
            if result == "lived":
                survivors.append(line)

    valid = tally["killed"] + tally["lived"]
    score = (tally["killed"] / valid * 100) if valid else 0.0

    header = [
        "Mutation testing report (regenerated) — NeutronX pure libs",
        "=" * 60,
        f"Targets       : {', '.join(TARGETS)}",
        f"Test scope    : {TEST_MATCH}",
        "",
        f"Total mutants : {sum(tally.values())}",
        f"  Killed      : {tally['killed']}",
        f"  Lived       : {tally['lived']}   (real test gaps)",
        f"  Excluded    : {tally['excluded']}   (did not compile — stillborn)",
        "",
        f"Mutation score: {tally['killed']}/{valid} = {score:.1f}%   (excludes stillborn)",
        "=" * 60,
        "",
    ]
    if survivors:
        header.append("SURVIVORS (add tests to kill these):")
        header.extend("  " + s for s in survivors)
        header.append("")

    out_path = CONTRACT_DIR / "mutation-report.txt"
    out_path.write_text("\n".join(header + report) + "\n")
    print("\n".join(header))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
