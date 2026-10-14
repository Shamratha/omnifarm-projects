# Isolation Audit Workbench

Standalone local prototype for auditing a deterministic Qubes-style compartment fixture. It is a visual analysis tool, **not a Qubes replacement** and does not connect to a hypervisor or inspect the host.

## Run it

Open `index.html` directly in a browser. No install, server, backend, or network access is required. The optional local server command below is useful when testing browser behavior:

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

The default baseline scenario can be changed from the scenario picker. The workbench includes deep inheritance and deliberately broken-reference scenarios, filters, synchronized graph/table selection, a finding explanation panel, and JSON/CSV exports.

## Model scope

The pure model in `src/audit-model.js` supports:

- transitive template chains with field provenance;
- missing-template, missing-NetVM, and cycle diagnostics;
- deterministic NetVM path resolution;
- ordered first-match firewall rules with allow/deny defaults;
- IPv4/IPv6 CIDRs, protocols, ports and port ranges;
- disabled rules, explicit policy inheritance (`replace` / `append`), and evaluation traces.

The fixture data is intentionally explicit and immutable. The model does not claim to implement all Qubes policy or Xen behavior.

## Checks

```sh
npm test
```

The tests cover transitive template overrides, template cycles and missing references, firewall precedence and defaults, disabled rules, port ranges, IPv6 matching, and graph/violation analysis.

## Handoff: bounded isolation verification

**Goal and scope:** Confirm transitive template/firewall behavior and one regression without expanding this local prototype. No application code or dependencies changed in this final pass; the existing regression was confirmed rather than duplicated.

**Verified regression:** `tests/inheritance-path.test.js`, case `blocked-path fixture reports a first-AppVM local allow, path deny, and allowed path`, proves:

- `work → work-template → fedora-base` resolves through two template hops.
- The source-only HTTPS allow retains rule `root-https`, source `fedora-base`, and depth `2`.
- The end-to-end request is denied at `sys-firewall` by `deny-https-destination`; `sys-net` is not reached.
- A separate request permitted by every hop remains allowed.

**Relevant implementation:** `src/audit-model.js` resolves inheritance and evaluates paths; `src/fixtures.js` bundles the `blocked-path` scenario; `src/audit-view.js` projects UI/export state; `src/app.js` renders it. These were already present before this bounded pass.

**Decisions:** Templates inherit configuration/firewall policy, not network routes. Path samples evaluate the source and each NetVM; an ancestor or upstream allow cannot override an intermediate deny. Transit providers without a policy use a stated fixture pass-through assumption. This simulates fixtures, not real Qubes firewall semantics.

### Latest checks

All commands ran from the repository root:

| Check | Command | Result |
| --- | --- | --- |
| Focused regression | `node --test --test-name-pattern="blocked-path fixture" tests/inheritance-path.test.js` | Passed: 1 test, 0 failed |
| Full existing suite | `npm test` | Passed: 27 tests, 0 failed, 0 skipped |
| JavaScript syntax | `node --check src/audit-model.js && node --check src/fixtures.js && node --check src/audit-view.js && node --check src/app.js` | Passed |
| Tracked diff whitespace | `git diff --check` | Passed; no tracked implementation baseline exists |
| Lint / typecheck / build | Not configured in `package.json` | Not run; plain static JavaScript application |
| Browser interaction / downloaded JSON parity | Not run in this pass | Remaining verification gap; current Node tests cover the model, not browser rendering or export interaction |

**Git state:** Branch `master`, no commits; project files remain untracked. No staging, commits, pushes, or destructive cleanup performed. Test results describe the current working tree, not a committed revision.

**Next action:** Open `index.html`, choose **Blocked path / inherited allow**, select `work`, and switch between the two HTTPS samples. Check depth-2 inheritance, the blocked intermediate hop, and the permitted path. Export JSON and compare its `view.detail`, `view.graph`, and `view.inventory` against the selection and active filters before declaring the broader UI/export refinement fully verified. No dev server was started in this pass.
