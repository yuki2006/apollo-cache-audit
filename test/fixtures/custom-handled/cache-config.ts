class InMemoryCache {
  constructor(_config: unknown) {}
}

export const cache = new InMemoryCache({
  dataIdFromObject: (obj: { __typename?: string; slug?: string; id?: string }) => {
    switch (obj.__typename) {
      case "Organization":
        return obj.slug ? `Organization:${obj.slug}` : undefined;
      default:
        return obj.id ? `${obj.__typename}:${obj.id}` : undefined;
    }
  },
});
