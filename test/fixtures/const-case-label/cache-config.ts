class InMemoryCache {
  constructor(_config: unknown) {}
}

const CARD_TYPENAME = "Card";

export const cache = new InMemoryCache({
  dataIdFromObject: (obj: { __typename?: string; front?: string; back?: string }) => {
    switch (obj.__typename) {
      case CARD_TYPENAME:
        return `Card:${obj.front}:${obj.back}`;
      default:
        return undefined;
    }
  },
});
