import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { CliError } from "../../errors.js";
import { EXTERNAL_SKILLS_CLI_VERSION } from "./external-skills.js";
import { sanitizeResearchText } from "./sanitization.js";
import { hashRegularTree, pathExists } from "./storage.js";

export type ResearchSetupScope = "project" | "global";
export type ResearchSetupAgent = "codex" | "claude-code";
export type ResearchSetupTier =
  | "orchestrator"
  | "baseline"
  | "enhanced"
  | "conditional"
  | "authoring";
export type ResearchSetupRole =
  | "orchestrator"
  | "evidence-capability"
  | "input-preprocessor"
  | "acquisition-adapter"
  | "post-closure-authoring";

export interface ResearchSetupSource {
  id: string;
  repository: string;
  locator: string;
  immutableRef: string;
  bundled: false;
  userInitiatedOnly: true;
}

export interface ResearchSetupLicense {
  id: string;
  label: string;
  url: string;
  notice: string;
  requiresExplicitAcceptance: true;
}

export interface ResearchSetupDependency {
  id: string;
  kind: "command" | "python-package" | "node-package" | "manual";
  requirement: string;
  requiredFor: string;
  automaticInstall: false;
  minimumAction: string;
}

export interface ResearchSetupSkill {
  id: string;
  skillName: string;
  sourceId: string;
  sourceRelativePath: string;
  expectedTreeSha256: string;
  tier: ResearchSetupTier;
  role: ResearchSetupRole;
  purpose: string;
  recommendedFor: string[];
  defaultSelected: boolean;
  credentialIds: string[];
  settingIds: string[];
  dependencies: ResearchSetupDependency[];
  license: ResearchSetupLicense;
  conflictGroup: string | null;
  capabilityKind:
    | "brave-public-internet"
    | "tiangong-sci"
    | "tiangong-report"
    | "tiangong-patent"
    | null;
  runtimeContract?: {
    mode: "workspace-lock";
    resolverRelativePath: string;
    exactCliVersionLiterals: "forbidden";
  };
  standaloneTestedCliVersion?: string;
  bundled: false;
  userInitiatedOnly: true;
}

export interface ResearchSetupCredential {
  id: string;
  provider: string;
  requiredBy: string[];
  required: boolean;
  defaultEnvironmentName: string;
  storage: "broker" | "adapter";
  adapterEnvironmentName: string | null;
  obtainAt: string;
  minimumUtf8Bytes: number;
  liveCheck: "capability" | "semantic-scholar" | "unstructure" | null;
}

export interface ResearchSetupSetting {
  id: string;
  label: string;
  requiredBy: string[];
  required: boolean;
  secret: false;
  defaultValue: string | null;
  validation: "https-url" | "email" | "identifier";
}

export const RESEARCH_SETUP_SELECTION_GUIDANCE = {
  pptCreation: {
    preferredSkillId: "hugohe3.ppt-master",
    situationalSkillIds: ["anthropic.pptx"],
    maySelectTogether: true,
    automaticSelection: false,
    guidance:
      "Prefer PPT Master for creating PPT presentations; use Anthropic PPTX when its workflow better fits the task. Both remain explicit post-closure choices.",
  },
} as const;

const BRAVE_COMMIT = "3e088af66eb61f1c207c22b2be0278ca8744d1d1";
const TIANGONG_SKILLS_COMMIT = "8d2076c932a5a3cd9880d3bcbc05eebf732352bd";
const ANTHROPIC_SKILLS_COMMIT = "f17010c9bb483898c1d9c9f42dde2b3a98889434";
const PPT_MASTER_COMMIT = "4343bd8bfc91e79dfb9680681a378476cc38a280";

export const RESEARCH_SETUP_INSTALLER = {
  package: "skills",
  version: EXTERNAL_SKILLS_CLI_VERSION,
  npmIntegrity:
    "sha512-cHiLjwZEawWFvudIqeeMZlvZayTLbRouydMbblyrdiyH7ZLbqUrSrEEr+Tg+X265iztRlVMsyOYRwpD5JxBsvg==",
  npmShasum: "ec0a7897ba2ef06e01f3b41007886f3a92cf4d05",
  gitHead: "a4d243c3d4f86cdf9385dd1b6a0733f6937e70b5",
  runtimeInstall: false,
} as const;

export const RESEARCH_SETUP_SOURCES: readonly ResearchSetupSource[] = [
  {
    id: "brave-search-skills",
    repository: "brave/brave-search-skills",
    locator: "https://github.com/brave/brave-search-skills.git",
    immutableRef: BRAVE_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong-ai-skills",
    repository: "tiangong-ai/skills",
    locator: "https://github.com/tiangong-ai/skills.git",
    immutableRef: TIANGONG_SKILLS_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "anthropic-skills",
    repository: "anthropics/skills",
    locator: "https://github.com/anthropics/skills.git",
    immutableRef: ANTHROPIC_SKILLS_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "ppt-master",
    repository: "hugohe3/ppt-master",
    locator: "https://github.com/hugohe3/ppt-master.git",
    immutableRef: PPT_MASTER_COMMIT,
    bundled: false,
    userInitiatedOnly: true,
  },
] as const;

const MIT_BRAVE: ResearchSetupLicense = {
  id: "brave-search-skills:MIT",
  label: "MIT",
  url: `https://github.com/brave/brave-search-skills/blob/${BRAVE_COMMIT}/LICENSE`,
  notice: "Brave Search Skills are separately sourced under the MIT license.",
  requiresExplicitAcceptance: true,
};

const MIT_TIANGONG: ResearchSetupLicense = {
  id: "tiangong-ai-skills:MIT",
  label: "MIT",
  url: `https://github.com/tiangong-ai/skills/blob/${TIANGONG_SKILLS_COMMIT}/LICENSE`,
  notice: "Tiangong Skills are separately sourced under the MIT license.",
  requiresExplicitAcceptance: true,
};

const ANTHROPIC_EXAMPLE: ResearchSetupLicense = {
  id: "anthropic-skills:doc-coauthoring:NOASSERTION",
  label: "NOASSERTION",
  url: `https://github.com/anthropics/skills/blob/${ANTHROPIC_SKILLS_COMMIT}/README.md`,
  notice:
    "The pinned doc-coauthoring tree has no per-Skill license file. The upstream README describes many examples as Apache-2.0, but this catalog does not infer a license; review the pinned source before choosing it.",
  requiresExplicitAcceptance: true,
};

const ANTHROPIC_DOCUMENT_TERMS: ResearchSetupLicense = {
  id: "anthropic-skills:document-terms",
  label: "Anthropic source-available document Skill terms",
  url: `https://github.com/anthropics/skills/blob/${ANTHROPIC_SKILLS_COMMIT}/skills/docx/LICENSE.txt`,
  notice:
    "The upstream document Skills are source-available, not open source, and contain additional restrictions. They are never bundled or selected automatically.",
  requiresExplicitAcceptance: true,
};

const MIT_PPT_MASTER: ResearchSetupLicense = {
  id: "ppt-master:MIT",
  label: "MIT",
  url: `https://github.com/hugohe3/ppt-master/blob/${PPT_MASTER_COMMIT}/skills/ppt-master/LICENSE`,
  notice: "PPT Master is separately sourced under the MIT license.",
  requiresExplicitAcceptance: true,
};

const PYTHON_310: ResearchSetupDependency = {
  id: "python-3.10",
  kind: "command",
  requirement: "python3 >= 3.10",
  requiredFor: "Python Skill scripts",
  automaticInstall: false,
  minimumAction: "Install a compatible Python runtime outside this CLI, then rerun setup doctor.",
};

const PYPDF_LOCK: ResearchSetupDependency = {
  id: "academic-paper-download:pypdf",
  kind: "python-package",
  requirement: "pypdf==6.14.2 from requirements.lock through the verified Skill runtime",
  requiredFor: "academic-paper-download locked execution and structural PDF validation",
  automaticInstall: false,
  minimumAction:
    "From the verified installed academic-paper-download Skill directory, run `python3 scripts/runtime.py bootstrap --locked --json`, review the result, then rerun setup doctor; do not install CloakBrowser unless that optional handoff is explicitly selected later.",
};

const AUTHORING_DEFUSEDXML: ResearchSetupDependency = {
  id: "authoring:defusedxml",
  kind: "python-package",
  requirement: "defusedxml==0.7.1",
  requiredFor: "DOCX and PPTX XML-safe validation helpers",
  automaticInstall: false,
  minimumAction:
    "Install `defusedxml==0.7.1` into the explicit Python environment used by the selected document Skills, then rerun setup doctor.",
};

const AUTHORING_LXML: ResearchSetupDependency = {
  id: "authoring:lxml",
  kind: "python-package",
  requirement: "lxml importable from the same authoring Python",
  requiredFor: "DOCX and PPTX schema validators",
  automaticInstall: false,
  minimumAction:
    "Install a reviewed lxml release into the explicit Python used for authoring, then rerun setup doctor.",
};

const AUTHORING_PILLOW: ResearchSetupDependency = {
  id: "authoring:pillow",
  kind: "python-package",
  requirement: "Pillow importable from the same authoring Python",
  requiredFor: "PPTX thumbnail and visual QA helpers",
  automaticInstall: false,
  minimumAction:
    "Install a reviewed Pillow release into the explicit Python used for authoring, then rerun setup doctor.",
};

const AUTHORING_PYTHON_PPTX: ResearchSetupDependency = {
  id: "authoring:python-pptx",
  kind: "python-package",
  requirement: "python-pptx importable from the same authoring Python",
  requiredFor: "MarkItDown PPTX support",
  automaticInstall: false,
  minimumAction:
    "Install markitdown with its pptx extra into the explicit Python used for authoring, then rerun setup doctor.",
};

const AUTHORING_MARKITDOWN: ResearchSetupDependency = {
  id: "authoring:markitdown",
  kind: "python-package",
  requirement: "markitdown==0.1.7 from the same authoring Python",
  requiredFor: "PPTX and XLSX content QA",
  automaticInstall: false,
  minimumAction:
    "Install markitdown==0.1.7 with the selected pptx/xlsx extras into the explicit authoring Python, then rerun setup doctor.",
};

const AUTHORING_NODE_DOCX: ResearchSetupDependency = {
  id: "authoring:node-docx",
  kind: "node-package",
  requirement: "Node docx module resolvable by the setup runtime",
  requiredFor: "DOCX creation",
  automaticInstall: false,
  minimumAction:
    "Make the reviewed docx Node module resolvable through the authoring Node/NODE_PATH, then rerun setup doctor.",
};

const AUTHORING_NODE_PPTXGENJS: ResearchSetupDependency = {
  id: "authoring:node-pptxgenjs",
  kind: "node-package",
  requirement: "Node pptxgenjs module resolvable by the setup runtime",
  requiredFor: "PPTX creation",
  automaticInstall: false,
  minimumAction:
    "Make the reviewed pptxgenjs Node module resolvable through the authoring Node/NODE_PATH, then rerun setup doctor.",
};

const AUTHORING_PANDOC: ResearchSetupDependency = {
  id: "authoring:pandoc",
  kind: "command",
  requirement: "pandoc executable",
  requiredFor: "DOCX text extraction",
  automaticInstall: false,
  minimumAction: "Install Pandoc outside this CLI, then rerun setup doctor.",
};

const AUTHORING_LIBREOFFICE: ResearchSetupDependency = {
  id: "authoring:libreoffice",
  kind: "command",
  requirement: "LibreOffice soffice executable",
  requiredFor: "DOCX/PPTX rendering and XLSX formula recalculation",
  automaticInstall: false,
  minimumAction:
    "Install LibreOffice outside this CLI and expose soffice on PATH, then rerun setup doctor.",
};

const AUTHORING_POPPLER: ResearchSetupDependency = {
  id: "authoring:poppler",
  kind: "command",
  requirement: "Poppler pdftoppm executable",
  requiredFor: "DOCX/PDF/PPTX visual QA",
  automaticInstall: false,
  minimumAction:
    "Install Poppler outside this CLI and expose pdftoppm on PATH, then rerun setup doctor.",
};

const AUTHORING_ZIP: ResearchSetupDependency = {
  id: "authoring:zip",
  kind: "command",
  requirement: "zip executable",
  requiredFor: "DOCX and PPTX exact OOXML repacking",
  automaticInstall: false,
  minimumAction: "Install a zip command outside this CLI, then rerun setup doctor.",
};

const AUTHORING_UNZIP: ResearchSetupDependency = {
  id: "authoring:unzip",
  kind: "command",
  requirement: "unzip executable",
  requiredFor: "DOCX and PPTX exact OOXML editing",
  automaticInstall: false,
  minimumAction: "Install an unzip command outside this CLI, then rerun setup doctor.",
};

const AUTHORING_PYPDF: ResearchSetupDependency = {
  id: "authoring:pypdf",
  kind: "python-package",
  requirement: "pypdf importable from the same authoring Python",
  requiredFor: "PDF structure and page validation",
  automaticInstall: false,
  minimumAction:
    "Install a reviewed pypdf release into the authoring Python, then rerun setup doctor.",
};

const AUTHORING_PDFPLUMBER: ResearchSetupDependency = {
  id: "authoring:pdfplumber",
  kind: "python-package",
  requirement: "pdfplumber importable from the same authoring Python",
  requiredFor: "PDF text and table extraction",
  automaticInstall: false,
  minimumAction:
    "Install a reviewed pdfplumber release into the authoring Python, then rerun setup doctor.",
};

const AUTHORING_REPORTLAB: ResearchSetupDependency = {
  id: "authoring:reportlab",
  kind: "python-package",
  requirement: "reportlab importable from the same authoring Python",
  requiredFor: "PDF creation canary",
  automaticInstall: false,
  minimumAction:
    "Install a reviewed reportlab release into the authoring Python, then rerun setup doctor.",
};

const AUTHORING_PDF2IMAGE: ResearchSetupDependency = {
  id: "authoring:pdf2image",
  kind: "python-package",
  requirement: "pdf2image importable from the same authoring Python",
  requiredFor: "PDF Skill image conversion helpers",
  automaticInstall: false,
  minimumAction:
    "Install a reviewed pdf2image release into the authoring Python, then rerun setup doctor.",
};

const AUTHORING_OPENPYXL: ResearchSetupDependency = {
  id: "authoring:openpyxl",
  kind: "python-package",
  requirement: "openpyxl importable from the same authoring Python",
  requiredFor: "XLSX creation and formula verification",
  automaticInstall: false,
  minimumAction:
    "Install a reviewed openpyxl release into the authoring Python, then rerun setup doctor.",
};

const AUTHORING_PANDAS: ResearchSetupDependency = {
  id: "authoring:pandas",
  kind: "python-package",
  requirement: "pandas importable from the same authoring Python",
  requiredFor: "XLSX bulk data workflows",
  automaticInstall: false,
  minimumAction:
    "Install a Python-version-compatible reviewed pandas release into the authoring Python, then rerun setup doctor.",
};

const PPT_MASTER_LOCK_REQUIRED: ResearchSetupDependency = {
  id: "ppt-master:python-lock",
  kind: "manual",
  requirement: "A user-reviewed exact Python lock derived from upstream requirements.txt",
  requiredFor: "PPT Master helper scripts",
  automaticInstall: false,
  minimumAction:
    "Review and pin the upstream >= constraints in an isolated environment before enabling PPT Master helpers; setup will not resolve or install floating Python dependencies.",
};

export const RESEARCH_SETUP_SKILLS: readonly ResearchSetupSkill[] = [
  {
    id: "tiangong.auto-research",
    skillName: "tiangong-auto-research",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "tiangong-auto-research",
    expectedTreeSha256: "18e261eb49318ad621327412a8e0093e993539072aefceaad9b9f8d9f7610428",
    tier: "orchestrator",
    role: "orchestrator",
    purpose:
      "Route ordinary research tasks into the reviewed Tiangong setup, preflight, execution, review, and closure workflow.",
    recommendedFor: ["smoke-test", "production-research", "workspace-orchestration"],
    defaultSelected: true,
    credentialIds: [],
    settingIds: [],
    dependencies: [],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: null,
    runtimeContract: {
      mode: "workspace-lock",
      resolverRelativePath: "scripts/research_cli.mjs",
      exactCliVersionLiterals: "forbidden",
    },
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.auto-research-workbuddy",
    skillName: "tiangong-auto-research-workbuddy",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "tiangong-auto-research-workbuddy",
    expectedTreeSha256: "e5be05338b95e4729e45eec27ed9089c59b073f928d4e5e4f3befec809e29482",
    tier: "conditional",
    role: "orchestrator",
    purpose:
      "Route WorkBuddy and CodeBuddy native producer tasks into the canonical orchestrator and explicit signed reviewer bridge.",
    recommendedFor: ["workbuddy", "codebuddy", "sandbox-bridge"],
    defaultSelected: false,
    credentialIds: [],
    settingIds: [],
    dependencies: [],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.web-search",
    skillName: "web-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/web-search",
    expectedTreeSha256: "0432f4eb084766046a2feeb146f0b3917850d138eb4182c23fc000a058fbe123",
    tier: "baseline",
    role: "evidence-capability",
    purpose: "Broad public-internet evidence discovery.",
    recommendedFor: ["production-research"],
    defaultSelected: true,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.news-search",
    skillName: "news-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/news-search",
    expectedTreeSha256: "80f8dcb7c78209cce5315e507f0aba21e3f654f42f6a414c177de644bcd07773",
    tier: "baseline",
    role: "evidence-capability",
    purpose: "Date-sensitive public news discovery.",
    recommendedFor: ["production-research"],
    defaultSelected: true,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.llm-context",
    skillName: "llm-context",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/llm-context",
    expectedTreeSha256: "5abba551d0498a80eba4e64207f483974f5a312cda5b263c1cc2b7f99d81c4a3",
    tier: "enhanced",
    role: "evidence-capability",
    purpose: "Plan-dependent bounded extracted web context.",
    recommendedFor: ["full-text-web-grounding"],
    defaultSelected: false,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.images-search",
    skillName: "images-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/images-search",
    expectedTreeSha256: "467a9afae0e959b482cb6b2236a57a327959b28985871f88c202dc70b10a7c84",
    tier: "conditional",
    role: "evidence-capability",
    purpose: "Image-source discovery when visual evidence is material.",
    recommendedFor: ["visual-evidence"],
    defaultSelected: false,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "brave.videos-search",
    skillName: "videos-search",
    sourceId: "brave-search-skills",
    sourceRelativePath: "skills/videos-search",
    expectedTreeSha256: "ff3a2e2291efc27f3f09847b7e0b20e77d229f6a44a1a64e562964c820eb9719",
    tier: "conditional",
    role: "evidence-capability",
    purpose: "Video-source discovery when audiovisual evidence is material.",
    recommendedFor: ["audiovisual-evidence"],
    defaultSelected: false,
    credentialIds: ["brave.search.api-key"],
    settingIds: [],
    dependencies: [],
    license: MIT_BRAVE,
    conflictGroup: null,
    capabilityKind: "brave-public-internet",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.kb-sci-search",
    skillName: "tiangong-kb-sci-search",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "tiangong-kb-sci-search",
    expectedTreeSha256: "7308e5d88e5dbae113da7e401b8ecaf4b8e798bfe52ad10b99d188b2bd408b30",
    tier: "enhanced",
    role: "evidence-capability",
    purpose: "Owner-authorized Tiangong SCI database discovery through a bounded JSON POST broker.",
    recommendedFor: ["academic-research", "owner-whitelisted-database"],
    defaultSelected: false,
    credentialIds: ["tiangong.sci.api-key"],
    settingIds: ["tiangong.sci.endpoint", "tiangong.sci.region"],
    dependencies: [],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: "tiangong-sci",
    standaloneTestedCliVersion: "0.0.30",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.kb-report-search",
    skillName: "tiangong-kb-report-search",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "tiangong-kb-report-search",
    expectedTreeSha256: "d7f9eba27d965260edbe2760dc28352514d87d660b7a9f20bd6f44035f68f600",
    tier: "enhanced",
    role: "evidence-capability",
    purpose:
      "Owner-authorized Tiangong report database discovery through a bounded JSON POST broker.",
    recommendedFor: ["industry-reports", "policy-reports", "whitepapers"],
    defaultSelected: false,
    credentialIds: ["tiangong.report.api-key"],
    settingIds: ["tiangong.report.endpoint", "tiangong.report.region"],
    dependencies: [],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: "tiangong-report",
    standaloneTestedCliVersion: "0.0.30",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.kb-patent-search",
    skillName: "tiangong-kb-patent-search",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "tiangong-kb-patent-search",
    expectedTreeSha256: "3dfabe32d50709f728595e7f482da4f42a7f149cc7cfb239e9ae98de93bcbcd6",
    tier: "enhanced",
    role: "evidence-capability",
    purpose:
      "Owner-authorized Tiangong patent database discovery through a bounded JSON POST broker.",
    recommendedFor: ["patent-landscapes", "prior-art", "owner-whitelisted-database"],
    defaultSelected: false,
    credentialIds: ["tiangong.patent.api-key"],
    settingIds: ["tiangong.patent.endpoint", "tiangong.patent.region"],
    dependencies: [],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: "tiangong-patent",
    standaloneTestedCliVersion: "0.0.30",
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.document-granular-decompose",
    skillName: "document-granular-decompose",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "document-granular-decompose",
    expectedTreeSha256: "e7ef2d0fe57582d3d0ce7e847a2165498f91aa13ba35a260f494fc2407d7d07e",
    tier: "enhanced",
    role: "input-preprocessor",
    purpose: "Hash-bound local-document preprocessing before immutable input admission.",
    recommendedFor: ["pdf", "office-documents", "scanned-documents"],
    defaultSelected: false,
    credentialIds: ["tiangong.unstructure.auth-token"],
    settingIds: [
      "tiangong.unstructure.base-url",
      "tiangong.unstructure.provider",
      "tiangong.unstructure.model",
    ],
    dependencies: [PYTHON_310],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "tiangong.academic-paper-download",
    skillName: "academic-paper-download",
    sourceId: "tiangong-ai-skills",
    sourceRelativePath: "academic-paper-download",
    expectedTreeSha256: "a1f70d4cd2f3b35c21183727ae00352bf0538f8e046dfac3c7e5493b6f3e3934",
    tier: "enhanced",
    role: "acquisition-adapter",
    purpose:
      "Deterministic OA paper acquisition with verified PDF provenance; browser handoff remains explicit and user-authorized.",
    recommendedFor: ["academic-research", "full-text-papers"],
    defaultSelected: false,
    credentialIds: ["semantic-scholar.api-key"],
    settingIds: ["unpaywall.contact-email"],
    dependencies: [PYTHON_310, PYPDF_LOCK],
    license: MIT_TIANGONG,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
  {
    id: "anthropic.doc-coauthoring",
    skillName: "doc-coauthoring",
    sourceId: "anthropic-skills",
    sourceRelativePath: "skills/doc-coauthoring",
    expectedTreeSha256: "ac77dcfcbc3363ea52f96fdb9874aa651a06406ac2496b9e7cc93c1e543b8cb6",
    tier: "authoring",
    role: "post-closure-authoring",
    purpose: "Optional structured co-authoring after research closure.",
    recommendedFor: ["reports", "proposals", "specifications"],
    defaultSelected: false,
    credentialIds: [],
    settingIds: [],
    dependencies: [],
    license: ANTHROPIC_EXAMPLE,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
  ...[
    ["docx", "9745194bf60109d70ba9b5c210bf2df478d16d64c8dc579ca61d48e2e7a21e32"],
    ["pdf", "139486d122819a3d793d391d4795c7faecac286890d27f7e482b77552ac9bbf0"],
    ["pptx", "f0c2c7526a7db041998e097a6c0e2282c84cd7eac7f8cdf7e5acceef1a577614"],
    ["xlsx", "3330257ae8119b25d8f95517ecb2643782533df60dafec5dbc899a0db0117bbb"],
  ].map(([skillName, expectedTreeSha256]) => ({
    id: `anthropic.${skillName}`,
    skillName: skillName!,
    sourceId: "anthropic-skills",
    sourceRelativePath: `skills/${skillName}`,
    expectedTreeSha256: expectedTreeSha256!,
    tier: "authoring" as const,
    role: "post-closure-authoring" as const,
    purpose:
      skillName === "pptx"
        ? "Situational PPTX reading, editing, or alternative authoring after mechanical research closure."
        : `Optional ${skillName} artifact work after mechanical research closure.`,
    recommendedFor:
      skillName === "pptx"
        ? ["pptx-reading", "pptx-editing", "situational-presentation-authoring"]
        : [`${skillName}-artifacts`],
    defaultSelected: false,
    credentialIds: [],
    settingIds: [],
    dependencies:
      skillName === "docx"
        ? [
            PYTHON_310,
            AUTHORING_DEFUSEDXML,
            AUTHORING_LXML,
            AUTHORING_NODE_DOCX,
            AUTHORING_PANDOC,
            AUTHORING_LIBREOFFICE,
            AUTHORING_POPPLER,
            AUTHORING_ZIP,
            AUTHORING_UNZIP,
          ]
        : skillName === "pdf"
          ? [
              PYTHON_310,
              AUTHORING_PYPDF,
              AUTHORING_PDFPLUMBER,
              AUTHORING_REPORTLAB,
              AUTHORING_PILLOW,
              AUTHORING_PDF2IMAGE,
              AUTHORING_PANDAS,
              AUTHORING_POPPLER,
            ]
          : skillName === "pptx"
            ? [
                PYTHON_310,
                AUTHORING_DEFUSEDXML,
                AUTHORING_LXML,
                AUTHORING_PILLOW,
                AUTHORING_PYTHON_PPTX,
                AUTHORING_MARKITDOWN,
                AUTHORING_NODE_PPTXGENJS,
                AUTHORING_LIBREOFFICE,
                AUTHORING_POPPLER,
                AUTHORING_ZIP,
                AUTHORING_UNZIP,
              ]
            : [
                PYTHON_310,
                AUTHORING_OPENPYXL,
                AUTHORING_PANDAS,
                AUTHORING_MARKITDOWN,
                AUTHORING_LIBREOFFICE,
              ],
    license: ANTHROPIC_DOCUMENT_TERMS,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false as const,
    userInitiatedOnly: true as const,
  })),
  {
    id: "hugohe3.ppt-master",
    skillName: "ppt-master",
    sourceId: "ppt-master",
    sourceRelativePath: "skills/ppt-master",
    expectedTreeSha256: "229514a9ae52ff958ba80307a071c3235c72aa137fb8f9dedda61d103b8e3902",
    tier: "authoring",
    role: "post-closure-authoring",
    purpose: "Preferred for creating PPT presentations after research closure.",
    recommendedFor: ["ppt-creation", "presentation-artifacts"],
    defaultSelected: false,
    credentialIds: [],
    settingIds: [],
    dependencies: [PYTHON_310, PPT_MASTER_LOCK_REQUIRED],
    license: MIT_PPT_MASTER,
    conflictGroup: null,
    capabilityKind: null,
    bundled: false,
    userInitiatedOnly: true,
  },
] as const;

export const RESEARCH_SETUP_CREDENTIALS: readonly ResearchSetupCredential[] = [
  {
    id: "brave.search.api-key",
    provider: "Brave Search API",
    requiredBy: RESEARCH_SETUP_SKILLS.filter(
      (skill) => skill.sourceId === "brave-search-skills",
    ).map((skill) => skill.id),
    required: true,
    defaultEnvironmentName: "BRAVE_API_KEY",
    storage: "broker",
    adapterEnvironmentName: null,
    obtainAt: "https://api.search.brave.com/app/keys",
    minimumUtf8Bytes: 8,
    liveCheck: "capability",
  },
  {
    id: "tiangong.sci.api-key",
    provider: "Tiangong SCI Search",
    requiredBy: ["tiangong.kb-sci-search"],
    required: true,
    defaultEnvironmentName: "TIANGONG_SCI_APIKEY",
    storage: "broker",
    adapterEnvironmentName: null,
    obtainAt: "Ask the owner of the selected Tiangong SCI deployment.",
    minimumUtf8Bytes: 8,
    liveCheck: "capability",
  },
  {
    id: "tiangong.report.api-key",
    provider: "Tiangong Report Search",
    requiredBy: ["tiangong.kb-report-search"],
    required: true,
    defaultEnvironmentName: "TIANGONG_REPORT_APIKEY",
    storage: "broker",
    adapterEnvironmentName: null,
    obtainAt: "Ask the owner of the selected Tiangong report deployment.",
    minimumUtf8Bytes: 8,
    liveCheck: "capability",
  },
  {
    id: "tiangong.patent.api-key",
    provider: "Tiangong Patent Search",
    requiredBy: ["tiangong.kb-patent-search"],
    required: true,
    defaultEnvironmentName: "TIANGONG_PATENT_APIKEY",
    storage: "broker",
    adapterEnvironmentName: null,
    obtainAt: "Ask the owner of the selected Tiangong patent deployment.",
    minimumUtf8Bytes: 8,
    liveCheck: "capability",
  },
  {
    id: "tiangong.unstructure.auth-token",
    provider: "Tiangong Unstructure",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: true,
    defaultEnvironmentName: "UNSTRUCTURED_AUTH_TOKEN",
    storage: "adapter",
    adapterEnvironmentName: "UNSTRUCTURED_AUTH_TOKEN",
    obtainAt: "Ask the owner of the selected Unstructure deployment.",
    minimumUtf8Bytes: 8,
    liveCheck: "unstructure",
  },
  {
    id: "semantic-scholar.api-key",
    provider: "Semantic Scholar Academic Graph API",
    requiredBy: ["tiangong.academic-paper-download"],
    required: false,
    defaultEnvironmentName: "SEMANTIC_SCHOLAR_API_KEY",
    storage: "adapter",
    adapterEnvironmentName: "SEMANTIC_SCHOLAR_API_KEY",
    obtainAt: "https://www.semanticscholar.org/product/api",
    minimumUtf8Bytes: 8,
    liveCheck: "semantic-scholar",
  },
] as const;

export const RESEARCH_SETUP_SETTINGS: readonly ResearchSetupSetting[] = [
  {
    id: "tiangong.sci.endpoint",
    label: "Tiangong SCI exact endpoint",
    requiredBy: ["tiangong.kb-sci-search"],
    required: true,
    secret: false,
    defaultValue: "https://qyyqlnwqwgvzxnccnbgm.supabase.co/functions/v1/sci_search",
    validation: "https-url",
  },
  {
    id: "tiangong.sci.region",
    label: "Tiangong SCI region header",
    requiredBy: ["tiangong.kb-sci-search"],
    required: false,
    secret: false,
    defaultValue: "us-east-1",
    validation: "identifier",
  },
  {
    id: "tiangong.report.endpoint",
    label: "Tiangong report exact endpoint",
    requiredBy: ["tiangong.kb-report-search"],
    required: true,
    secret: false,
    defaultValue: "https://qyyqlnwqwgvzxnccnbgm.supabase.co/functions/v1/report_search",
    validation: "https-url",
  },
  {
    id: "tiangong.report.region",
    label: "Tiangong report region header",
    requiredBy: ["tiangong.kb-report-search"],
    required: false,
    secret: false,
    defaultValue: "us-east-1",
    validation: "identifier",
  },
  {
    id: "tiangong.patent.endpoint",
    label: "Tiangong patent exact endpoint",
    requiredBy: ["tiangong.kb-patent-search"],
    required: true,
    secret: false,
    defaultValue: "https://qyyqlnwqwgvzxnccnbgm.supabase.co/functions/v1/patent_search",
    validation: "https-url",
  },
  {
    id: "tiangong.patent.region",
    label: "Tiangong patent region header",
    requiredBy: ["tiangong.kb-patent-search"],
    required: false,
    secret: false,
    defaultValue: "us-east-1",
    validation: "identifier",
  },
  {
    id: "tiangong.unstructure.base-url",
    label: "Tiangong Unstructure HTTPS base URL",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: true,
    secret: false,
    defaultValue: null,
    validation: "https-url",
  },
  {
    id: "tiangong.unstructure.provider",
    label: "Optional Unstructure provider",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: false,
    secret: false,
    defaultValue: null,
    validation: "identifier",
  },
  {
    id: "tiangong.unstructure.model",
    label: "Optional Unstructure model",
    requiredBy: ["tiangong.document-granular-decompose"],
    required: false,
    secret: false,
    defaultValue: null,
    validation: "identifier",
  },
  {
    id: "unpaywall.contact-email",
    label: "Unpaywall contact email",
    requiredBy: ["tiangong.academic-paper-download"],
    required: false,
    secret: false,
    defaultValue: null,
    validation: "email",
  },
] as const;

export function setupSource(sourceId: string): ResearchSetupSource {
  const source = RESEARCH_SETUP_SOURCES.find((candidate) => candidate.id === sourceId);
  if (!source) throw setupCatalogError(`Unknown setup source: ${sourceId}`);
  return source;
}

export function setupSkill(skillIdOrName: string): ResearchSetupSkill {
  const skill = RESEARCH_SETUP_SKILLS.find(
    (candidate) => candidate.id === skillIdOrName || candidate.skillName === skillIdOrName,
  );
  if (!skill) throw setupCatalogError(`Unknown recommended Skill: ${skillIdOrName}`);
  return skill;
}

export function resolveSetupSkills(values: readonly string[]): ResearchSetupSkill[] {
  const resolved = values.map(setupSkill);
  const ids = resolved.map((skill) => skill.id);
  if (new Set(ids).size !== ids.length) throw setupCatalogError("Selected Skills are duplicated.");
  return resolved.sort((left, right) => left.id.localeCompare(right.id));
}

export function setupTargetRoot(input: {
  workspace: string;
  scope: ResearchSetupScope;
  agent: ResearchSetupAgent;
  environment?: NodeJS.ProcessEnv;
}): string {
  if (input.scope === "project") {
    return input.agent === "codex"
      ? join(resolve(input.workspace), ".agents", "skills")
      : join(resolve(input.workspace), ".claude", "skills");
  }
  if (input.agent === "codex") {
    const configuredHome = input.environment?.HOME?.trim();
    const home = configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : homedir();
    return join(home, ".agents", "skills");
  }
  const configured = input.environment?.CLAUDE_CONFIG_DIR?.trim();
  return join(
    configured && isAbsolute(configured) ? resolve(configured) : join(homedir(), ".claude"),
    "skills",
  );
}

export async function inspectResearchSetupCatalog(input: {
  selectedPath: string;
  scope?: ResearchSetupScope;
  agents?: ResearchSetupAgent[];
  environment?: NodeJS.ProcessEnv;
}) {
  const workspace = resolve(input.selectedPath);
  const scope = input.scope ?? "project";
  const agents = input.agents?.length ? [...new Set(input.agents)] : ["codex" as const];
  const entries = [];
  for (const skill of RESEARCH_SETUP_SKILLS) {
    const installations = [];
    for (const agent of agents) {
      const root = setupTargetRoot({
        workspace,
        scope,
        agent,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      });
      const path = join(root, skill.skillName);
      installations.push({ agent, root, path, ...(await inspectInstalledSkill(path, skill)) });
    }
    entries.push({ ...skill, source: setupSource(skill.sourceId), installations });
  }
  return {
    schemaVersion: 1 as const,
    catalog: "tiangong-research-setup-ecosystem",
    policy: {
      bundledSkills: false,
      userInitiatedOnly: true,
      runtimeInstall: false,
      defaultScope: "project",
      defaultInstallMode: "copy",
      floatingUpdates: false,
      automaticSystemPackageInstall: false,
      automaticPythonPackageInstall: false,
    },
    installer: RESEARCH_SETUP_INSTALLER,
    workspace,
    scope,
    agents,
    sources: RESEARCH_SETUP_SOURCES,
    entries,
    credentials: RESEARCH_SETUP_CREDENTIALS,
    settings: RESEARCH_SETUP_SETTINGS,
    conflictGroups: [],
    selectionGuidance: RESEARCH_SETUP_SELECTION_GUIDANCE,
    roles: {
      orchestrators: RESEARCH_SETUP_SKILLS.filter((skill) => skill.role === "orchestrator").map(
        (skill) => skill.id,
      ),
      evidenceCapabilities: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "evidence-capability",
      ).map((skill) => skill.id),
      inputPreprocessors: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "input-preprocessor",
      ).map((skill) => skill.id),
      acquisitionAdapters: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "acquisition-adapter",
      ).map((skill) => skill.id),
      postClosureAuthoring: RESEARCH_SETUP_SKILLS.filter(
        (skill) => skill.role === "post-closure-authoring",
      ).map((skill) => skill.id),
    },
  };
}

export async function verifyResearchSetupRuntimeContract(
  skillPath: string,
  skill: ResearchSetupSkill,
): Promise<{
  status: "not-applicable" | "verified";
  mode: "workspace-lock" | null;
  resolverRelativePath: string | null;
  scannedInstructionFiles: string[];
}> {
  if (!skill.runtimeContract) {
    return {
      status: "not-applicable",
      mode: null,
      resolverRelativePath: null,
      scannedInstructionFiles: [],
    };
  }
  const root = resolve(skillPath);
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw runtimeContractError(skill.id, "Skill root is not a regular non-symlink directory.");
  }
  const resolver = resolve(root, skill.runtimeContract.resolverRelativePath);
  if (!resolver.startsWith(`${root}${sep}`)) {
    throw runtimeContractError(skill.id, "Runtime resolver escapes the pinned Skill tree.");
  }
  const resolverInfo = await lstat(resolver).catch(() => undefined);
  if (!resolverInfo?.isFile() || resolverInfo.isSymbolicLink()) {
    throw runtimeContractError(
      skill.id,
      "Workspace runtime resolver is missing or is not a regular non-symlink file.",
    );
  }
  const instructionFiles = [join(root, "SKILL.md")];
  const references = join(root, "references");
  const referenceInfo = await lstat(references).catch(() => undefined);
  if (referenceInfo?.isDirectory() && !referenceInfo.isSymbolicLink()) {
    instructionFiles.push(...(await markdownFiles(references, skill.id)));
  }
  const exactVersionPattern = /@tiangong-ai\/cli@(\d+\.\d+\.\d+)(?![-+0-9A-Za-z.])/g;
  const offending = new Map<string, Set<string>>();
  for (const file of instructionFiles.sort()) {
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) {
      throw runtimeContractError(
        skill.id,
        "Runtime instruction file is missing, linked, or exceeds the review size limit.",
      );
    }
    const contents = await readFile(file, "utf8");
    for (const match of contents.matchAll(exactVersionPattern)) {
      const instructionPath = portableRelativePath(root, file);
      const versions = offending.get(instructionPath) ?? new Set<string>();
      versions.add(match[1]!);
      offending.set(instructionPath, versions);
    }
  }
  if (skill.runtimeContract.exactCliVersionLiterals === "forbidden" && offending.size) {
    throw runtimeContractError(
      skill.id,
      "Workspace instructions contain an exact CLI version instead of the locked resolver.",
      {
        offendingFiles: [...offending.keys()].sort(),
        observedVersions: [
          ...new Set([...offending.values()].flatMap((value) => [...value])),
        ].sort(),
      },
    );
  }
  return {
    status: "verified",
    mode: skill.runtimeContract.mode,
    resolverRelativePath: skill.runtimeContract.resolverRelativePath,
    scannedInstructionFiles: instructionFiles
      .map((file) => portableRelativePath(root, file))
      .sort(),
  };
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function markdownFiles(root: string, skillId: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw runtimeContractError(
        skillId,
        "Runtime instruction references may not contain symbolic links.",
      );
    }
    if (entry.isDirectory()) files.push(...(await markdownFiles(path, skillId)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function runtimeContractError(
  skillId: string,
  reason: string,
  extra: Record<string, unknown> = {},
): CliError {
  return new CliError(reason, {
    code: "RESEARCH_SETUP_RUNTIME_CONTRACT_INVALID",
    exitCode: 3,
    details: {
      skillId,
      executionMode: "workspace-locked",
      credentialScope: "broker",
      networkAttempted: false,
      minimumAction:
        "Use a CLI release whose immutable Catalog tree passes the workspace-lock runtime contract; do not edit or bypass the installed Skill.",
      ...extra,
    },
  });
}

async function inspectInstalledSkill(
  path: string,
  skill: ResearchSetupSkill,
): Promise<{
  status: "missing" | "installed" | "drifted" | "blocked";
  observedTreeSha256: string | null;
  detail: string;
}> {
  if (!(await pathExists(path))) {
    return { status: "missing", observedTreeSha256: null, detail: "Skill is not installed." };
  }
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return {
        status: "blocked",
        observedTreeSha256: null,
        detail: "Install destination must be a regular non-symlink directory.",
      };
    }
    const observedTreeSha256 = await hashRegularTree(path);
    return observedTreeSha256 === skill.expectedTreeSha256
      ? {
          status: "installed",
          observedTreeSha256,
          detail: "Installed bytes match the reviewed tree hash.",
        }
      : {
          status: "drifted",
          observedTreeSha256,
          detail: "Installed bytes do not match the reviewed tree hash.",
        };
  } catch (error) {
    return {
      status: "blocked",
      observedTreeSha256: null,
      detail: sanitizeResearchText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function setupCatalogError(message: string): CliError {
  return new CliError(message, {
    code: "RESEARCH_SETUP_SELECTION_INVALID",
    exitCode: 2,
    details: {
      step: "selection",
      reason: message,
      minimumAction: "Choose IDs reported by research setup catalog.",
      retryCommand: "tiangong-ai research setup catalog --json",
    },
  });
}
