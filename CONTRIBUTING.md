---
docType: guide
scope: repo
status: current
authoritative: true
owner: cli
language: en
whenToUse: "When reporting bugs or requesting capabilities in cli."
whenToUpdate: "When reporting forms, feedback entrypoints, or the shared reporting contract change."
checkPaths:
  - CONTRIBUTING.md
  - .github/ISSUE_TEMPLATE/**
  - README.md
lastReviewedAt: 2026-09-02
lastReviewedCommit: 4472738acc78eab396fb1f4c7f5e76af9ac703be
---

# Contributing Feedback / 提交反馈

Chinese and English reports are welcome. Start with the
[Bug report](https://github.com/tiangong-ai/cli-toolkit/issues/new?template=bug_report.yml)
or [Feature request](https://github.com/tiangong-ai/cli-toolkit/issues/new?template=feature_request.yml).
These implement the shared [reporting contract v1](https://github.com/tiangong-ai/workspace-suite/blob/main/_docs/contracts/issue-reporting-policy.md).
本仓库与另一个项目使用同一套核心字段；可以用中文或英文填写。

## Where To Report / 提交到哪里

- Skill instructions, prompt orchestration, references, and agent routing:
  [Skills](https://github.com/tiangong-ai/agent-skills/issues/new/choose).
- Commands, setup/install failures, runtime errors, locks, and package issues:
  [CLI](https://github.com/tiangong-ai/cli-toolkit/issues/new/choose).
- Uncertain or cross-component problems: use CLI and select `Unsure / 不确定`
  when the component is unknown. Maintainers handle transfers or linked tasks.
  无法判断归属时提交到 CLI；不需要在两个仓库重复提交。

## Useful Reports / 填写原则

Search existing issues first. Report one problem or capability at a time.
Describe what you wanted to do, what you expected, and what actually happened.
A root-cause diagnosis or implementation plan is optional. Unknown versions and
unreproducible failures are accepted: explain what is known and what is missing.
先查重复，聚焦一个问题；无需先找出根因，无法复现也可提交已有证据。

For bugs, fill Summary, Goal, Component, Versions, Environment, Stage,
Reproduction, Expected result, and Actual result. Evidence is optional. Include
the actual CLI and Skill versions used by the failing run, native host/model,
OS, and installation method when known. A managed workspace's locked CLI can
differ from `tiangong-ai --version` in a global shell; use existing run records
or read-only lock inspection and label the source. Do not update the workspace
just to obtain a version. 填写出错时使用的实际版本，不要用升级后的版本替代。

For features, fill Summary, Component, Use case, Current limitation, Proposed
capability, and Success criteria; Alternatives is optional. No fault logs are
required. 功能建议说明场景、障碍、期望能力和成功示例即可。

Share only minimal sanitized logs, commands, or prompt excerpts. Remove keys,
tokens, authorization headers, private paths, private research data, and
unrelated conversation text. Do not attach an entire research directory or
environment dump. Optional audit exports require review before sharing; do not
run paid provider/model checks or repeat research solely to file an issue.
仅提供最少量脱敏证据，不要上传密钥、整个工作区或完整私有对话。

## Agent-Assisted Reports / 让 Agent 协助

Ask the installed Auto Research Skill to prepare an issue report. It carries a
local reporting reference and Markdown templates; a workspace source checkout
is unnecessary. Preserve the same English section labels as the form while
writing the content in either language. State `Unknown` or `Not applicable`
with a reason instead of inventing details. An agent may draft locally; it posts
or uploads only with user authorization, including authorization already given
in the session. 可以先生成草稿；实际提交遵循用户已给出的授权。

## Maintainer Handoff / 维护者接手

Maintainers preserve the original report, verify component ownership, link
duplicates, and add development scope, TODOs, acceptance criteria, validation,
and integration requirements before starting implementation. Reporters do not
need Project access or knowledge of internal delivery rules.
维护者负责把反馈整理为可执行任务，不把内部交付要求转嫁给反馈者。
