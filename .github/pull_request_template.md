## What and why

<!-- One or two sentences. Link the issue: "Fixes #123". -->

## Checklist

- [ ] One change; the PR targets the default branch
- [ ] A bug fix has a test that fails without it; new domain/DSL functions have a unit test beside them
- [ ] A UI change has a Playwright check and screenshots in light and dark
- [ ] `npm run verify` passes (paste the last lines below), or, with no display, the unit checks plus `npm run e2e:ci -- --grep @gate`
- [ ] No new dependency, or one line on why it is needed
- [ ] A change people will notice has one line under `[Unreleased]` in [CHANGELOG.md](https://github.com/openflowkit/openflowkit/blob/main/CHANGELOG.md)

```
<verify output>
```
