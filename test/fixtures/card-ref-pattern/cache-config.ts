class InMemoryCache {
  constructor(_config: unknown) {}
}

interface ProbeObj {
  __typename?: string;
  front?: { __ref?: string };
  back?: { __ref?: string };
}

export const cache = new InMemoryCache({
  dataIdFromObject: (o: ProbeObj) => {
    switch (o.__typename) {
      case "Card":
        return `Card:${o.front?.__ref ?? o.back?.__ref}`;
      default:
        return undefined;
    }
  },
});
