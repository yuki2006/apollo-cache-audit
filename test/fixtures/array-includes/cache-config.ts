class InMemoryCache {
  constructor(_config: unknown) {}
}

const ENTITY_TYPES = ["LegacyItem", "OtherLegacyType"];

export const cache = new InMemoryCache({
  dataIdFromObject: (obj: { __typename?: string; legacyId?: string }) => {
    if (ENTITY_TYPES.includes(obj.__typename ?? "")) {
      return `${obj.__typename}:${obj.legacyId}`;
    }
    return undefined;
  },
});
