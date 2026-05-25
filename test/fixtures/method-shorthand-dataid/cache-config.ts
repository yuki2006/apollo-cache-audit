class InMemoryCache {
  constructor(_config: unknown) {}
}

declare function defaultDataIdFromObject(obj: unknown): string | undefined;

export const cache = new InMemoryCache({
  // Method shorthand — semantically equivalent to `dataIdFromObject: (o) => {...}`.
  dataIdFromObject(o: { __typename?: string; front?: { __ref?: string }; back?: { __ref?: string } }) {
    switch (o.__typename) {
      case "Card":
        return `Card:${o.front?.__ref ?? o.back?.__ref}`;
      default:
        return defaultDataIdFromObject(o);
    }
  },
});
