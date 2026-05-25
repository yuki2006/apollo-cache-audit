class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cache = new InMemoryCache({
  typePolicies: {
    ChildItem: { keyFields: false }, // explicit: do not normalize
  },
});
