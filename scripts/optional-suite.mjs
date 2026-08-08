const suite = process.argv[2];

if (suite !== "live" && suite !== "benchmark") {
  throw new Error("Expected optional suite name: live or benchmark");
}

console.log(
  JSON.stringify({
    status: "not-applicable",
    suite,
    reason:
      suite === "live"
        ? "Phase 2 production verification is offline by default; this checkout has no configured external Provider or Computer Use endpoint case."
        : "Phase 2 winner evidence is preserved outside the repository by hash; disposable candidate runners are not part of the production tree.",
  }),
);
