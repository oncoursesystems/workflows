# expo-eas-build 

The `expo-eas-build` action is located at [.github/workflows/expo-eas-build.yml](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-build.yml).

This workflow will use the EAS CLI build command to queue a new build for the given platform and profile.  This action assumes any platform-specific configuration is setup in the `eas.json`

This depends on the following actions:
- [expo-github-action](https://github.com/marketplace/actions/expo-github-action)

## Inputs

### `platform`

**Optional** An optional platform to target for the build

**Default** `all`

### `profile`

**Optional** An optional profile to use for the build

**Default** `production`

### `submit`

**Optional** An optional flag which will auto-submit the build when finished

**Default** `false`

### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

## Usage

```yaml
# TODO
```