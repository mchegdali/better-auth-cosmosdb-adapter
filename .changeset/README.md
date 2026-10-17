# Changesets

Every pull request that changes the published package adds a changeset:

```bash
pnpm changeset
```

Pick the bump (`patch` for fixes, `minor` for features, `major` for breaking changes) and describe
the change for users. On `main`, the release workflow turns pending changesets into a
"Version Packages" pull request; merging it publishes to npm.
