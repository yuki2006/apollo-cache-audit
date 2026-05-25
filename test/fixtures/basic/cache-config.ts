// Minimal stub of InMemoryCache so the fixture is self-contained.
class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cache = new InMemoryCache({
  typePolicies: {
    Article: {
      keyFields: ["id"],
    },
  },
});
