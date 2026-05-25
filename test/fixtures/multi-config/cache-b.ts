class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cacheB = new InMemoryCache({
  typePolicies: {
    UserProfile: { keyFields: ["handle"] },
    Organization: { keyFields: ["id"] }, // conflict: cache-a uses "slug"
  },
});
