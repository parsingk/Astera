# The Astera plugin registry

How a plugin catalog for Astera is laid out, signed, reviewed and revoked. Astera can read a catalog from any address a
person sets (`astera plugins catalog-configure`); this guide is for whoever runs one. **No public Astera catalog is
operated yet**: none ships with the app, and none will until a security review approves one. Everything below can be
run as a private or team catalog today, on disk or on any static https host.

## Why a static registry

A catalog is a few static files: an index, its signature, and the packages. There is no server, account, payment or
download counter. A public GitHub repository can hold it, its pull requests are the submissions, and any static host
(GitHub Pages, Cloudflare Pages, a release) can serve it, at no running cost within those services' free terms. The
cost that remains is people: reviewing submissions and watching for compromised packages.

## Layout

```text
index.json            the index (below)
index.json.sig        its signature: keyId:base64
artifacts/            the packages, each as `astera plugins pack` made it
```

`artifactUrl` may be an https address or a path beside the index (`artifacts/x-1.0.0.tgz`), resolved against the
index's own address; a path never leaves the index's folder.

## The index

```json
{
  "schemaVersion": 1,
  "sequence": 12,
  "expires": "2027-06-01T00:00:00Z",
  "plugins": [
    {
      "id": "astera-hello-panel",
      "publisher": "example",
      "name": "Hello panel",
      "category": "development",
      "trustLevel": "restricted-ui",
      "license": "Apache-2.0",
      "sourceUrl": "https://example.invalid/hello",
      "issuesUrl": "https://example.invalid/hello/issues",
      "versions": [
        {
          "version": "0.1.0",
          "asteraRange": ">=1.6.0",
          "artifactUrl": "artifacts/astera-hello-panel-0.1.0.tgz",
          "sha256": "<the package's sha256>",
          "sizeBytes": 2048,
          "permissions": ["commands.register", "panels.register", "workspace.read"],
          "releaseNotes": "First release"
        }
      ]
    }
  ],
  "revoked": [{ "id": "astera-bad", "version": "*", "reason": "published from a stolen account" }]
}
```

- `schemaVersion` is 1. `sequence` grows by one with every published index; Astera never takes an older number back,
  nor another index with the same number. `expires` is when the index stops being good to install from: an expired
  index is shown with a warning and installs nothing, so publish a fresh one before then.
- `id` is the package name, `publisher` lower-case letters, digits and `-`, `category` one of development, agents,
  devops, themes, quality.
- `trustLevel` is the level the package's manifest gives: `trusted` (a host program, native code with the person's
  rights), `restricted-ui` (pages only) or `declarative` (themes only). Astera refuses a package whose manifest says
  otherwise.
- Each version is exact: `artifactUrl`, `sha256` and `sizeBytes` of the package bytes, `asteraRange` (comparators such
  as `>=1.6.0 <2.0.0`), and `permissions`, the most the package may ask for. Astera refuses a package that asks for one
  not listed.
- `revoked` names a version, or `*` for all, with a reason. A revoked version is never offered; one installed from the
  catalog is turned off when a verified index names it, cannot be turned on, and is not deleted.

`astera plugins publish --path <folder> --artifact-url <url> --publisher <name>` packs a plugin and prints its entry.
`astera plugins registry-validate --path index.json` checks the index as Astera reads it, and every package beside it
against its sha256 and size.

## Signing and keys

The signature is Ed25519 over the index file's exact bytes, written `keyId:base64` in `index.json.sig`. It is the
registry maintainers' signature: it says the maintainers published this index, not that a publisher signed a package.
A package is trusted for its sha256 in a signed index, never for where it was downloaded from.

- `astera plugins registry-keygen --out <folder> --key-id <id>` writes a private key and prints its public half.
- `astera plugins registry-sign --path index.json --key-file <pem> --key-id <id>` writes `index.json.sig`. Sign last:
  any byte changed after signing makes Astera refuse the index.
- People set the catalog with the public keys: `astera plugins catalog-configure --url <index> --key main=<publicKey>`.

**Rotation:** publish the new public key beside the old one (people set both, `--key old=…,new=…`), sign with the new
key, and drop the old one from the instructions once people have moved. **Compromise:** stop signing with the key, sign
an index with the next key that revokes what the compromised key published, and tell people to set the catalog again
without the old key; Astera stops trusting a kept index the moment its key is removed.

## Review

Automatic checks never make a package safe. A maintainer reads every first submission and every version that asks
for a new permission or another trust level, and looks harder at `trusted` plugins, which run native code with the
person's rights. Packages are installed without running any install script.

## CI and trust boundaries

- **Validation** runs on every pull request with no secret and read-only permissions: it runs
  `astera plugins registry-validate` and nothing from the pull request with privileges.
- **Signing** is a separate workflow a maintainer starts by hand on the main branch, with the signing key as its only
  secret; it signs the merged index with `astera plugins registry-sign` and commits the signature.

[examples/plugin-registry](../examples/plugin-registry) is a skeleton of such a repository: the layout, the two
workflows, and the submission templates. It is not operated.

## Submitting a plugin

1. Make the package with `astera plugins publish`, and serve it at its `artifactUrl` (a release, or `artifacts/` in a
   pull request).
2. Open a pull request adding the entry, or the new version, to `index.json`, with the submission template filled in.
3. A maintainer reviews it, merges it, raises `sequence`, and signs.
