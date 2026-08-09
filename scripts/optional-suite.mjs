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
        ? "Production verification is offline by default; this checkout has no explicitly configured external endpoint case."
        : "Accepted Decision evidence is archived outside the repository by hash; winner behavior is covered by deterministic production regressions and disposable candidate runners are not shipped.",
  }),
);
