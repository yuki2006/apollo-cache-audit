class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cacheA = new InMemoryCache({
  typePolicies: {
    Organization: { keyFields: ["slug"] },
  },
});
