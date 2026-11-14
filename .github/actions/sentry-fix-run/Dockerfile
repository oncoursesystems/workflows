# The throwaway container the sentry-fix agent and the project commands run in. The bundled Claude binary needs
# glibc, so the base is the Debian-family .NET SDK image, never Alpine.
ARG DOTNET_SDK_VERSION=10.0
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION}

ARG NODE_VERSION=24

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

# A major version takes the latest release of that line. The checksum comes from the same release directory.
RUN set -eu; \
    case "$NODE_VERSION" in \
        *.*.*) dir="v$NODE_VERSION" ;; \
        *) dir="latest-v$NODE_VERSION.x" ;; \
    esac; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/$dir/SHASUMS256.txt"; \
    file="$(grep -oE 'node-v[0-9]+\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' SHASUMS256.txt | head -n 1)"; \
    curl -fsSLO "https://nodejs.org/dist/$dir/$file"; \
    grep " $file\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf "$file" -C /opt/node --strip-components=1; \
    rm "$file" SHASUMS256.txt

# The container runs as the runner's uid, which has no home in the image, so HOME is a directory anyone can write.
RUN mkdir -m 1777 /home/fixer

ENV PATH=/opt/node/bin:$PATH \
    HOME=/home/fixer \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
