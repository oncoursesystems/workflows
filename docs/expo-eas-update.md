# expo-eas-update

The `expo-eas-update` action is located at [.github/workflows/expo-eas-update.yml](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-update.yml).

This workflow will use the EAS CLI update command to publish changes the given channel. This action assumes any platform-specific configuration is setup in the `eas.json`

This depends on the following actions:
- [expo-github-action](https://github.com/marketplace/actions/expo-github-action)

## Inputs

### `channel`

**Required** The channel to publish to

### `message`

**Optional** An optional message describing the update

**Default** ``

### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

## Usage

```yaml
# TODO
```