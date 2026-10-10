# Manual Claude subscription pilot

This change prepares two disabled-by-default workflows for **GuitarAlchemist/claude-plugins**. It does not install an App, create a secret, enable a variable, or invoke Claude. There is no API-key fallback.

- `claude-review.yml`: a repository writer selects an open same-repository PR and its exact HEAD. A bounded diff is read through GitHub's immutable base-SHA/head-SHA comparison API, never checked out. The comparison response must match both SHAs; its merge base is recorded. Claude returns one structured report without tools. A separate job rechecks HEAD, comparison base, and writer access, then submits **COMMENT**, containing SHA, TLDR, verdict, and an evidence checklist. It never approves or merges.
- `claude-implement.yml`: a writer selects an open issue authored by a human writer, current default-branch SHA, and one plugin. Claude proposes complete files as bounded JSON without tools. A separate job without the subscription secret applies restricted paths, validates and tests that plugin. A third job rechecks access, issue revision, base, artifact digest, and actual source digest, then creates an isolated branch and **draft PR**. Independent review remains a manual separate reviewer dispatch and human review.

The action's explicit `github_token: github.token` path is used. **No Claude GitHub App installation is required for this pilot.** The model jobs have read-only repository permissions; only the review-comment job has PR write, and only the draft-publishing job has contents/PR write. There is no OIDC grant, personal access token, automatic issue/comment trigger, fork trigger, or `pull_request_target`.

## Activation requires separate approval

Before any persistent access is configured, approve exactly this scope:

1. Land these reviewed workflow files in the default branch of **GuitarAlchemist/claude-plugins**. This local preparation has not pushed or opened a PR.
2. Manually obtain a Claude Code subscription OAuth token through the official `claude setup-token` flow and enter it directly into that repository's masked Actions secret named **CLAUDE_CODE_OAUTH_TOKEN**. Do not paste it into chat, files, logs, or workflow inputs. No token has been read, generated, or transmitted during preparation. Subscription eligibility and organization policy must be checked at activation; no paid API credential is substituted.
3. Set only the desired repository variable: **CLAUDE_REVIEW_ENABLED=true** and/or **CLAUDE_IMPLEMENT_ENABLED=true**. Missing/false leaves the respective workflow disabled. GitHub repository policy must permit Actions to create PRs for the implementation pilot; this setting has not been changed.
4. Dispatch on the **default branch only**, supply the current exact lowercase SHA, and select a small trusted issue/plugin. A changed target or revoked writer access fails closed. No actor allowlist bypass is used. The collaborator-permission lookup must succeed with the repository policy; there is no fallback if access is denied.

The App path remains an alternative requiring its own explicit approval and permission review; this pilot intentionally does not request it. A subscription token is persistent access and consumes the existing subscription allowance. The prepared files alone grant no access.

## Bounds and evidence

One model turn per manual dispatch; ten-minute model-job timeout. Review accepts at most 40 files, rejects missing/truncated patches, and caps context at 80 KB. Implementation caps context at 24 input files / 80 KB, and output at eight files / 80 KB. It permits selected-plugin `.ts`, `.tsx`, and `.md` files, plus a **version-only** update of its existing plugin manifest. Paths with traversal, hidden settings/hooks, symlinks, dependency manifests, other plugins, and workflows are refused. The trusted writer updates only that plugin's matching marketplace version. No deletes or dependencies are supported.

Candidate plugin tests run on a fresh GitHub-hosted runner in a separate job without the Claude secret, with read-only checkout, persisted Git credentials disabled, and token environment removed from test subprocesses. Tests cannot modify the proposal artifacts without failing the job. A bounded digest covers tracked files, non-ignored additions, proposed files, and executable modes before and after each candidate command. A fresh publishing checkout must reproduce this digest before any GitHub write. Ignored runtime outputs and `.pilot` artifacts are outside the source digest. This checks the source at command boundaries; it does not prove what malicious code did during execution. This is separation from model credentials, not a general sandbox or proof that candidate tests are trustworthy. Generated code still requires independent review.

Artifacts contain only target metadata and structured reports/proposals, not the full repository or model transcript; retention is one day. Structured reports and draft PRs are visible to the repository's existing audience. Full model output and model summary publishing are disabled. No local credential or plugin installation is modified.

The draft records its tested proposal and source digests, immutable base and selected plugin. Legacy receipts without a source attestation are refused. A default-branch check immediately precedes ref creation; GitHub does not offer an atomic compare-and-create fence against that unrelated branch. A concurrent base change therefore still requires independent review/rebase. An error after ref creation may leave a recoverable branch; retries never force-push or replace it.

PRs created using `GITHUB_TOKEN` do not trigger normal `pull_request` workflows. The pilot runs selected-plugin validation/tests before drafting, but does **not** claim the existing marketplace CI ran. A human can reopen the draft to emit a normal PR event and must check required CI and independent review before any merge. There is no automatic merge or deployment.

## Local verification

`python scripts/test_claude_pilot.py` exercises writer/actor checks, immutable targets, stale heads, path escapes, bounds, symlink refusals, canonical version mapping, immutable diff races, test-time source mutations, publishing mismatches, workflow pins, permissions, and secret separation. Workflow inspection uses PyYAML only for local tests; the runtime policy is Python standard library. A real Windows symlink test may skip when symlink creation is unavailable; a separate simulated filesystem refusal test still runs. No actual GitHub workflow or subscription call has been executed yet.

Sources checked 2026-10-10: [official GitHub Actions guide](https://code.claude.com/docs/en/github-actions), [pinned action inputs](https://github.com/anthropics/claude-code-action/blob/1d6de8cb0c237e7c15e9e1bdf973826ebae490cc/action.yml), [agent mode](https://github.com/anthropics/claude-code-action/blob/1d6de8cb0c237e7c15e9e1bdf973826ebae490cc/src/modes/agent/index.ts), and [MCP preparation](https://github.com/anthropics/claude-code-action/blob/1d6de8cb0c237e7c15e9e1bdf973826ebae490cc/src/mcp/install-mcp-server.ts). Checkout, artifact actions, and Claude action are pinned to verified commit SHAs.

The immutable comparison API accepts commit SHAs and returns at most 300 changed files; this pilot's 40-file limit rejects that ceiling rather than accepting a partial review. See [GitHub compare documentation](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
