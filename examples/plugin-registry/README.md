# Plugin registry skeleton

A starting point for an Astera plugin catalog repository: the layout, a validation workflow that runs on pull requests
with no secret, a signing workflow a maintainer starts by hand, and a submission template.
[docs/plugin-registry.md](../../docs/plugin-registry.md) says how the index is read, signed, reviewed and revoked.

**Not operated.** Nothing here is published, and no key is in it. Copy it into a repository of your own to run a
private or team catalog.

## Files

- `index.json`: the index, with no plugin yet. Raise `sequence` with every published change, and keep `expires` ahead.
- `artifacts/`: the packages, as `astera plugins publish` made them.
- `.github/workflows/validate.yml`: checks every pull request with `astera plugins registry-validate`.
- `.github/workflows/sign.yml`: signs the merged index with the key in the `REGISTRY_SIGNING_KEY` secret.
- `.github/ISSUE_TEMPLATE/plugin-submission.yml` and `.github/PULL_REQUEST_TEMPLATE.md`: what a submission states.

## Use it

```sh
astera plugins registry-keygen --out ~/registry-keys --key-id main     # keep the .pem off shared machines
astera plugins publish --path ../my-plugin --artifact-url artifacts/my-plugin-0.1.0.tgz --publisher me --out artifacts/my-plugin-0.1.0.tgz
# add the printed entry to index.json, raise sequence
astera plugins registry-validate --path index.json
astera plugins registry-sign --path index.json --key-file ~/registry-keys/main.pem --key-id main
astera plugins catalog-configure --url "$PWD/index.json" --key main=<public key from keygen>
astera plugins catalog --refresh
```
