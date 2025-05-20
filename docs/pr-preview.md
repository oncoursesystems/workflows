# pr-preview

The `pr-preview` workflow is located at [.github/workflows/pr-preview.yml](/oncoursesystems/workflows/tree/main/.github/workflows/pr-preview.yml).

This workflow creates and manages preview environments for pull requests. It builds a Docker image, deploys it to a Kubernetes cluster using Helm, and manages preview URLs for multiple environments (devel, staging, preview). The workflow also handles cleanup when pull requests are closed.

This depends on the following actions:
- [peter-evans/find-comment](https://github.com/marketplace/actions/find-comment)
- [peter-evans/create-or-update-comment](https://github.com/marketplace/actions/create-or-update-comment)
- [wahyd4/kubectl-helm-action](https://github.com/marketplace/actions/kubectl-helm-action)
- [chipkent/action-cleanup-package](https://github.com/marketplace/actions/cleanup-package)
- [actions/checkout](https://github.com/marketplace/actions/checkout)

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `self-hosted`

### `base-url`

**Required** Base URL for the preview environment (https://pr-<pr_number>.<env>.<base-url>)

### `namespace`

**Optional** Kubernetes namespace where the preview image will be deployed

**Default** `pr-preview`

### `environments`

**Optional** List of environments to deploy to (devel, staging, preview), format must be an array of strings

**Default** `"['devel', 'staging', 'preview']"`
### `env-values-path`

**Required** Path to the directory containing the environment yaml files to apply custom values to the Helm chart

### `chart-repository`

**Optional** URL of the Helm chart repository

**Default** `https://bjw-s.github.io/helm-charts`

### `chart-name`

**Optional** Name of the Helm chart to deploy

**Default** `app-template`

### `chart-version`

**Optional** Version of the Helm chart to deploy

**Default** `3.0.4`

### `delete_image_on_close`

**Optional** Whether to delete the Docker image from registry when the PR is closed or merged

**Default** `true`

## Secrets

### `KUBE_CONFIG`

**Required** Base64 encoded Kubeconfig data for the target Kubernetes cluster

## Usage

```yaml
name: Pull Request Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  preview:
    uses: oncoursesystems/workflows/.github/workflows/pr-preview.yml@main
    with:
      base-url: mydomain.com
      env-values-path: ./k8s/values/
    secrets:
      KUBE_CONFIG: ${{ secrets.KUBE_CONFIG }}
```

This will:
1. Create a comment on the PR with deployment status
2. Build a Docker image for the PR
3. Deploy the image to Kubernetes using Helm in three environments (devel, staging, preview)
4. Update the PR comment with preview URLs
5. Clean up the deployment and optionally the Docker image when the PR is closed
