class InMemoryCache {
  constructor(_config: unknown) {}
}

const basePolicies = {
  ExtraInfo: {
    keyFields: ["slug"],
  },
};

const extraPolicies = {
  Thing: {
    keyFields: ["id"],
  },
};

export const cache = new InMemoryCache({
  typePolicies: {
    ...basePolicies,
    ...extraPolicies,
  },
});
