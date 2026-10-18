# Origin and third-party notices

The provider is derived from the MIT-labelled `Diffuzmetall/bb-plugin-provider-pi-durable` 0.2.29 baseline. The external binding, observation, history and operator integration is extracted from the adapter project. Source comments and author notices are retained. The portable package excludes the operator's native global composition, grants, credentials, live stores and transcripts. Historical development sources and sanitized fixture evidence are separate from the portable package and are not runtime configuration.

The BB compatibility archive contains MIT-licensed BB 0.46.0 compatibility output and its runtime dependency closure. BB copyright: (c) 2026 Michael Yong; see `licenses/BB-LICENSE`. Upstream BB source: https://github.com/get-bb/bb. Dependency package names, versions and declared licenses are listed in `compat/manifest.json`; individual notices and licenses remain in the archive and in `licenses/upstream/`.

Pi SDK packages are installed from npm under their own MIT licenses. They are not a fork or patch of the Pi Durable Host. The native bridge imports the operator's already-admitted native owner instead of publishing or bundling it.

The compatibility archive is prebuilt output, not a claim that this repository contains the complete BB monorepo. It is checksum-verified, version/fingerprint gated, and staged into a separate application copy. Original BB application files and databases are never overwritten by the compatibility staging command.
