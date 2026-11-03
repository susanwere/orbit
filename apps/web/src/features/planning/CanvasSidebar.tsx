import { type PlanSectionKey } from "./PlanSection.js";
import { AccountMenuHost } from "../auth/AccountMenuHost.js";

interface CanvasSidebarProps {
  readonly projectName: string;
  readonly selectedItemKey: string | null;
  readonly approved: boolean;
  readonly hasPlan: boolean;
  readonly canCompose: boolean;
  readonly isComposerOpen: boolean;
  readonly activeSection: PlanSectionKey | null;
  readonly isContextOpen: boolean;
  readonly isExecutionOpen: boolean;
  readonly onOpenExecution: () => void;
  readonly onOpenContext: () => void;
  readonly onOpenSection: (section: PlanSectionKey) => void;
  readonly onOpenComposer: () => void;
  readonly onBack: () => void;
  readonly onOverview: () => void;
}

/** Canvas navigation only. Execution remains available through the existing Intent page. */
export function CanvasSidebar({
  projectName,
  selectedItemKey,
  approved,
  hasPlan,
  canCompose,
  isComposerOpen,
  activeSection,
  isContextOpen,
  isExecutionOpen,
  onOpenExecution,
  onOpenContext,
  onOpenSection,
  onOpenComposer,
  onBack,
  onOverview,
}: CanvasSidebarProps) {
  return (
    <aside className="orbit-workspace-nav canvas-sidebar" aria-label="Project navigation">
      <a className="canvas-sidebar-brand" href="#plan-heading" aria-label="Orbit workspace">
        <span className="project-dashboard-brand-mark" aria-hidden="true" />
        Orbit
      </a>
      <button type="button" className="canvas-sidebar-back" onClick={onBack}>
        ← Projects
      </button>
      <div className="canvas-sidebar-project">
        <span>PROJECT</span>
        <strong>
          <SidebarIcon kind="project" />
          {projectName}
        </strong>
      </div>
      <nav aria-label="Canvas sections">
        {canCompose && (
          <button
            type="button"
            aria-current={isComposerOpen ? "page" : undefined}
            onClick={onOpenComposer}
          >
            <SidebarIcon kind="composer" />
            Composer
          </button>
        )}
        <button
          type="button"
          aria-current={isContextOpen ? "page" : undefined}
          onClick={onOpenContext}
        >
          <SidebarIcon kind="plan" />
          Project Context
        </button>
        <button
          type="button"
          aria-current={activeSection ? "page" : undefined}
          onClick={() => onOpenSection(activeSection ?? "original-intent")}
        >
          <SidebarIcon kind="plan" />
          Plan details
        </button>
        <button
          type="button"
          className="canvas-sidebar-workflow"
          aria-current={
            !selectedItemKey &&
            !isComposerOpen &&
            !activeSection &&
            !isContextOpen &&
            !isExecutionOpen
              ? "page"
              : undefined
          }
          onClick={onOverview}
        >
          <SidebarIcon kind="workflow" />
          Workflow
        </button>
      </nav>
      <AccountMenuHost />
    </aside>
  );
}

function SidebarIcon({
  kind,
}: {
  readonly kind:
    | "project"
    | "plan"
    | "workflow"
    | "items"
    | "approvals"
    | "execution"
    | "repository"
    | "composer";
}) {
  const paths = {
    plan: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 12h8M8 16h8",
    composer: "m15 4 5 5M4 20l4-1L21 6a2 2 0 0 0-5-5L3 14l-1 7 7-1",
    project: "m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10 9-5M12 12 3 7m9 5v10",
    workflow:
      "M12 5v5m0 0L5 19m7-9 7 9M9 3a3 3 0 1 0 6 0 3 3 0 1 0-6 0M2 20a3 3 0 1 0 6 0 3 3 0 1 0-6 0m14 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
    items: "m3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5",
    approvals: "m7 12 3 3 7-7M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    execution: "m6 3 15 9-15 9V3Z",
    repository:
      "M9 19c-4 1-4-2-6-3m12 6v-4a3 3 0 0 0-1-2c3 0 6-1 6-6a5 5 0 0 0-1-3 4 4 0 0 0 0-3s-1 0-3 1a12 12 0 0 0-7 0C7 4 6 4 6 4a4 4 0 0 0 0 3 5 5 0 0 0-1 3c0 5 3 6 6 6a3 3 0 0 0-1 2v4",
  };
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
