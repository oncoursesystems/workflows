# docker-cleanup

The `docker-cleanup` workflow is located at [.github/workflows/docker-cleanup.yml](/oncoursesystems/workflows/tree/main/.github/workflows/docker-cleanup.yml).

This workflow handles cleanup of untagged Docker images from the GitHub Container Registry. It's useful for maintaining repository storage limits by removing old, untagged container images.

This depends on the following actions:
- [actions/delete-package-versions](https://github.com/marketplace/actions/delete-package-versions)

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `self-hosted`

### `package-name`

**Optional** The name of the package to cleanup

**Default** `${{ github.repository }}`

## Usage

```yaml
name: Cleanup Docker Images

on:
  schedule:
    - cron: '0 0 * * 0'  # Run weekly on Sundays

jobs:
  cleanup:
    uses: oncoursesystems/workflows/.github/workflows/docker-cleanup.yml@main
    with:
      package-name: myorg/mypackage
```

This will:
1. Delete all untagged versions of the specified package from the GitHub Container Registry
2. Help maintain repository storage limits by removing old, unused images
