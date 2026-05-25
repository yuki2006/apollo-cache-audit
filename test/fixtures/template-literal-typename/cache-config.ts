class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cache = new InMemoryCache({
  dataIdFromObject: (obj: { __typename?: string; contentItemId?: string }) => {
    if (`${obj.__typename}` === "ItemCollectContentItem") {
      return `ItemCollectContentItem:${obj.contentItemId}`;
    }
    return undefined;
  },
});
