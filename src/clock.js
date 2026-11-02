// A PINNABLE CLOCK, for the decay and render-cache tests only. Nothing in production sets
// FAMILIAR_NOW_MS; without it, testing the 8s done and 30s error expiries, or a cached status
// line outliving its deadline, would require real sleeps.
export const now = () => (process.env.FAMILIAR_NOW_MS ? Number(process.env.FAMILIAR_NOW_MS) : Date.now());
