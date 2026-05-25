class InMemoryCache {
  constructor(_config: unknown) {}
}

const ENTITY_TYPES = ["PrepaidPointBalance", "UserItem"] as const;

export const cache = new InMemoryCache({
  dataIdFromObject: (obj: { __typename?: string }) => {
    if (ENTITY_TYPES.includes((obj.__typename ?? "") as (typeof ENTITY_TYPES)[number])) {
      return `${obj.__typename}:custom-key`;
    }
    return undefined;
  },
});
