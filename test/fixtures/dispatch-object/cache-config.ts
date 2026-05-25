class InMemoryCache {
  constructor(_config: unknown) {}
}

const KEY_BY_TYPENAME: Record<string, string> = {
  Organization: "slug",
  Workspace: "handle",
};

export const cache = new InMemoryCache({
  dataIdFromObject: (obj: { __typename?: string }) => {
    const keyField = KEY_BY_TYPENAME[obj.__typename ?? ""];
    if (keyField) return `${obj.__typename}:${(obj as any)[keyField]}`;
    return undefined;
  },
});
