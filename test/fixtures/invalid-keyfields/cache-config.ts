class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cache = new InMemoryCache({
  typePolicies: {
    Membership: {
      keyFields: ["orgId", "userId"], // orgId no longer exists on Membership.
    },
  },
});
