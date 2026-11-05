# storybook-diff

[![CI](https://github.com/hayashikun/storybook-diff/actions/workflows/ci.yml/badge.svg)](https://github.com/hayashikun/storybook-diff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

English | [日本語](./README.ja.md)

Visual diffs of your Storybook stories, per pull request. It's a GitHub Action and a CLI. You give it two `storybook build` outputs (base and head). It renders each story in Chromium, compares them, and produces:

- `index.html`: a gallery of the stories that changed. You can view base and head side by side, with a slider, or with the differing pixels highlighted. Each story has a "reviewed" checkbox and there are keyboard shortcuts.
- `summary.md`: a summary for a PR comment. It is trimmed automatically to stay under GitHub's 65,536-character comment limit.
- `result.json`: the same result in machine-readable form.
- `shots/`: screenshots of the stories that changed.

The gallery and the summary are currently in Japanese.

## How it detects changes

1. **Scope.** It reads the changed-file list and the dependency graph that Storybook writes with `--stats-json` (`preview-stats.json`, the same one turbosnap uses). Only stories that import a changed file, directly or through other modules, are rendered.
2. **HTML, then pixels.** Each story in scope is rendered in base and head and the DOM is compared. Only stories whose HTML differs are screenshotted and compared pixel by pixel. This way, DOM differences that don't show (such as React `useId` values) are dropped cheaply. Within one story file, stories are switched on an already-loaded `iframe.html` instead of reloading it. The page is reloaded when the story file changes.
3. **Confirm.** Stories with a pixel difference in step 2 are reloaded from scratch and shot again. This removes differences caused by state carried over from the previous story. Stories with no difference in step 2 are not re-checked, so carried-over state that covers the story the same way in base and head can hide a real change. Use `reuse-page: false` if that matters for your Storybook.

Added and removed stories are always detected, regardless of scope.

## Use as a GitHub Action

Building Storybook and hosting the report (S3 or elsewhere) are up to your workflow. This action only turns two built Storybooks into a diff report.

```yaml
# Build Storybook for both head and base
- name: Build storybook (head)
  run: pnpm run build-storybook --output-dir /tmp/sb-head --stats-json

- name: Build storybook (base)
  run: |
    git worktree add /tmp/sb-base-tree ${{ github.event.pull_request.base.sha }}
    pnpm --dir /tmp/sb-base-tree install --frozen-lockfile
    pnpm --dir /tmp/sb-base-tree run build-storybook --output-dir /tmp/sb-base

- name: Collect changed files
  run: git diff --name-only ${{ github.event.pull_request.base.sha }}...HEAD > /tmp/sb-changed.txt

- name: Generate story diff
  uses: hayashikun/storybook-diff@<SHA> # v1.0.0
  with:
    base-static: /tmp/sb-base
    head-static: /tmp/sb-head
    changed-files: /tmp/sb-changed.txt
    out: /tmp/sb-report
    pr-title: ${{ github.event.pull_request.title }}
    pr-url: ${{ github.event.pull_request.html_url }}
```

Then upload `/tmp/sb-report` and post `summary.md` as a PR comment. For example:

```yaml
- name: Upload report
  run: |
    # Put the Storybooks next to the gallery so each story links to the real one
    cp -r /tmp/sb-base /tmp/sb-report/storybook-base
    cp -r /tmp/sb-head /tmp/sb-report/storybook-head
    aws s3 sync /tmp/sb-report "s3://<bucket>/pr-${{ github.event.pull_request.number }}/"

- name: Comment summary
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    {
      echo "[Open the diff gallery](https://<host>/pr-${{ github.event.pull_request.number }}/index.html)"
      echo
      cat /tmp/sb-report/summary.md
    } > /tmp/sb-comment.md
    gh pr comment ${{ github.event.pull_request.number }} --body-file /tmp/sb-comment.md
```

Each story in the gallery links to `./storybook-base/` and `./storybook-head/`. If you upload the two Storybooks under those names, as above, you can jump from a diff to the real story.

### Inputs

| name | default | description |
|---|---|---|
| `base-static` | (required) | base `storybook-static` directory |
| `head-static` | (required) | head `storybook-static` directory |
| `out` | (required) | output directory |
| `changed-files` | none | file listing changed paths, one per line. Without it, nothing is rendered and an empty report is written |
| `head-stats` | `<head-static>/preview-stats.json` | dependency graph. Without it, scope falls back to "any story in a changed package" |
| `concurrency` | `6` | number of stories rendered in parallel |
| `workspace-dir` | `packages` | monorepo workspace directory name (for example `apps`) |
| `global-paths` | `.storybook/` | comma-separated path prefixes. A change under any of them puts every story in scope |
| `dist-boundary-packages` | none | comma-separated prefixes of shared packages that apps import through their built `dist`. The dependency graph stops at that boundary, so any change in them other than stories and tests puts every story in scope |
| `reuse-page` | `true` | `'false'` reloads `iframe.html` for every story. This is slower, but no state carries over between stories. Any other value means `true` |
| `pr-title` / `pr-url` | none | shown in the gallery header. `pr-url` is also the key that keeps "reviewed" checkboxes separate per PR. Without it, the gallery's URL path is used |
| `node-version` | `24` | Node.js used to run the tool (24 or later). `''` skips `setup-node` |
| `install-browser` | `true` | install Playwright Chromium. This is almost free when it is already cached |

### Pinning

Pin the action to a commit SHA rather than a tag. This guards against supply-chain attacks.

## Use as a CLI

```bash
node src/cli.ts \
  --base-static <base storybook-static dir> \
  --head-static <head storybook-static dir> \
  --out <output dir> \
  [--changed-files <file listing changed paths>] \
  [--head-stats <preview-stats.json>] \
  [--concurrency 6] \
  [--workspace-dir packages] \
  [--global-paths .storybook/] \
  [--dist-boundary-packages packages/a,packages/b] \
  [--reuse-page true] \
  [--pr-title <title>] \
  [--pr-url <url>]
```

It needs Node.js 24 or later, which runs the TypeScript directly with type stripping, and Playwright Chromium.

While rendering, it turns off addon-a11y's automatic axe run through URL globals. The results aren't used, and the run only costs CPU.

## Development

```bash
pnpm install
pnpm exec playwright install chromium  # for the integration test
pnpm test              # vitest (pipeline.test.ts renders in Chromium)
pnpm run typecheck     # tsc --noEmit
pnpm run check         # biome
pnpm run dev:gallery   # serve a gallery of dummy data with hot reload
```

### Source layout

| file | role |
|---|---|
| `src/cli.ts` | parses arguments and runs the tool (the action's entry point) |
| `src/pipeline.ts` | overall flow: scope, step 1, step 2, shots of added and removed stories, report |
| `src/scope.ts` | decides which stories to render from the changed files and the dependency graph |
| `src/workspace.ts` | normalizes monorepo paths and finds a path's package |
| `src/storybook.ts` | reads `index.json` |
| `src/render.ts` | page management, story switching, waiting for a render to finish, screenshots |
| `src/diff.ts` | HTML normalization and pixel comparison |
| `src/static-server.ts` | serves the Storybooks and the screenshots |
| `src/report/` | gallery (`gallery.ts`, `gallery.css`, `gallery-client.js`), summary, and `result.json` |

## Releasing

Tag releases with semantic versioning. Users then update the SHA and the version comment.

```bash
git tag v1.1.0
git push origin v1.1.0
```

## License

[MIT](./LICENSE)
