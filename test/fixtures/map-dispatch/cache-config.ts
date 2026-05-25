class InMemoryCache {
  constructor(_config: unknown) {}
}

const KEY_BY_TYPENAME = new Map([
  ["Card", "slug"],
  ["CollectionThumbnail", "collectionKey"],
]);

export const cache = new InMemoryCache({
  dataIdFromObject: (obj: { __typename?: string }) => {
    const keyField = KEY_BY_TYPENAME.get(obj.__typename ?? "");
    if (keyField) return `${obj.__typename}:${(obj as any)[keyField]}`;
    return undefined;
  },
});
