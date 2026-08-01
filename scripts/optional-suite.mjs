const suite = process.argv[2];

if (suite !== "live" && suite !== "benchmark") {
  throw new Error("Expected optional suite name: live or benchmark");
}

console.log(
  JSON.stringify({
    status: "not-applicable",
    suite,
    reason: `Phase 0 has no ${suite} owner or external endpoint cases.`,
  }),
);
