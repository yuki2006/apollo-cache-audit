class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cache = new InMemoryCache({
  typePolicies: {
    Membership: {
      keyFields: ["orgId", "userId"],
    },
    OtherType: {
      keyFields: (obj: { foo: string }) => `OtherType:${obj.foo}`,
    },
  },
});
