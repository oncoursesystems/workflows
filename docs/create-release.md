# create-release

The `create-release` workflow is located at [.github/workflows/create-release.yml](/oncoursesystems/workflows/tree/main/.github/workflows/create-release.yml).

This workflow automates the creation of GitHub releases. It generates a version number based on the current date and time if not specified, and creates a release with automatically generated release notes.

This depends on the following actions:
- [actions/checkout](https://github.com/marketplace/actions/checkout)
- [softprops/action-gh-release](https://github.com/marketplace/actions/gh-release)

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `self-hosted`

### `version`

**Optional** Use to override the default generated version. If not provided, a version number will be generated in the format YYYY.MM.DD.HHMM

### `token`

**Optional** Access token used when creating the release. Using GITHUB_TOKEN will not fire any additional workflows like on:release:published

## Usage

```yaml
name: Create Release

on:
  workflow_dispatch:  # Manually trigger the workflow
  push:
    branches:
      - main        # Or any branch you want to create releases from

jobs:
  release:
    uses: oncoursesystems/workflows/.github/workflows/create-release.yml@main
    with:
      version: 1.2.3  # Optional: specify a custom version
    secrets:
      CREATE_RELEASE_PAT: ${{ secrets.CREATE_RELEASE_PAT }}  # GitHub PAT with repo permissions
```

This will:
1. Generate a version number based on the current date/time (if not specified)
2. Create a new GitHub release with the generated version
3. Automatically generate release notes based on commits
4. Tag the release and mark it as the latest release
