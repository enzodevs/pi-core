# Sources and design lineage

The skill uses original wording and implementation while synthesizing these public design ideas:

- OpenAI, **A Practical Approach to Verifying Code at Scale**: high precision over noisy recall, repository-wide tools and execution, verification-generation cost gap, and human trust as a deployment constraint. https://alignment.openai.com/scaling-code-verification/
- OpenAI, **Codex code review in GitHub**: consequential repository-specific rules in scoped `AGENTS.md` files, serious-issue focus, and deterministic checks remaining in CI. https://developers.openai.com/codex/integrations/github
- OpenAI, **Codex Security**: separate threat/contract modeling, discovery, validation, impact analysis, coverage accounting, explicit proof gaps, and evidence-calibrated confidence. https://github.com/openai/codex-security
- Alibaba, **Open Code Review**: deterministic file selection, related-file bundling, fine-grained rule matching, isolated review contexts, comment reflection/deduplication, precise anchoring, and precision-oriented evaluation. https://github.com/alibaba/open-code-review

These projects are references, not runtime dependencies. The helper scripts do not send source code to either project or require external services.

