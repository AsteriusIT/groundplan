# Bundled catalog snapshot (GP-239)

This directory is copied into the API image, and the release pipeline drops a
`catalog-snapshot.json.gz` here before the image is built
(`.github/workflows/build-images.yml`). On the first boot of an empty catalog
the API imports it, so a fresh install — air-gapped or not — has the complete
visual builder immediately instead of a warming state it may never leave.

The file is **not** committed: it is tens of megabytes of provider schemas that
change with every provider release, and it is reproducible from the providers
themselves. A checkout therefore has no snapshot, which is a supported state:
the builder falls back to its curated resources and says so.

Build one by hand against a populated database:

    pnpm --filter @groundplan/backend catalog:snapshot --out deploy/catalog/catalog-snapshot.json.gz

Import one into an air-gapped instance:

    pnpm --filter @groundplan/backend catalog:snapshot --in catalog-snapshot.json.gz

Generation is deterministic: the same catalog produces the same bytes, so a
release artefact can be checksummed and two releases can be diffed.
