const suite = process.argv[2];

if (suite !== "benchmark") {
  throw new Error("Expected optional suite name: benchmark");
}

console.log(
  JSON.stringify({
    status: "not-applicable",
    suite,
    reason:
      "Winner evidence is preserved by Decision Record; disposable candidate runners are not part of the production tree.",
  }),
);
