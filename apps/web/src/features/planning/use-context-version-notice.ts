import { useCallback, useEffect, useState } from "react";
import type { ProjectIntentApi } from "../intent/intent-api.js";

export interface ContextVersionNotice {
  readonly projectId: string;
  readonly latestRevision: number;
  readonly viewedRevision: number;
}

export function updateContextVersionNotice(
  current: ContextVersionNotice,
  projectId: string,
  revision: number,
  viewed = false,
): ContextVersionNotice {
  const previous =
    current.projectId === projectId ? current : { projectId, latestRevision: 0, viewedRevision: 0 };
  return {
    projectId,
    latestRevision: Math.max(previous.latestRevision, revision),
    viewedRevision: viewed ? Math.max(previous.viewedRevision, revision) : previous.viewedRevision,
  };
}

/** Session-local notice; acknowledge only versions actually displayed, never merely fetched. */
export function useContextVersionNotice(api: ProjectIntentApi, projectId: string) {
  const [notice, setNotice] = useState<ContextVersionNotice>({
    projectId,
    latestRevision: 0,
    viewedRevision: 0,
  });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.visibilityState !== "hidden") {
          const snapshots = await api.getProjectKnowledge(projectId);
          if (active)
            setNotice((current) =>
              updateContextVersionNotice(
                current,
                projectId,
                Math.max(0, ...snapshots.map((snapshot) => snapshot.revision)),
              ),
            );
        }
      } catch {
        // Preserve the last known notice; a failed background read is not an acknowledgement.
      } finally {
        if (active)
          timer = setTimeout(() => {
            void poll();
          }, 15000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, projectId]);
  const markViewed = useCallback(
    (revision: number) => {
      setNotice((current) => updateContextVersionNotice(current, projectId, revision, true));
    },
    [projectId],
  );
  return {
    latestRevision: notice.projectId === projectId ? notice.latestRevision : 0,
    hasNewVersion: notice.projectId === projectId && notice.latestRevision > notice.viewedRevision,
    markViewed,
  };
}
