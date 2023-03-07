# expo-eas-clean

The `expo-eas-clean` action is located at [.github/workflows/expo-eas-clean.yml](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-clean.yml).

This workflow will use the EAS CLI to delete the branch and channel with the given name.  Typically used when a pull request is closed in order to delete the associated channel and branch.

This depends on the following actions:
- [expo-github-action](https://github.com/marketplace/actions/expo-github-action)

## Inputs

### `channel`

**Required** The channel/branch name to delete

### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

## Usage

```yaml
name: my-cleanup

on:
  pull_request:
    types: [closed]

jobs:
  clean:
    uses: oncoursesystems/reusable-workflows/.github/workflows/expo-eas-cleanup.yml@main
    with:
      channel: ${{ format('pr-{0}', github.event.number) }}
      runs-on: self-hosted
```