# expo-eas-submit

The `expo-eas-submit` action is located at [.github/workflows/expo-eas-submit.yml](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-submit.yml).

This workflow will use the EAS CLI submit command to submit the latest application build to the given platform app store.  This action assumes any platform-specific configuration is setup in the `eas.json`.

This depends on the following actions:
- [expo-github-action](https://github.com/marketplace/actions/expo-github-action)

## Inputs

### `platform`

**Optional** An optional platform to target for the submission

**Default** `all`

### `profile`

**Optional** An optional profile to use for the submission

**Default** `production`

### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

## Usage

```yaml
# TODO
```